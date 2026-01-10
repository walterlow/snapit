//! GPU-accelerated webcam preview using wgpu.
//!
//! Renders camera frames directly to the Tauri window surface,
//! bypassing JPEG encoding and IPC polling for smooth 30fps preview.
//!
//! Architecture (from Cap):
//! - wgpu surface attached to Tauri window
//! - Camera frames uploaded as GPU textures
//! - WGSL shader handles shape masking and mirroring
//! - Render loop runs in dedicated thread

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tauri::{LogicalSize, WebviewWindow};
use tokio::sync::broadcast;
use wgpu::CompositeAlphaMode;

use super::feed::{start_global_feed, stop_global_feed, subscribe_global, Subscription};
use super::NativeCameraFrame;
use crate::commands::video_recording::webcam::{WebcamShape, WebcamSize};

/// Preview window size constants
pub const MIN_PREVIEW_SIZE: f32 = 120.0;
pub const MAX_PREVIEW_SIZE: f32 = 250.0;
pub const DEFAULT_PREVIEW_SIZE: f32 = 160.0;

/// GPU surface scale for anti-aliasing (higher = smoother edges)
/// Note: Must be 1 on Windows/Vulkan as surface size must match window size.
/// Shader-based AA via fwidth() handles edge smoothing.
const GPU_SURFACE_SCALE: u32 = 1;

/// State for GPU preview configuration
#[derive(Debug, Clone)]
pub struct GpuPreviewState {
    pub size: f32,
    pub shape: WebcamShape,
    pub mirrored: bool,
}

impl Default for GpuPreviewState {
    fn default() -> Self {
        Self {
            size: DEFAULT_PREVIEW_SIZE,
            shape: WebcamShape::Circle,
            mirrored: false,
        }
    }
}

impl GpuPreviewState {
    pub fn from_settings(size: WebcamSize, shape: WebcamShape, mirror: bool) -> Self {
        let size_px = match size {
            WebcamSize::Small => 120.0,
            WebcamSize::Medium => 160.0,
            WebcamSize::Large => 200.0,
        };
        Self {
            size: size_px,
            shape,
            mirrored: mirror,
        }
    }
}

/// Events to reconfigure the preview
#[derive(Clone, Debug)]
pub enum ReconfigureEvent {
    State(GpuPreviewState),
    WindowResized { width: u32, height: u32 },
    Shutdown,
}

/// GPU Preview Manager - handles lifecycle of GPU-rendered webcam preview
pub struct GpuPreviewManager {
    state: RwLock<GpuPreviewState>,
    preview: Mutex<Option<ActivePreview>>,
}

struct ActivePreview {
    reconfigure_tx: broadcast::Sender<ReconfigureEvent>,
    thread: Option<JoinHandle<()>>,
    stop_signal: Arc<AtomicBool>,
}

impl GpuPreviewManager {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(GpuPreviewState::default()),
            preview: Mutex::new(None),
        }
    }

    /// Get current preview state
    pub fn get_state(&self) -> GpuPreviewState {
        self.state.read().clone()
    }

    /// Update preview state
    pub fn set_state(&self, state: GpuPreviewState) {
        *self.state.write() = state.clone();

        // Notify active preview if running
        if let Some(ref preview) = *self.preview.lock() {
            let _ = preview.reconfigure_tx.send(ReconfigureEvent::State(state));
        }
    }

    /// Check if preview is active
    pub fn is_active(&self) -> bool {
        self.preview.lock().is_some()
    }

    /// Notify of window resize
    pub fn notify_resize(&self, width: u32, height: u32) {
        if let Some(ref preview) = *self.preview.lock() {
            let _ = preview
                .reconfigure_tx
                .send(ReconfigureEvent::WindowResized { width, height });
        }
    }

    /// Start GPU preview for window
    pub fn start(&self, window: WebviewWindow, device_index: usize) -> Result<(), String> {
        let mut guard = self.preview.lock();

        if guard.is_some() {
            log::info!("[GPU_PREVIEW] Already running");
            return Ok(());
        }

        // Start camera feed
        start_global_feed(device_index)?;

        // Subscribe to camera frames
        let subscription = subscribe_global("gpu-preview", 4)?;

        let state = self.get_state();
        let (reconfigure_tx, reconfigure_rx) = broadcast::channel(4);
        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_signal_clone = Arc::clone(&stop_signal);

        // Spawn render thread
        let thread = std::thread::Builder::new()
            .name("gpu-preview".to_string())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("Failed to create tokio runtime");

                rt.block_on(async {
                    if let Err(e) = run_gpu_preview(
                        window,
                        state,
                        subscription,
                        reconfigure_rx,
                        stop_signal_clone,
                    )
                    .await
                    {
                        log::error!("[GPU_PREVIEW] Error: {}", e);
                    }
                });
            })
            .map_err(|e| format!("Failed to spawn GPU preview thread: {}", e))?;

        *guard = Some(ActivePreview {
            reconfigure_tx,
            thread: Some(thread),
            stop_signal,
        });

        log::info!("[GPU_PREVIEW] Started");
        Ok(())
    }

    /// Stop GPU preview
    pub fn stop(&self) {
        let mut guard = self.preview.lock();
        if let Some(mut preview) = guard.take() {
            // Signal shutdown
            let _ = preview.reconfigure_tx.send(ReconfigureEvent::Shutdown);
            preview.stop_signal.store(true, Ordering::SeqCst);

            // Wait for thread
            if let Some(thread) = preview.thread.take() {
                let _ = thread.join();
            }

            log::info!("[GPU_PREVIEW] Stopped");
        }

        // Stop camera feed
        stop_global_feed();
    }
}

impl Drop for GpuPreviewManager {
    fn drop(&mut self) {
        self.stop();
    }
}

// Global manager instance
static GPU_PREVIEW_MANAGER: std::sync::OnceLock<GpuPreviewManager> = std::sync::OnceLock::new();

pub fn get_manager() -> &'static GpuPreviewManager {
    GPU_PREVIEW_MANAGER.get_or_init(GpuPreviewManager::new)
}

/// Start GPU-accelerated webcam preview
pub fn start_gpu_preview(window: WebviewWindow, device_index: usize) -> Result<(), String> {
    get_manager().start(window, device_index)
}

/// Stop GPU preview
pub fn stop_gpu_preview() {
    get_manager().stop();
}

/// Update preview settings
pub fn update_gpu_preview_state(state: GpuPreviewState) {
    get_manager().set_state(state);
}

/// Check if GPU preview is running
pub fn is_gpu_preview_running() -> bool {
    get_manager().is_active()
}

// ============================================================================
// Renderer Implementation
// ============================================================================

/// Run the GPU preview render loop
async fn run_gpu_preview(
    window: WebviewWindow,
    initial_state: GpuPreviewState,
    subscription: Subscription,
    mut reconfigure_rx: broadcast::Receiver<ReconfigureEvent>,
    stop_signal: Arc<AtomicBool>,
) -> Result<(), String> {
    // Initialize wgpu
    let mut renderer = init_wgpu(window.clone(), &initial_state).await?;

    let mut state = initial_state;
    let mut received_first_frame = false;
    let start_time = std::time::Instant::now();
    let startup_timeout = Duration::from_secs(5);

    loop {
        if stop_signal.load(Ordering::Relaxed) {
            break;
        }

        let timeout_remaining = if received_first_frame {
            Duration::from_millis(100) // Normal timeout
        } else {
            startup_timeout.saturating_sub(start_time.elapsed())
        };

        if timeout_remaining.is_zero() && !received_first_frame {
            log::warn!("[GPU_PREVIEW] Timed out waiting for first frame");
            break;
        }

        // Check for reconfigure events (non-blocking)
        match reconfigure_rx.try_recv() {
            Ok(ReconfigureEvent::Shutdown) => break,
            Ok(ReconfigureEvent::State(new_state)) => {
                state = new_state;
                renderer.update_state_uniforms(&state);
                if let Ok((w, h)) = resize_window(&window, &state, renderer.aspect_ratio) {
                    renderer.reconfigure_surface(w, h);
                }
            },
            Ok(ReconfigureEvent::WindowResized { width, height }) => {
                renderer.reconfigure_surface(width, height);
            },
            Err(_) => {}, // No event, continue
        }

        // Try to get a frame
        match subscription.recv_timeout(timeout_remaining) {
            Some(frame) => {
                if !received_first_frame {
                    log::info!(
                        "[GPU_PREVIEW] Received first frame: {}x{}",
                        frame.width,
                        frame.height
                    );
                }
                received_first_frame = true;

                // Update aspect ratio if changed
                let aspect = frame.width as f32 / frame.height as f32;
                if (aspect - renderer.aspect_ratio).abs() > 0.01 {
                    log::info!("[GPU_PREVIEW] Updating aspect ratio: {}", aspect);
                    renderer.aspect_ratio = aspect;
                    renderer.update_camera_uniforms(aspect);
                    if let Ok((w, h)) = resize_window(&window, &state, aspect) {
                        log::info!("[GPU_PREVIEW] Reconfiguring surface: {}x{}", w, h);
                        renderer.reconfigure_surface(w, h);
                    }
                }

                // Render frame
                log::trace!("[GPU_PREVIEW] Rendering frame");
                if let Err(e) = renderer.render_frame(&frame) {
                    log::warn!("[GPU_PREVIEW] Render error: {}", e);
                }
            },
            None => {
                // Timeout, loop again
            },
        }
    }

    log::info!("[GPU_PREVIEW] Render loop exiting");
    renderer.cleanup();
    Ok(())
}

/// Resize window based on state.
/// Returns physical dimensions for surface configuration.
fn resize_window(
    window: &WebviewWindow,
    state: &GpuPreviewState,
    _aspect: f32,
) -> Result<(u32, u32), String> {
    let logical_size = state.size.clamp(MIN_PREVIEW_SIZE, MAX_PREVIEW_SIZE);

    // Set window size (logical coordinates)
    window
        .set_size(LogicalSize::new(logical_size as f64, logical_size as f64))
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    // Return physical dimensions for surface configuration
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let physical_size = (logical_size * scale_factor as f32) as u32;

    Ok((physical_size, physical_size))
}

// ============================================================================
// wgpu Renderer
// ============================================================================

struct Renderer {
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    device: wgpu::Device,
    queue: wgpu::Queue,
    render_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    state_uniform_buffer: wgpu::Buffer,
    window_uniform_buffer: wgpu::Buffer,
    camera_uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    texture_cache: Option<CachedYuvTextures>,
    aspect_ratio: f32,
    current_yuv_format: YuvFormat,
    current_state: GpuPreviewState,
    /// Reusable RGBA buffer for MJPEG decoding only
    rgba_buffer: Vec<u8>,
}

/// Cached textures for GPU YUV conversion
struct CachedYuvTextures {
    /// Y plane texture (R8 for NV12) or packed YUYV/RGBA texture
    y_texture: wgpu::Texture,
    /// UV plane texture (RG8 for NV12) - None for YUYV/RGBA
    uv_texture: Option<wgpu::Texture>,
    bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
    format: YuvFormat,
}

/// YUV format for GPU shader
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum YuvFormat {
    Nv12 = 0,
    Yuyv422 = 1,
    Rgba = 2, // For MJPEG/RGB formats - pass through as-is
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct StateUniforms {
    shape: f32,
    size: f32,
    mirrored: f32,
    yuv_format: f32, // 0 = NV12, 1 = YUYV422, 2 = RGBA (pass-through)
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    tex_width: f32,  // Texture width for YUYV decoding
    tex_height: f32, // Texture height
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniforms {
    camera_aspect_ratio: f32,
    _padding: f32,
}

async fn init_wgpu(window: WebviewWindow, state: &GpuPreviewState) -> Result<Renderer, String> {
    let logical_size = state.size.clamp(MIN_PREVIEW_SIZE, MAX_PREVIEW_SIZE) as u32;

    // Get the scale factor to convert to physical pixels
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let physical_size = (logical_size as f64 * scale_factor) as u32;

    log::info!(
        "[GPU_PREVIEW] Initializing: logical={}x{}, scale={:.2}, physical={}x{}",
        logical_size,
        logical_size,
        scale_factor,
        physical_size,
        physical_size
    );

    // NOTE: SetWindowDisplayAffinity is called AFTER wgpu init to avoid interference

    // Create wgpu instance and surface on main thread (required for window handle)
    // Try Vulkan first with implicit layers disabled (Bandicam, OBS hooks cause crashes)
    // Fall back to DX12 if Vulkan fails
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread({
            let window = window.clone();
            move || {
                // Disable Vulkan implicit layers that cause crashes (Bandicam, OBS)
                // This env var tells the Vulkan loader to skip implicit layers
                std::env::set_var("VK_LOADER_LAYERS_DISABLE", "*");

                // Try Vulkan first (supports transparency)
                let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
                    backends: wgpu::Backends::VULKAN,
                    ..Default::default()
                });

                let surface = instance.create_surface(window.clone());
                let _ = tx.send((instance, surface));
            }
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;

    let (instance, surface) = rx.await.map_err(|_| "Failed to receive wgpu instance")?;
    let surface = surface.map_err(|e| format!("Failed to create surface: {}", e))?;

    // Get adapter
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::default(),
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
        })
        .await
        .map_err(|e| format!("Failed to find wgpu adapter: {}", e))?;

    // Create device and queue
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("webcam-preview"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(adapter.limits()),
            memory_hints: Default::default(),
            trace: wgpu::Trace::Off,
        })
        .await
        .map_err(|e| format!("Failed to create device: {}", e))?;

    // Load YUV shader for GPU-based color conversion
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("camera-yuv-shader"),
        source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
            "camera_yuv.wgsl"
        ))),
    });

    // Create bind group layouts
    let uniform_bind_group_layout =
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniform-bind-group-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

    // Texture bind group layout for YUV textures (Y plane, UV plane, sampler)
    let texture_bind_group_layout =
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("yuv-texture-bind-group-layout"),
            entries: &[
                // Y plane texture (R8 for NV12, RGBA8 for YUYV/RGB)
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // UV plane texture (RG8 for NV12, dummy for others)
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

    // Create uniform buffers
    let state_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("state-uniform-buffer"),
        size: std::mem::size_of::<StateUniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let window_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("window-uniform-buffer"),
        size: std::mem::size_of::<WindowUniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let camera_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("camera-uniform-buffer"),
        size: std::mem::size_of::<CameraUniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    // Create uniform bind group
    let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("uniform-bind-group"),
        layout: &uniform_bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: state_uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: window_uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: camera_uniform_buffer.as_entire_binding(),
            },
        ],
    });

    // Create render pipeline
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("camera-pipeline-layout"),
        bind_group_layouts: &[&texture_bind_group_layout, &uniform_bind_group_layout],
        push_constant_ranges: &[],
    });

    let swapchain_format = wgpu::TextureFormat::Bgra8Unorm;
    let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("camera-render-pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: swapchain_format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview: None,
        cache: None,
    });

    // Configure surface
    let surface_caps = surface.get_capabilities(&adapter);
    // Use first available alpha mode - prefer PreMultiplied for transparency, fall back to whatever is supported
    let alpha_mode = if surface_caps
        .alpha_modes
        .contains(&CompositeAlphaMode::PreMultiplied)
    {
        CompositeAlphaMode::PreMultiplied
    } else if surface_caps
        .alpha_modes
        .contains(&CompositeAlphaMode::PostMultiplied)
    {
        CompositeAlphaMode::PostMultiplied
    } else if surface_caps
        .alpha_modes
        .contains(&CompositeAlphaMode::Inherit)
    {
        CompositeAlphaMode::Inherit
    } else {
        // Use first available - Opaque won't give transparency but at least won't crash
        surface_caps
            .alpha_modes
            .first()
            .copied()
            .unwrap_or(CompositeAlphaMode::Opaque)
    };
    log::info!(
        "[GPU_PREVIEW] Using alpha mode: {:?}, supported: {:?}",
        alpha_mode,
        surface_caps.alpha_modes
    );

    let surface_config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format: swapchain_format,
        width: physical_size * GPU_SURFACE_SCALE,
        height: physical_size * GPU_SURFACE_SCALE,
        present_mode: wgpu::PresentMode::Fifo,
        alpha_mode,
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    };
    surface.configure(&device, &surface_config);

    // Create sampler
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    // Pre-allocate RGBA buffer for MJPEG decoding only (other formats use GPU conversion)
    let max_pixels = (PREVIEW_MAX_TEXTURE_SIZE * PREVIEW_MAX_TEXTURE_SIZE) as usize;
    let rgba_buffer = Vec::with_capacity(max_pixels * 4);

    let mut renderer = Renderer {
        surface,
        surface_config,
        device,
        queue,
        render_pipeline,
        sampler,
        bind_group_layout: texture_bind_group_layout,
        state_uniform_buffer,
        window_uniform_buffer,
        camera_uniform_buffer,
        uniform_bind_group,
        texture_cache: None,
        aspect_ratio: 1.0,
        current_yuv_format: YuvFormat::Nv12, // Default, will be updated on first frame
        current_state: state.clone(),
        rgba_buffer,
    };

    // Initialize uniforms
    renderer.update_state_uniforms(state);
    renderer.update_window_uniforms(physical_size, physical_size);
    renderer.update_camera_uniforms(1.0);

    log::info!(
        "[GPU_PREVIEW] wgpu initialized: {}x{} (physical)",
        physical_size,
        physical_size
    );

    // Exclude webcam preview from screen capture (called AFTER wgpu init to avoid interference)
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        };

        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let result = SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE);
                if result.is_ok() {
                    log::info!("[GPU_PREVIEW] Window excluded from screen capture");
                } else {
                    log::warn!("[GPU_PREVIEW] Failed to exclude window from screen capture");
                }
            }
        }
    }

    // Small delay to ensure window is fully ready for rendering
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    log::info!("[GPU_PREVIEW] Ready for rendering");

    Ok(renderer)
}

impl Renderer {
    fn update_state_uniforms(&mut self, state: &GpuPreviewState) {
        let normalized_size =
            (state.size - MIN_PREVIEW_SIZE) / (MAX_PREVIEW_SIZE - MIN_PREVIEW_SIZE);
        let uniforms = StateUniforms {
            shape: match state.shape {
                WebcamShape::Circle => 0.0,
                WebcamShape::Rectangle => 1.0,
            },
            size: normalized_size.clamp(0.0, 1.0),
            mirrored: if state.mirrored { 1.0 } else { 0.0 },
            yuv_format: self.current_yuv_format as u32 as f32,
        };
        self.queue.write_buffer(
            &self.state_uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniforms]),
        );
        self.current_state = state.clone();
    }

    fn update_window_uniforms(&self, width: u32, height: u32) {
        // Get texture dimensions if cached, otherwise use window size
        let (tex_width, tex_height) = self
            .texture_cache
            .as_ref()
            .map(|t| (t.width as f32, t.height as f32))
            .unwrap_or((width as f32, height as f32));

        let uniforms = WindowUniforms {
            window_width: (width * GPU_SURFACE_SCALE) as f32,
            window_height: (height * GPU_SURFACE_SCALE) as f32,
            tex_width,
            tex_height,
        };
        self.queue.write_buffer(
            &self.window_uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniforms]),
        );
    }

    fn update_camera_uniforms(&self, aspect_ratio: f32) {
        let uniforms = CameraUniforms {
            camera_aspect_ratio: aspect_ratio,
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.camera_uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniforms]),
        );
    }

    fn reconfigure_surface(&mut self, width: u32, height: u32) {
        self.surface_config.width = if width > 0 {
            width * GPU_SURFACE_SCALE
        } else {
            1
        };
        self.surface_config.height = if height > 0 {
            height * GPU_SURFACE_SCALE
        } else {
            1
        };
        self.surface.configure(&self.device, &self.surface_config);
        self.update_window_uniforms(width, height);
    }

    fn render_frame(&mut self, frame: &NativeCameraFrame) -> Result<(), String> {
        use snapit_camera_windows::PixelFormat;

        let width = frame.width;
        let height = frame.height;

        // Determine YUV format for this frame
        let yuv_format = match frame.pixel_format {
            PixelFormat::NV12 => YuvFormat::Nv12,
            PixelFormat::YUYV422 => YuvFormat::Yuyv422,
            PixelFormat::MJPEG | PixelFormat::RGB24 | PixelFormat::RGB32 | PixelFormat::ARGB => {
                YuvFormat::Rgba
            },
            _ => {
                return Err(format!(
                    "Unsupported pixel format: {:?}",
                    frame.pixel_format
                ))
            },
        };

        // Check if we need new textures (size or format changed)
        let needs_new_texture = self
            .texture_cache
            .as_ref()
            .map(|t| t.width != width || t.height != height || t.format != yuv_format)
            .unwrap_or(true);

        if needs_new_texture || yuv_format != self.current_yuv_format {
            log::info!(
                "[GPU_PREVIEW] Creating YUV textures: {}x{} format={:?}",
                width,
                height,
                yuv_format
            );
            self.texture_cache = Some(self.create_yuv_textures(width, height, yuv_format));
            self.current_yuv_format = yuv_format;
            // Update state uniforms with new format
            let state = self.current_state.clone();
            self.update_state_uniforms(&state);
            // Update window uniforms with texture dimensions
            let (sw, sh) = (self.surface_config.width, self.surface_config.height);
            self.update_window_uniforms(sw / GPU_SURFACE_SCALE, sh / GPU_SURFACE_SCALE);
        }

        let cached = self.texture_cache.as_ref().unwrap();

        // Upload frame data based on format
        match yuv_format {
            YuvFormat::Nv12 => {
                let bytes = frame.bytes();
                let y_size = (width * height) as usize;
                let uv_height = height / 2;

                // Upload Y plane (R8)
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &cached.y_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &bytes[..y_size],
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );

                // Upload UV plane (RG8, half height)
                if let Some(ref uv_tex) = cached.uv_texture {
                    self.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: uv_tex,
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        &bytes[y_size..],
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(width), // UV interleaved, same width as Y
                            rows_per_image: Some(uv_height),
                        },
                        wgpu::Extent3d {
                            width: width / 2,
                            height: uv_height,
                            depth_or_array_layers: 1,
                        },
                    );
                }
            },
            YuvFormat::Yuyv422 => {
                // YUYV422: packed as YUYV YUYV... (2 bytes per pixel)
                // Upload as RGBA8 texture for shader to decode
                let bytes = frame.bytes();
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &cached.y_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    bytes,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width * 2),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width: width / 2, // RGBA8 texture stores 2 pixels per texel
                        height,
                        depth_or_array_layers: 1,
                    },
                );
            },
            YuvFormat::Rgba => {
                // MJPEG/RGB: decode to RGBA on CPU, upload as RGBA8
                self.rgba_buffer.clear();
                frame_to_rgba_into(frame, &mut self.rgba_buffer)?;

                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &cached.y_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &self.rgba_buffer,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width * 4),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
            },
        }

        // Get surface texture
        let surface_texture = match self.surface.get_current_texture() {
            Ok(tex) => tex,
            Err(wgpu::SurfaceError::Outdated) => {
                log::info!("[GPU_PREVIEW] Surface outdated, reconfiguring");
                self.surface.configure(&self.device, &self.surface_config);
                self.surface
                    .get_current_texture()
                    .map_err(|e| format!("Failed to get surface texture after reconfig: {:?}", e))?
            },
            Err(e) => return Err(format!("Failed to get surface texture: {:?}", e)),
        };

        let surface_view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // Create command encoder and render pass
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("render-encoder"),
            });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("camera-render-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, &cached.bind_group, &[]);
            render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));
        surface_texture.present();

        Ok(())
    }

    fn create_yuv_textures(&self, width: u32, height: u32, format: YuvFormat) -> CachedYuvTextures {
        let (y_texture, uv_texture) = match format {
            YuvFormat::Nv12 => {
                // NV12: Y plane (R8) + UV plane (RG8, half resolution)
                let y_tex = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("nv12-y-texture"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });

                let uv_tex = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("nv12-uv-texture"),
                    size: wgpu::Extent3d {
                        width: width / 2,
                        height: height / 2,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rg8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });

                (y_tex, Some(uv_tex))
            },
            YuvFormat::Yuyv422 => {
                // YUYV422: packed as RGBA8 (Y0, U, Y1, V per texel = 2 pixels)
                let y_tex = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("yuyv-texture"),
                    size: wgpu::Extent3d {
                        width: width / 2,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
                (y_tex, None)
            },
            YuvFormat::Rgba => {
                // RGBA: direct RGBA8 texture
                let y_tex = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("rgba-texture"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
                (y_tex, None)
            },
        };

        let y_view = y_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create dummy UV texture view if we don't have one
        let uv_view = if let Some(ref uv_tex) = uv_texture {
            uv_tex.create_view(&wgpu::TextureViewDescriptor::default())
        } else {
            // Create a 1x1 dummy UV texture for non-NV12 formats
            let dummy_uv = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("dummy-uv-texture"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rg8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            dummy_uv.create_view(&wgpu::TextureViewDescriptor::default())
        };

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("yuv-texture-bind-group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&y_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&uv_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });

        CachedYuvTextures {
            y_texture,
            uv_texture,
            bind_group,
            width,
            height,
            format,
        }
    }

    fn cleanup(&mut self) {
        self.texture_cache = None;
        self.device.destroy();
    }
}

/// Convert MJPEG/RGB frame to RGBA (no scaling - GPU handles that).
/// Only used for non-YUV formats; YUV formats go directly to GPU.
fn frame_to_rgba_into(frame: &NativeCameraFrame, rgba: &mut Vec<u8>) -> Result<(), String> {
    use snapit_camera_windows::PixelFormat;

    let bytes = frame.bytes();
    let width = frame.width as usize;
    let height = frame.height as usize;
    let pixel_count = width * height;

    rgba.clear();
    rgba.reserve_exact(pixel_count * 4);

    match frame.pixel_format {
        PixelFormat::MJPEG => {
            // Decode JPEG to RGB, then add alpha
            let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Failed to decode MJPEG: {}", e))?;
            let rgb = img.to_rgb8();
            rgba.extend(rgb.pixels().flat_map(|p| [p[0], p[1], p[2], 255]));
        },
        PixelFormat::RGB24 => {
            let expected = width * height * 3;
            if bytes.len() < expected {
                return Err("RGB24 buffer too small".into());
            }
            rgba.extend(
                bytes
                    .chunks_exact(3)
                    .take(pixel_count)
                    .flat_map(|p| [p[0], p[1], p[2], 255]),
            );
        },
        PixelFormat::RGB32 | PixelFormat::ARGB => {
            // BGRA to RGBA
            let expected = width * height * 4;
            if bytes.len() < expected {
                return Err("RGB32 buffer too small".into());
            }
            rgba.extend(
                bytes
                    .chunks_exact(4)
                    .take(pixel_count)
                    .flat_map(|p| [p[2], p[1], p[0], p[3]]),
            );
        },
        _ => {
            return Err(format!(
                "frame_to_rgba_into: unsupported format {:?}",
                frame.pixel_format
            ))
        },
    }

    Ok(())
}

/// Maximum texture size for preview (now unused - GPU handles full resolution).
/// Kept for reference; previously used for CPU downscaling before GPU upload.
#[allow(dead_code)]
const PREVIEW_MAX_TEXTURE_SIZE: u32 = 1280;

/// Convert NativeCameraFrame to RGBA bytes with optional downscaling.
/// **DEPRECATED**: No longer used - YUV frames go directly to GPU for conversion.
/// Kept for potential future use or fallback scenarios.
#[allow(dead_code)]
fn frame_to_rgba_scaled_into(
    frame: &NativeCameraFrame,
    max_size: u32,
    rgba: &mut Vec<u8>,
) -> Result<(u32, u32), String> {
    use snapit_camera_windows::PixelFormat;

    let bytes = frame.bytes();
    let src_width = frame.width as usize;
    let src_height = frame.height as usize;

    // Calculate scale factor to fit within max_size
    let needs_scale = src_width > max_size as usize || src_height > max_size as usize;
    let (dst_width, dst_height) = if needs_scale {
        let scale_w = max_size as f32 / src_width as f32;
        let scale_h = max_size as f32 / src_height as f32;
        let scale = scale_w.min(scale_h);
        (
            ((src_width as f32 * scale) as u32).max(1),
            ((src_height as f32 * scale) as u32).max(1),
        )
    } else {
        (src_width as u32, src_height as u32)
    };

    let dst_pixel_count = (dst_width * dst_height) as usize;

    // Pre-allocate exact size to avoid reallocations
    rgba.clear();
    rgba.reserve_exact(dst_pixel_count * 4);

    // Pre-calculate mapping ratios as fixed-point (16.16) for speed
    let x_ratio = if needs_scale {
        ((src_width << 16) / dst_width as usize) as usize
    } else {
        1 << 16
    };
    let y_ratio = if needs_scale {
        ((src_height << 16) / dst_height as usize) as usize
    } else {
        1 << 16
    };

    match frame.pixel_format {
        PixelFormat::MJPEG => {
            // Decode JPEG - use Nearest for speed when scaling
            let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Failed to decode MJPEG: {}", e))?;
            let img = if needs_scale {
                // Use Nearest for speed - GPU bilinear will smooth it
                img.resize(dst_width, dst_height, image::imageops::FilterType::Nearest)
            } else {
                img
            };
            let rgb = img.to_rgb8();
            // Bulk extend - faster than per-pixel
            rgba.extend(rgb.pixels().flat_map(|p| [p[0], p[1], p[2], 255]));
        },
        PixelFormat::NV12 => {
            let y_size = src_width * src_height;
            let uv_size = y_size / 2;
            if bytes.len() < y_size + uv_size {
                return Err("NV12 buffer too small".into());
            }
            let y_plane = &bytes[..y_size];
            let uv_plane = &bytes[y_size..y_size + uv_size];

            for dst_y in 0..dst_height as usize {
                let src_y = ((dst_y * y_ratio) >> 16).min(src_height - 1);
                let row_offset = src_y * src_width;
                let uv_row = (src_y / 2) * src_width;

                for dst_x in 0..dst_width as usize {
                    let src_x = ((dst_x * x_ratio) >> 16).min(src_width - 1);

                    // Integer YUV to RGB (BT.601, scaled by 256)
                    let y = y_plane[row_offset + src_x] as i32;
                    let uv_idx = uv_row + (src_x / 2 * 2);
                    let u = uv_plane.get(uv_idx).copied().unwrap_or(128) as i32 - 128;
                    let v = uv_plane.get(uv_idx + 1).copied().unwrap_or(128) as i32 - 128;

                    // BT.601 coefficients scaled by 256
                    let r = (y + ((359 * v) >> 8)).clamp(0, 255) as u8;
                    let g = (y - ((88 * u + 183 * v) >> 8)).clamp(0, 255) as u8;
                    let b = (y + ((454 * u) >> 8)).clamp(0, 255) as u8;
                    rgba.extend_from_slice(&[r, g, b, 255]);
                }
            }
        },
        PixelFormat::YUYV422 => {
            let expected = src_width * src_height * 2;
            if bytes.len() < expected {
                return Err("YUYV buffer too small".into());
            }

            for dst_y in 0..dst_height as usize {
                let src_y = ((dst_y * y_ratio) >> 16).min(src_height - 1);
                let row_base = src_y * src_width * 2;

                for dst_x in 0..dst_width as usize {
                    let src_x = ((dst_x * x_ratio) >> 16).min(src_width - 1);
                    let pair_x = src_x / 2 * 2;
                    let chunk_offset = row_base + pair_x * 2;

                    if chunk_offset + 4 > bytes.len() {
                        rgba.extend_from_slice(&[128, 128, 128, 255]);
                        continue;
                    }

                    // YUYV: Y0 U Y1 V
                    let y = bytes[chunk_offset + (src_x & 1) * 2] as i32;
                    let u = bytes[chunk_offset + 1] as i32 - 128;
                    let v = bytes[chunk_offset + 3] as i32 - 128;

                    // BT.601 coefficients scaled by 256
                    let r = (y + ((359 * v) >> 8)).clamp(0, 255) as u8;
                    let g = (y - ((88 * u + 183 * v) >> 8)).clamp(0, 255) as u8;
                    let b = (y + ((454 * u) >> 8)).clamp(0, 255) as u8;
                    rgba.extend_from_slice(&[r, g, b, 255]);
                }
            }
        },
        PixelFormat::RGB24 => {
            let expected = src_width * src_height * 3;
            if bytes.len() < expected {
                return Err("RGB24 buffer too small".into());
            }

            if !needs_scale {
                // Fast path: no scaling, just add alpha channel
                rgba.extend(
                    bytes
                        .chunks_exact(3)
                        .take(src_width * src_height)
                        .flat_map(|p| [p[0], p[1], p[2], 255]),
                );
            } else {
                for dst_y in 0..dst_height as usize {
                    let src_y = ((dst_y * y_ratio) >> 16).min(src_height - 1);
                    let row_offset = src_y * src_width * 3;
                    for dst_x in 0..dst_width as usize {
                        let src_x = ((dst_x * x_ratio) >> 16).min(src_width - 1);
                        let offset = row_offset + src_x * 3;
                        rgba.extend_from_slice(&[
                            bytes[offset],
                            bytes[offset + 1],
                            bytes[offset + 2],
                            255,
                        ]);
                    }
                }
            }
        },
        PixelFormat::RGB32 | PixelFormat::ARGB => {
            let expected = src_width * src_height * 4;
            if bytes.len() < expected {
                return Err("RGB32 buffer too small".into());
            }

            if !needs_scale {
                // Fast path: no scaling, just reorder BGRA to RGBA
                rgba.extend(
                    bytes
                        .chunks_exact(4)
                        .take(src_width * src_height)
                        .flat_map(|p| [p[2], p[1], p[0], p[3]]),
                );
            } else {
                for dst_y in 0..dst_height as usize {
                    let src_y = ((dst_y * y_ratio) >> 16).min(src_height - 1);
                    let row_offset = src_y * src_width * 4;
                    for dst_x in 0..dst_width as usize {
                        let src_x = ((dst_x * x_ratio) >> 16).min(src_width - 1);
                        let offset = row_offset + src_x * 4;
                        rgba.extend_from_slice(&[
                            bytes[offset + 2],
                            bytes[offset + 1],
                            bytes[offset],
                            bytes[offset + 3],
                        ]);
                    }
                }
            }
        },
        _ => {
            return Err(format!(
                "Unsupported pixel format: {:?}",
                frame.pixel_format
            ))
        },
    }

    Ok((dst_width, dst_height))
}

/// Convert NativeCameraFrame to RGBA bytes for GPU upload, with optional downscaling.
/// Downscaling happens during conversion (point sampling) which is much faster
/// than converting at full resolution.
#[allow(dead_code)]
fn frame_to_rgba_scaled(
    frame: &NativeCameraFrame,
    max_size: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    use snapit_camera_windows::PixelFormat;

    let bytes = frame.bytes();
    let src_width = frame.width as usize;
    let src_height = frame.height as usize;

    // Calculate scale factor to fit within max_size
    let scale = if src_width > max_size as usize || src_height > max_size as usize {
        let scale_w = max_size as f32 / src_width as f32;
        let scale_h = max_size as f32 / src_height as f32;
        scale_w.min(scale_h)
    } else {
        1.0
    };

    let dst_width = ((src_width as f32 * scale) as u32).max(1);
    let dst_height = ((src_height as f32 * scale) as u32).max(1);
    let dst_pixel_count = (dst_width * dst_height) as usize;

    // Step size for point sampling (how many source pixels to skip)
    let step = if scale < 1.0 {
        (1.0 / scale).ceil() as usize
    } else {
        1
    };
    let step = step.max(1); // Ensure step is at least 1

    match frame.pixel_format {
        PixelFormat::MJPEG => {
            // Decode JPEG to RGB, then resize
            let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Failed to decode MJPEG: {}", e))?;

            // Resize if needed
            let img = if scale < 1.0 {
                img.resize(dst_width, dst_height, image::imageops::FilterType::Nearest)
            } else {
                img
            };

            let rgb = img.to_rgb8();
            let mut rgba = Vec::with_capacity(dst_pixel_count * 4);
            for pixel in rgb.pixels() {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
            Ok((rgba, dst_width, dst_height))
        },
        PixelFormat::NV12 => {
            // NV12: Y plane + interleaved UV - sample every Nth pixel
            let y_size = src_width * src_height;
            let uv_size = y_size / 2;
            if bytes.len() < y_size + uv_size {
                return Err("NV12 buffer too small".into());
            }

            let y_plane = &bytes[..y_size];
            let uv_plane = &bytes[y_size..y_size + uv_size];

            let mut rgba = Vec::with_capacity(dst_pixel_count * 4);
            for dst_y in 0..dst_height as usize {
                let src_y = dst_y * step;
                if src_y >= src_height {
                    break;
                }
                for dst_x in 0..dst_width as usize {
                    let src_x = dst_x * step;
                    if src_x >= src_width {
                        break;
                    }

                    let y = y_plane[src_y * src_width + src_x] as f32;
                    let uv_idx = (src_y / 2) * src_width + (src_x / 2 * 2);
                    let u = uv_plane[uv_idx] as f32 - 128.0;
                    let v = uv_plane[uv_idx + 1] as f32 - 128.0;

                    let r = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
                    let g = (y - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                    let b = (y + 1.772 * u).clamp(0.0, 255.0) as u8;

                    rgba.extend_from_slice(&[r, g, b, 255]);
                }
            }
            Ok((rgba, dst_width, dst_height))
        },
        PixelFormat::YUYV422 => {
            // YUYV: sample every Nth pair of pixels
            let expected = src_width * src_height * 2;
            if bytes.len() < expected {
                return Err("YUYV buffer too small".into());
            }

            let mut rgba = Vec::with_capacity(dst_pixel_count * 4);
            for dst_y in 0..dst_height as usize {
                let src_y = dst_y * step;
                if src_y >= src_height {
                    break;
                }
                for dst_x in 0..dst_width as usize {
                    let src_x = dst_x * step;
                    if src_x >= src_width {
                        break;
                    }

                    // YUYV has 2 pixels per 4 bytes, so we need to find the right chunk
                    let pair_x = src_x / 2 * 2; // Align to pair boundary
                    let chunk_offset = (src_y * src_width + pair_x) * 2;
                    let chunk = &bytes[chunk_offset..chunk_offset + 4];

                    let y = if src_x % 2 == 0 { chunk[0] } else { chunk[2] } as f32;
                    let u = chunk[1] as f32 - 128.0;
                    let v = chunk[3] as f32 - 128.0;

                    let r = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
                    let g = (y - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                    let b = (y + 1.772 * u).clamp(0.0, 255.0) as u8;

                    rgba.extend_from_slice(&[r, g, b, 255]);
                }
            }
            Ok((rgba, dst_width, dst_height))
        },
        PixelFormat::RGB24 => {
            let expected = src_width * src_height * 3;
            if bytes.len() < expected {
                return Err("RGB24 buffer too small".into());
            }

            let mut rgba = Vec::with_capacity(dst_pixel_count * 4);
            for dst_y in 0..dst_height as usize {
                let src_y = dst_y * step;
                if src_y >= src_height {
                    break;
                }
                for dst_x in 0..dst_width as usize {
                    let src_x = dst_x * step;
                    if src_x >= src_width {
                        break;
                    }

                    let offset = (src_y * src_width + src_x) * 3;
                    rgba.extend_from_slice(&[
                        bytes[offset],
                        bytes[offset + 1],
                        bytes[offset + 2],
                        255,
                    ]);
                }
            }
            Ok((rgba, dst_width, dst_height))
        },
        PixelFormat::RGB32 | PixelFormat::ARGB => {
            // Assume BGRA, convert to RGBA with sampling
            let expected = src_width * src_height * 4;
            if bytes.len() < expected {
                return Err("RGB32 buffer too small".into());
            }

            let mut rgba = Vec::with_capacity(dst_pixel_count * 4);
            for dst_y in 0..dst_height as usize {
                let src_y = dst_y * step;
                if src_y >= src_height {
                    break;
                }
                for dst_x in 0..dst_width as usize {
                    let src_x = dst_x * step;
                    if src_x >= src_width {
                        break;
                    }

                    let offset = (src_y * src_width + src_x) * 4;
                    rgba.extend_from_slice(&[
                        bytes[offset + 2],
                        bytes[offset + 1],
                        bytes[offset],
                        bytes[offset + 3],
                    ]);
                }
            }
            Ok((rgba, dst_width, dst_height))
        },
        _ => Err(format!(
            "Unsupported pixel format: {:?}",
            frame.pixel_format
        )),
    }
}

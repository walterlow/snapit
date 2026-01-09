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
    texture_cache: Option<CachedTexture>,
    aspect_ratio: f32,
}

struct CachedTexture {
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct StateUniforms {
    shape: f32,
    size: f32,
    mirrored: f32,
    _padding: f32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    _padding1: f32,
    _padding2: f32,
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

    // Load shader
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("camera-shader"),
        source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!("camera.wgsl"))),
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

    let texture_bind_group_layout =
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("texture-bind-group-layout"),
            entries: &[
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
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
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
    fn update_state_uniforms(&self, state: &GpuPreviewState) {
        let normalized_size =
            (state.size - MIN_PREVIEW_SIZE) / (MAX_PREVIEW_SIZE - MIN_PREVIEW_SIZE);
        let uniforms = StateUniforms {
            shape: match state.shape {
                WebcamShape::Circle => 0.0,
                WebcamShape::Rectangle => 1.0,
            },
            size: normalized_size.clamp(0.0, 1.0),
            mirrored: if state.mirrored { 1.0 } else { 0.0 },
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.state_uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniforms]),
        );
    }

    fn update_window_uniforms(&self, width: u32, height: u32) {
        let uniforms = WindowUniforms {
            window_width: (width * GPU_SURFACE_SCALE) as f32,
            window_height: (height * GPU_SURFACE_SCALE) as f32,
            _padding1: 0.0,
            _padding2: 0.0,
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
        log::trace!("[GPU_PREVIEW] render_frame: converting to RGBA");
        // Convert frame to RGBA for GPU upload
        let rgba_data = frame_to_rgba(frame)?;
        let width = frame.width;
        let height = frame.height;

        // Get or create texture
        let needs_new_texture = self
            .texture_cache
            .as_ref()
            .map(|t| t.width != width || t.height != height)
            .unwrap_or(true);

        if needs_new_texture {
            log::info!("[GPU_PREVIEW] Creating new texture: {}x{}", width, height);
            self.texture_cache = Some(self.create_texture(width, height));
        }

        let cached = self.texture_cache.as_ref().unwrap();

        // Upload frame data to texture
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &cached.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba_data,
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

        // Get surface texture - handle Outdated by reconfiguring
        log::trace!("[GPU_PREVIEW] Getting surface texture");
        let surface_texture = match self.surface.get_current_texture() {
            Ok(tex) => {
                log::trace!("[GPU_PREVIEW] Got surface texture");
                tex
            },
            Err(wgpu::SurfaceError::Outdated) => {
                log::info!("[GPU_PREVIEW] Surface outdated, reconfiguring");
                // Surface needs reconfiguration (window resized/region changed)
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

    fn create_texture(&self, width: u32, height: u32) -> CachedTexture {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("camera-texture"),
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

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("texture-bind-group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });

        CachedTexture {
            texture,
            bind_group,
            width,
            height,
        }
    }

    fn cleanup(&mut self) {
        self.texture_cache = None;
        self.device.destroy();
    }
}

/// Convert NativeCameraFrame to RGBA bytes for GPU upload
fn frame_to_rgba(frame: &NativeCameraFrame) -> Result<Vec<u8>, String> {
    use snapit_camera_windows::PixelFormat;

    let bytes = frame.bytes();
    let width = frame.width as usize;
    let height = frame.height as usize;
    let pixel_count = width * height;

    match frame.pixel_format {
        PixelFormat::MJPEG => {
            // Decode JPEG to RGB, convert to RGBA
            let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Failed to decode MJPEG: {}", e))?;
            let rgb = img.to_rgb8();

            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for pixel in rgb.pixels() {
                rgba.push(pixel[0]); // R
                rgba.push(pixel[1]); // G
                rgba.push(pixel[2]); // B
                rgba.push(255); // A
            }
            Ok(rgba)
        },
        PixelFormat::NV12 => {
            // NV12: Y plane + interleaved UV
            let y_size = pixel_count;
            let uv_size = pixel_count / 2;
            if bytes.len() < y_size + uv_size {
                return Err("NV12 buffer too small".into());
            }

            let y_plane = &bytes[..y_size];
            let uv_plane = &bytes[y_size..y_size + uv_size];

            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for y_idx in 0..height {
                for x_idx in 0..width {
                    let y = y_plane[y_idx * width + x_idx] as f32;
                    let uv_idx = (y_idx / 2) * width + (x_idx / 2 * 2);
                    let u = uv_plane[uv_idx] as f32 - 128.0;
                    let v = uv_plane[uv_idx + 1] as f32 - 128.0;

                    let r = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
                    let g = (y - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                    let b = (y + 1.772 * u).clamp(0.0, 255.0) as u8;

                    rgba.extend_from_slice(&[r, g, b, 255]);
                }
            }
            Ok(rgba)
        },
        PixelFormat::YUYV422 => {
            let expected = pixel_count * 2;
            if bytes.len() < expected {
                return Err("YUYV buffer too small".into());
            }

            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for chunk in bytes[..expected].chunks_exact(4) {
                let y0 = chunk[0] as f32;
                let u = chunk[1] as f32 - 128.0;
                let y1 = chunk[2] as f32;
                let v = chunk[3] as f32 - 128.0;

                let r0 = (y0 + 1.402 * v).clamp(0.0, 255.0) as u8;
                let g0 = (y0 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                let b0 = (y0 + 1.772 * u).clamp(0.0, 255.0) as u8;

                let r1 = (y1 + 1.402 * v).clamp(0.0, 255.0) as u8;
                let g1 = (y1 - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
                let b1 = (y1 + 1.772 * u).clamp(0.0, 255.0) as u8;

                rgba.extend_from_slice(&[r0, g0, b0, 255, r1, g1, b1, 255]);
            }
            Ok(rgba)
        },
        PixelFormat::RGB24 => {
            let expected = pixel_count * 3;
            if bytes.len() < expected {
                return Err("RGB24 buffer too small".into());
            }

            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for pixel in bytes[..expected].chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
            Ok(rgba)
        },
        PixelFormat::RGB32 | PixelFormat::ARGB => {
            // Assume BGRA, convert to RGBA
            let expected = pixel_count * 4;
            if bytes.len() < expected {
                return Err("RGB32 buffer too small".into());
            }

            let mut rgba = Vec::with_capacity(pixel_count * 4);
            for pixel in bytes[..expected].chunks_exact(4) {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
            Ok(rgba)
        },
        _ => Err(format!(
            "Unsupported pixel format: {:?}",
            frame.pixel_format
        )),
    }
}

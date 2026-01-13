//! Native wgpu surface for text overlay preview.
//!
//! Creates a child window with wgpu rendering positioned behind the
//! transparent Tauri webview for zero-latency text preview.

use crate::commands::video_recording::video_project::{TextSegment, XY};
use crate::rendering::text::prepare_texts;
use crate::rendering::text_layer::TextLayer;
use log::{error, info};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use wgpu::{Device, Queue, Surface, SurfaceConfiguration, TextureFormat};

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos, ShowWindow,
    HWND_BOTTOM, SWP_NOACTIVATE, SW_SHOW, WM_PAINT, WNDCLASSW, WS_CHILD, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TRANSPARENT, WS_VISIBLE,
};

/// Native text preview surface state.
///
/// Note: We store the HWND as an isize to allow Send/Sync.
/// The actual window operations are done on the main thread via atomics.
pub struct NativeTextPreview {
    /// wgpu device
    device: Arc<Device>,
    /// wgpu queue
    queue: Arc<Queue>,
    /// wgpu surface (Windows only) - stored as Option to allow None
    #[cfg(windows)]
    surface: Mutex<Option<Surface<'static>>>,
    /// Surface configuration
    #[cfg(windows)]
    config: Mutex<Option<SurfaceConfiguration>>,
    /// Child window handle as isize (Windows only) - stored as atomic for thread safety
    #[cfg(windows)]
    child_hwnd: AtomicI64,
    /// Text layer for GPU rendering
    text_layer: Mutex<TextLayer>,
    /// Current render dimensions
    width: AtomicU64,
    height: AtomicU64,
    /// Is the preview active?
    active: AtomicBool,
    /// Current text segments (cached for re-render on resize)
    segments: Mutex<Vec<TextSegment>>,
    /// Current time in milliseconds
    current_time_ms: AtomicU64,
}

// SAFETY: NativeTextPreview is Send+Sync because:
// - All fields use thread-safe types (Arc, Mutex, Atomic*)
// - The child_hwnd is stored as an atomic isize, not a raw pointer
// - Window operations are only performed when holding the appropriate locks
unsafe impl Send for NativeTextPreview {}
unsafe impl Sync for NativeTextPreview {}

/// Global preview instances by window label.
static PREVIEW_INSTANCES: Mutex<Option<HashMap<String, Arc<NativeTextPreview>>>> = Mutex::new(None);

impl NativeTextPreview {
    /// Create a new native text preview.
    #[cfg(windows)]
    pub fn new(device: Arc<Device>, queue: Arc<Queue>) -> Self {
        let text_layer = TextLayer::new(&device, &queue);

        Self {
            device,
            queue,
            surface: Mutex::new(None),
            config: Mutex::new(None),
            child_hwnd: AtomicI64::new(0),
            text_layer: Mutex::new(text_layer),
            width: AtomicU64::new(0),
            height: AtomicU64::new(0),
            active: AtomicBool::new(false),
            segments: Mutex::new(Vec::new()),
            current_time_ms: AtomicU64::new(0),
        }
    }

    #[cfg(not(windows))]
    pub fn new(device: Arc<Device>, queue: Arc<Queue>) -> Self {
        let text_layer = TextLayer::new(&device, &queue);

        Self {
            device,
            queue,
            text_layer: Mutex::new(text_layer),
            width: AtomicU64::new(0),
            height: AtomicU64::new(0),
            active: AtomicBool::new(false),
            segments: Mutex::new(Vec::new()),
            current_time_ms: AtomicU64::new(0),
        }
    }

    /// Initialize the preview surface attached to a parent window.
    #[cfg(windows)]
    pub fn init_surface(
        &self,
        parent_hwnd: isize,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        use raw_window_handle::{RawWindowHandle, Win32WindowHandle};
        use std::num::NonZeroIsize;

        unsafe {
            // Register window class (only once)
            static CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);
            if !CLASS_REGISTERED.swap(true, Ordering::SeqCst) {
                let class_name: Vec<u16> = "SnapItTextPreview\0".encode_utf16().collect();
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(preview_wnd_proc),
                    lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
                    ..Default::default()
                };
                RegisterClassW(&wc);
            }

            // Create child window
            let class_name: Vec<u16> = "SnapItTextPreview\0".encode_utf16().collect();
            let child = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
                windows::core::PCWSTR(class_name.as_ptr()),
                windows::core::PCWSTR::null(),
                WS_CHILD | WS_VISIBLE,
                x,
                y,
                width as i32,
                height as i32,
                HWND(parent_hwnd as *mut _),
                None,
                None,
                None,
            )
            .map_err(|e| format!("Failed to create child window: {}", e))?;

            // Store as isize for thread safety
            self.child_hwnd.store(child.0 as i64, Ordering::SeqCst);

            // Position behind other content (HWND_BOTTOM)
            SetWindowPos(
                child,
                HWND_BOTTOM,
                x,
                y,
                width as i32,
                height as i32,
                SWP_NOACTIVATE,
            )
            .ok();

            ShowWindow(child, SW_SHOW).ok();

            // Create wgpu surface from child window
            let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
                backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN,
                ..Default::default()
            });

            // Create raw window handle
            let handle =
                Win32WindowHandle::new(NonZeroIsize::new(child.0 as isize).ok_or("Invalid HWND")?);
            // SAFETY: The child window is valid and we own it
            let target = wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: raw_window_handle::RawDisplayHandle::Windows(
                    raw_window_handle::WindowsDisplayHandle::new(),
                ),
                raw_window_handle: RawWindowHandle::Win32(handle),
            };

            let surface = instance
                .create_surface_unsafe(target)
                .map_err(|e| format!("Failed to create surface: {}", e))?;

            // Configure surface
            let config = SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: TextureFormat::Bgra8UnormSrgb,
                width,
                height,
                present_mode: wgpu::PresentMode::Mailbox,
                alpha_mode: wgpu::CompositeAlphaMode::PreMultiplied,
                view_formats: vec![],
                desired_maximum_frame_latency: 2,
            };
            surface.configure(&self.device, &config);

            *self.surface.lock() = Some(surface);
            *self.config.lock() = Some(config);
            self.width.store(width as u64, Ordering::Relaxed);
            self.height.store(height as u64, Ordering::Relaxed);
            self.active.store(true, Ordering::Relaxed);

            info!(
                "[NativeTextPreview] Surface initialized: {}x{} at ({}, {})",
                width, height, x, y
            );
        }

        Ok(())
    }

    #[cfg(not(windows))]
    pub fn init_surface(
        &self,
        _parent_hwnd: isize,
        _x: i32,
        _y: i32,
        _width: u32,
        _height: u32,
    ) -> Result<(), String> {
        Err("Native text preview is only supported on Windows".to_string())
    }

    /// Resize the preview surface.
    #[cfg(windows)]
    pub fn resize(&self, x: i32, y: i32, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }

        unsafe {
            let hwnd_val = self.child_hwnd.load(Ordering::SeqCst);
            if hwnd_val != 0 {
                let hwnd = HWND(hwnd_val as *mut _);
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    x,
                    y,
                    width as i32,
                    height as i32,
                    SWP_NOACTIVATE,
                )
                .ok();
            }
        }

        {
            let mut config = self.config.lock();
            if let Some(cfg) = config.as_mut() {
                cfg.width = width;
                cfg.height = height;
                let surface = self.surface.lock();
                if let Some(surf) = surface.as_ref() {
                    surf.configure(&self.device, cfg);
                }
            }
        }

        self.width.store(width as u64, Ordering::Relaxed);
        self.height.store(height as u64, Ordering::Relaxed);

        // Re-render with new size
        self.render();
    }

    #[cfg(not(windows))]
    pub fn resize(&self, _x: i32, _y: i32, _width: u32, _height: u32) {}

    /// Update text segments and render.
    pub fn update_segments(&self, segments: Vec<TextSegment>, time_ms: u64) {
        *self.segments.lock() = segments;
        self.current_time_ms.store(time_ms, Ordering::Relaxed);
        self.render();
    }

    /// Update just the time and re-render (for scrubbing).
    pub fn update_time(&self, time_ms: u64) {
        self.current_time_ms.store(time_ms, Ordering::Relaxed);
        self.render();
    }

    /// Render text to the surface.
    #[cfg(windows)]
    pub fn render(&self) {
        if !self.active.load(Ordering::Relaxed) {
            return;
        }

        let surface_guard = self.surface.lock();
        let surface = match surface_guard.as_ref() {
            Some(s) => s,
            None => return,
        };

        let width = self.width.load(Ordering::Relaxed) as u32;
        let height = self.height.load(Ordering::Relaxed) as u32;

        if width == 0 || height == 0 {
            return;
        }

        let segments = self.segments.lock().clone();
        let time_ms = self.current_time_ms.load(Ordering::Relaxed);
        let time_secs = time_ms as f64 / 1000.0;

        // Prepare text
        let output_size = XY::new(width, height);
        let prepared_texts = prepare_texts(output_size, time_secs, &segments);

        // Get surface texture
        let output = match surface.get_current_texture() {
            Ok(t) => t,
            Err(e) => {
                error!("[NativeTextPreview] Failed to get surface texture: {}", e);
                return;
            },
        };

        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // Prepare text layer
        let mut text_layer = self.text_layer.lock();
        text_layer.prepare(&self.device, &self.queue, (width, height), &prepared_texts);

        // Create render pass
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("NativeTextPreview Encoder"),
            });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("NativeTextPreview Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if text_layer.has_texts() {
                text_layer.render(&mut pass);
            }
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        output.present();
    }

    #[cfg(not(windows))]
    pub fn render(&self) {}

    /// Destroy the preview surface and child window.
    #[cfg(windows)]
    pub fn destroy(&self) {
        self.active.store(false, Ordering::Relaxed);

        *self.surface.lock() = None;
        *self.config.lock() = None;

        unsafe {
            let hwnd_val = self.child_hwnd.swap(0, Ordering::SeqCst);
            if hwnd_val != 0 {
                let hwnd = HWND(hwnd_val as *mut _);
                DestroyWindow(hwnd).ok();
            }
        }

        info!("[NativeTextPreview] Destroyed");
    }

    #[cfg(not(windows))]
    pub fn destroy(&self) {
        self.active.store(false, Ordering::Relaxed);
    }
}

impl Drop for NativeTextPreview {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// Window procedure for the child window.
#[cfg(windows)]
unsafe extern "system" fn preview_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            // Let wgpu handle painting
            LRESULT(0)
        },
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Get or create a preview instance for a window.
pub fn get_preview_instance(
    label: &str,
    device: Arc<Device>,
    queue: Arc<Queue>,
) -> Arc<NativeTextPreview> {
    let mut instances = PREVIEW_INSTANCES.lock();
    if instances.is_none() {
        *instances = Some(HashMap::new());
    }

    let map = instances.as_mut().unwrap();
    map.entry(label.to_string())
        .or_insert_with(|| Arc::new(NativeTextPreview::new(device, queue)))
        .clone()
}

/// Remove a preview instance.
pub fn remove_preview_instance(label: &str) {
    let mut instances = PREVIEW_INSTANCES.lock();
    if let Some(map) = instances.as_mut() {
        if let Some(mut preview) = map.remove(label) {
            if let Some(preview) = Arc::get_mut(&mut preview) {
                preview.destroy();
            }
        }
    }
}

//! Camera preview window manager (inspired by Cap).
//!
//! Centralizes all webcam preview lifecycle:
//! - Window creation/destruction
//! - GPU preview initialization/cleanup
//! - Settings persistence
//!
//! Key insight from Cap: Window is created HIDDEN in Rust, wgpu is initialized,
//! then window is shown. This avoids race conditions from frontend window creation.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use super::gpu_preview::{self, GpuPreviewState};
use super::{WebcamSettings, WebcamShape, WebcamSize};

/// Preview window size based on webcam size setting
fn get_preview_size(size: WebcamSize) -> u32 {
    match size {
        WebcamSize::Small => 120,
        WebcamSize::Medium => 160,
        WebcamSize::Large => 200,
    }
}

/// Active preview state
struct ActivePreview {
    /// Device index currently in use
    device_index: usize,
    /// Flag to track if we're in the process of showing
    showing: Arc<AtomicBool>,
}

/// Manages the camera preview window lifecycle.
///
/// Only ONE preview can exist at a time. All operations are atomic.
pub struct CameraPreviewManager {
    /// Currently active preview (if any)
    preview: Mutex<Option<ActivePreview>>,
    /// Current settings
    settings: Mutex<WebcamSettings>,
}

impl CameraPreviewManager {
    /// Create a new camera preview manager.
    pub fn new() -> Self {
        Self {
            preview: Mutex::new(None),
            settings: Mutex::new(WebcamSettings::default()),
        }
    }

    /// Check if preview is currently showing.
    pub fn is_showing(&self) -> bool {
        self.preview.lock().is_some()
    }

    /// Get current settings.
    pub fn get_settings(&self) -> WebcamSettings {
        self.settings.lock().clone()
    }

    /// Update settings.
    pub fn set_settings(&self, settings: WebcamSettings) {
        *self.settings.lock() = settings;
    }

    /// Show the camera preview window (async version for Tauri command).
    ///
    /// Creates window HIDDEN, initializes wgpu, then shows window.
    /// This is the Cap pattern that avoids race conditions.
    pub async fn show_async(&self, app: AppHandle, device_index: usize) -> Result<(), String> {
        // Check if already showing
        {
            let guard = self.preview.lock();
            if guard.is_some() {
                log::info!("[PREVIEW_MANAGER] Preview already showing");
                return Ok(());
            }
        }

        // Clean up any stale state first (Cap does this)
        self.cleanup_stale(&app);

        let settings = self.settings.lock().clone();
        let size = get_preview_size(settings.size);

        log::info!(
            "[PREVIEW_MANAGER] Creating preview window (device={}, size={})",
            device_index,
            size
        );

        // Create window HIDDEN (Cap pattern - visible(false))
        let window = WebviewWindowBuilder::new(
            &app,
            "webcam-preview",
            tauri::WebviewUrl::App("/webcam-preview.html".into()),
        )
        .title("Webcam Preview")
        .inner_size(size as f64, size as f64)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false) // KEY: Start hidden like Cap
        .position(100.0, 100.0)
        .build()
        .map_err(|e| format!("Failed to create preview window: {}", e))?;

        log::info!("[PREVIEW_MANAGER] Window created (hidden), starting GPU preview");

        // NOTE: Win32 style modifications removed - Tauri's decorations(false) handles this
        // Manual style changes were potentially interfering with transparency

        // Initialize GPU preview state
        let state = GpuPreviewState::from_settings(settings.size, settings.shape, settings.mirror);
        gpu_preview::update_gpu_preview_state(state);

        // Start GPU preview - this creates wgpu surface and starts render thread
        gpu_preview::start_gpu_preview(window.clone(), device_index)?;

        // Small delay to ensure GPU is ready before showing
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // NOW show the window (Cap pattern)
        log::info!("[PREVIEW_MANAGER] GPU ready, showing window");
        window
            .show()
            .map_err(|e| format!("Failed to show window: {}", e))?;

        // Apply window region for transparency (wgpu alpha modes don't work on Windows)
        // This clips the window at the OS level so we don't need alpha blending
        #[cfg(target_os = "windows")]
        {
            use crate::commands::window::{apply_circular_region, apply_rounded_region};

            match settings.shape {
                WebcamShape::Circle => {
                    if let Err(e) = apply_circular_region(&window, size as i32) {
                        log::warn!("[PREVIEW_MANAGER] Failed to apply circular region: {}", e);
                    } else {
                        log::info!("[PREVIEW_MANAGER] Applied circular window region");
                    }
                },
                WebcamShape::Rectangle => {
                    // Use rounded rectangle with corner radius
                    if let Err(e) = apply_rounded_region(&window, size as i32, size as i32, 12) {
                        log::warn!("[PREVIEW_MANAGER] Failed to apply rounded region: {}", e);
                    } else {
                        log::info!("[PREVIEW_MANAGER] Applied rounded rectangle window region");
                    }
                },
            }
        }

        // Store active preview state
        {
            let mut guard = self.preview.lock();
            *guard = Some(ActivePreview {
                device_index,
                showing: Arc::new(AtomicBool::new(true)),
            });
        }

        log::info!(
            "[PREVIEW_MANAGER] Preview shown (device={}, size={})",
            device_index,
            size
        );

        Ok(())
    }

    /// Clean up stale preview state (Cap does this before creating new window)
    fn cleanup_stale(&self, app: &AppHandle) {
        let mut guard = self.preview.lock();
        if guard.take().is_some() {
            log::warn!("[PREVIEW_MANAGER] Cleaning up stale preview before creating new one");
            gpu_preview::stop_gpu_preview();
            if let Some(window) = app.get_webview_window("webcam-preview") {
                let _ = window.destroy();
            }
        }
    }

    /// Hide the camera preview window.
    pub fn hide(&self, app: &AppHandle) {
        let mut guard = self.preview.lock();

        if let Some(preview) = guard.take() {
            preview.showing.store(false, Ordering::SeqCst);

            // Stop GPU preview first
            gpu_preview::stop_gpu_preview();

            // Then destroy window
            if let Some(window) = app.get_webview_window("webcam-preview") {
                let _ = window.destroy();
            }

            log::info!("[PREVIEW_MANAGER] Preview hidden");
        }
    }

    /// Called when the preview window is closed externally.
    pub fn on_window_close(&self) {
        let mut guard = self.preview.lock();

        if let Some(preview) = guard.take() {
            preview.showing.store(false, Ordering::SeqCst);
            gpu_preview::stop_gpu_preview();
            log::info!("[PREVIEW_MANAGER] Preview closed externally");
        }
    }

    /// Update GPU preview settings without recreating the window.
    pub fn update_preview_settings(
        &self,
        app: &AppHandle,
        size: WebcamSize,
        shape: WebcamShape,
        mirror: bool,
    ) {
        {
            let mut settings = self.settings.lock();
            settings.size = size;
            settings.shape = shape;
            settings.mirror = mirror;
        }

        if self.preview.lock().is_some() {
            let state = GpuPreviewState::from_settings(size, shape, mirror);
            gpu_preview::update_gpu_preview_state(state);

            // Update window region for the new shape/size
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("webcam-preview") {
                use crate::commands::window::{apply_circular_region, apply_rounded_region};

                let size_px = get_preview_size(size) as i32;
                match shape {
                    WebcamShape::Circle => {
                        if let Err(e) = apply_circular_region(&window, size_px) {
                            log::warn!("[PREVIEW_MANAGER] Failed to update circular region: {}", e);
                        }
                    },
                    WebcamShape::Rectangle => {
                        if let Err(e) = apply_rounded_region(&window, size_px, size_px, 12) {
                            log::warn!("[PREVIEW_MANAGER] Failed to update rounded region: {}", e);
                        }
                    },
                }
            }
        }
    }
}

impl Default for CameraPreviewManager {
    fn default() -> Self {
        Self::new()
    }
}

// Global manager instance
static PREVIEW_MANAGER: std::sync::OnceLock<CameraPreviewManager> = std::sync::OnceLock::new();

/// Get the global preview manager.
pub fn get_preview_manager() -> &'static CameraPreviewManager {
    PREVIEW_MANAGER.get_or_init(CameraPreviewManager::new)
}

/// Show the camera preview window (async).
pub async fn show_camera_preview_async(app: AppHandle, device_index: usize) -> Result<(), String> {
    get_preview_manager().show_async(app, device_index).await
}

/// Hide the camera preview window.
pub fn hide_camera_preview(app: &AppHandle) {
    get_preview_manager().hide(app)
}

/// Check if camera preview is showing.
pub fn is_camera_preview_showing() -> bool {
    get_preview_manager().is_showing()
}

/// Called when preview window is closed.
pub fn on_preview_window_close() {
    get_preview_manager().on_window_close()
}

/// Update preview settings.
pub fn update_preview_settings(
    app: &AppHandle,
    size: WebcamSize,
    shape: WebcamShape,
    mirror: bool,
) {
    get_preview_manager().update_preview_settings(app, size, shape, mirror)
}

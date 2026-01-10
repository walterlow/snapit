//! Camera preview window manager.
//!
//! Centralizes all webcam preview lifecycle:
//! - Window creation/destruction
//! - Preview service start/stop (JPEG-based for browser rendering)
//! - Settings persistence
//!
//! Uses simple JPEG polling instead of wgpu for better performance and simplicity.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use super::preview::{self, start_preview, stop_preview};
use super::{WebcamSettings, WebcamShape, WebcamSize};

/// Control bar height in pixels
const CONTROL_BAR_HEIGHT: u32 = 40;
/// Gap between control bar and preview
const CONTROL_GAP: u32 = 8;

/// Preview window size based on webcam size setting
/// Returns (width, height) - height includes space for control bar above preview
fn get_preview_size(size: WebcamSize) -> (u32, u32) {
    let base = match size {
        WebcamSize::Small => 120,
        WebcamSize::Medium => 160,
        WebcamSize::Large => 200,
    };
    (base, base + CONTROL_BAR_HEIGHT + CONTROL_GAP)
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
    /// Creates window and starts JPEG preview service for browser-based rendering.
    pub async fn show_async(&self, app: AppHandle, device_index: usize) -> Result<(), String> {
        // Check if already showing
        {
            let guard = self.preview.lock();
            if guard.is_some() {
                log::info!("[PREVIEW_MANAGER] Preview already showing");
                return Ok(());
            }
        }

        // Clean up any stale state first
        self.cleanup_stale(&app);

        let settings = self.settings.lock().clone();
        let (width, height) = get_preview_size(settings.size);

        log::info!(
            "[PREVIEW_MANAGER] Creating preview window (device={}, size={}x{})",
            device_index,
            width,
            height
        );

        // Start JPEG preview service FIRST (camera feed + JPEG conversion)
        start_preview(device_index)?;

        // Small delay to ensure first frame is available
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Create window (visible immediately - browser will poll for JPEG frames)
        let window = WebviewWindowBuilder::new(
            &app,
            "webcam-preview",
            tauri::WebviewUrl::App("/webcam-preview.html".into()),
        )
        .title("Webcam Preview")
        .inner_size(width as f64, height as f64)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .transparent(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(true)
        .position(100.0, 100.0)
        .build()
        .map_err(|e| format!("Failed to create preview window: {}", e))?;

        log::info!("[PREVIEW_MANAGER] Window created, JPEG preview service running");

        // Exclude window from screen capture so it doesn't appear in recordings
        #[cfg(target_os = "windows")]
        {
            use crate::commands::window::exclude_window_from_capture;
            if let Err(e) = exclude_window_from_capture(&window) {
                log::warn!("[PREVIEW_MANAGER] Failed to exclude from capture: {}", e);
            } else {
                log::info!("[PREVIEW_MANAGER] Window excluded from screen capture");
            }
        }

        // Note: Window region removed - CSS border-radius handles visual rounding
        // and the control bar needs to be fully visible above the preview

        // Store active preview state
        {
            let mut guard = self.preview.lock();
            *guard = Some(ActivePreview {
                device_index,
                showing: Arc::new(AtomicBool::new(true)),
            });
        }

        log::info!(
            "[PREVIEW_MANAGER] Preview shown (device={}, size={}x{})",
            device_index,
            width,
            height
        );

        Ok(())
    }

    /// Clean up stale preview state before creating new window
    fn cleanup_stale(&self, app: &AppHandle) {
        let mut guard = self.preview.lock();
        if guard.take().is_some() {
            log::warn!("[PREVIEW_MANAGER] Cleaning up stale preview before creating new one");
            stop_preview();
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

            // Stop preview service first
            stop_preview();

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
            stop_preview();
            log::info!("[PREVIEW_MANAGER] Preview closed externally");
        }
    }

    /// Update preview settings without recreating the window.
    pub fn update_preview_settings(
        &self,
        _app: &AppHandle,
        size: WebcamSize,
        shape: WebcamShape,
        mirror: bool,
    ) {
        let mut settings = self.settings.lock();
        settings.size = size;
        settings.shape = shape;
        settings.mirror = mirror;
        // Note: Window region removed - CSS border-radius handles visual rounding
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

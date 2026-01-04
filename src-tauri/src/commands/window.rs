// Allow unused helpers - keeping for potential future use
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

// Recording border window label (legacy, kept for compatibility)
const RECORDING_BORDER_LABEL: &str = "recording-border";

// Capture toolbar window label
const CAPTURE_TOOLBAR_LABEL: &str = "capture-toolbar";

// Track if main window was visible before capture started
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Close recording border window (not toolbar - it persists)
fn close_recording_border_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        let _ = window.close();
    }
}

/// Close all capture-related windows including toolbar
fn close_all_capture_windows(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        let _ = window.close();
    }
    close_recording_border_window(app);
}

/// Restore main window if it was visible before capture started
fn restore_main_if_visible(app: &AppHandle) {
    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("library") {
            let _ = main_window.show();
        }
    }
}

// ============================================================================
// Physical Coordinate Helpers
// ============================================================================
// Windows APIs return physical (pixel) coordinates. Tauri's builder methods
// use logical coordinates which don't match on scaled displays.
// These helpers ensure windows are positioned/sized using physical coordinates.

/// Position a window using physical (pixel) coordinates.
/// Use this when you have screen coordinates from Windows APIs.
fn set_physical_position(window: &tauri::WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| format!("Failed to set position: {}", e))
}

/// Resize a window using physical (pixel) dimensions.
/// Use this when you have dimensions from Windows APIs.
fn set_physical_size(window: &tauri::WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }))
        .map_err(|e| format!("Failed to set size: {}", e))
}

/// Position and resize a window using physical (pixel) coordinates.
/// Convenience wrapper for set_physical_position + set_physical_size.
fn set_physical_bounds(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    set_physical_position(window, x, y)?;
    set_physical_size(window, width, height)
}

/// Apply DWM blur-behind transparency to a window.
/// This uses a tiny off-screen blur region trick (from PowerToys) to get
/// DWM-composited transparency without WS_EX_LAYERED, avoiding hardware video blackout.
#[cfg(target_os = "windows")]
pub fn apply_dwm_transparency(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND,
    };
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, HRGN};
    use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
    use windows::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN;

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        // Create a tiny region way off-screen (PowerToys trick)
        // This enables DWM blur/transparency without actually blurring anything visible
        let pos = -GetSystemMetrics(SM_CXVIRTUALSCREEN) - 8;
        let hrgn: HRGN = CreateRectRgn(pos, 0, pos + 1, 1);

        if hrgn.is_invalid() {
            return Err("Failed to create region".to_string());
        }

        let blur_behind = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
            fEnable: true.into(),
            hRgnBlur: hrgn,
            fTransitionOnMaximized: false.into(),
        };

        let result = DwmEnableBlurBehindWindow(HWND(hwnd.0), &blur_behind);

        // Clean up the region
        let _ = DeleteObject(hrgn);

        result.map_err(|e| format!("Failed to enable blur behind: {:?}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_dwm_transparency(_window: &tauri::WebviewWindow) -> Result<(), String> {
    // DWM is Windows-only, use regular transparency on other platforms
    Ok(())
}

/// Apply Windows 11 native rounded corners to a window.
/// This makes the OS clip the window to a rounded rectangle, eliminating
/// the rectangular background issue with WebView2 transparent windows.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn apply_rounded_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE};

    // DWMWCP_ROUND = 2 (standard rounded corners)
    // DWMWCP_ROUNDSMALL = 3 (smaller rounded corners)
    const DWMWCP_ROUND: i32 = 2;

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        let preference = DWMWCP_ROUND;
        DwmSetWindowAttribute(
            HWND(hwnd.0),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
        .map_err(|e| format!("Failed to set rounded corners: {:?}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_rounded_corners(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Trigger the capture overlay - uses DirectComposition overlay for all capture types.
/// capture_type: "screenshot", "video", or "gif"
///
/// Uses DirectComposition overlay to avoid blackout issues with hardware-accelerated
/// video content. This works for all capture types (screenshot, video, gif).
pub fn trigger_capture(app: &AppHandle, capture_type: Option<&str>) -> Result<(), String> {
    log::info!(
        "[trigger_capture] Called with capture_type: {:?}",
        capture_type
    );

    // Convert to owned String early to avoid lifetime issues with thread spawn
    let ct = capture_type.unwrap_or("screenshot").to_string();

    // Track if main window was visible (but don't hide it - user may want to capture it)
    if let Some(main_window) = app.get_webview_window("library") {
        let was_visible = main_window.is_visible().unwrap_or(false);
        MAIN_WAS_VISIBLE.store(was_visible, Ordering::SeqCst);
        // Don't hide main window - user may want to capture their own app
    }

    // Clone capture type as owned String for use in spawned thread
    let is_gif = ct == "gif";
    let ct_for_thread = ct.clone();

    // Launch DirectComposition overlay in background
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[window] Failed to create async runtime: {}", e);
                // Restore main window before returning since we hid it earlier
                if let Some(main_window) = app_clone.get_webview_window("library") {
                    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                        let _ = main_window.show();
                    }
                }
                return;
            },
        };
        rt.block_on(async {
            use crate::commands::capture_overlay::{OverlayAction, OverlayResult};
            
            match crate::commands::capture_overlay::show_capture_overlay(app_clone.clone(), None, Some(ct_for_thread), None, None, None).await {
                Ok(Some(result)) => {
                    let OverlayResult { x, y, width, height, action, window_id } = result;

                    match action {
                        OverlayAction::StartRecording => {
                            // Start recording flow
                            // The toolbar was created by show_toolbar in wndproc.rs
                            // We need to show the recording border separately
                            if let Err(e) = show_recording_border(app_clone.clone(), x, y, width, height).await {
                                log::error!("Failed to show recording border: {}", e);
                            }
                            
                            // Determine format based on capture type
                            let format = if is_gif {
                                crate::commands::video_recording::RecordingFormat::Gif
                            } else {
                                crate::commands::video_recording::RecordingFormat::Mp4
                            };
                            
                            // Emit format to the controls window
                            let format_str = if is_gif { "gif" } else { "mp4" };
                            let _ = app_clone.emit("recording-format", format_str);
                            
                            // Get countdown setting
                            let countdown_secs = crate::commands::video_recording::get_countdown_secs();
                            
                            // Show countdown overlay window if countdown is enabled
                            if countdown_secs > 0 {
                                if let Err(e) = show_countdown_window(app_clone.clone(), x, y, width, height).await {
                                    log::error!("Failed to show countdown window: {}", e);
                                }
                            }
                            
                            // Get recording settings from global state (set by frontend)
                            let system_audio_enabled = crate::commands::video_recording::get_system_audio_enabled();
                            let fps = crate::commands::video_recording::get_fps();
                            let quality = crate::commands::video_recording::get_quality();
                            let include_cursor = crate::commands::video_recording::get_include_cursor();
                            let max_duration_secs = crate::commands::video_recording::get_max_duration_secs();

                            // Start the recording with the selected region
                            let quick_capture = crate::commands::video_recording::get_quick_capture();
                            let settings = crate::commands::video_recording::RecordingSettings {
                                format,
                                mode: crate::commands::video_recording::RecordingMode::Region {
                                    x, y, width, height
                                },
                                fps,
                                max_duration_secs,
                                include_cursor,
                                audio: crate::commands::video_recording::AudioSettings {
                                    capture_system_audio: system_audio_enabled,
                                    microphone_device_index: crate::commands::video_recording::get_microphone_device_index(),
                                },
                                quality,
                                gif_quality_preset: crate::commands::video_recording::get_gif_quality_preset(),
                                countdown_secs,
                                quick_capture,
                            };
                            
                            if let Err(e) = crate::commands::video_recording::recorder::start_recording(
                                app_clone.clone(), settings.clone(), 
                                crate::commands::video_recording::generate_output_path(&settings)
                                    .unwrap_or_else(|_| std::env::temp_dir().join(format!("recording.{}", format_str)))
                            ).await {
                                log::error!("Failed to start recording: {}", e);
                                // Close toolbar window and restore main window on error
                                if let Some(toolbar) = app_clone.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
                                    let _ = toolbar.close();
                                }
                                if let Some(main_window) = app_clone.get_webview_window("library") {
                                    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                        let _ = main_window.show();
                                    }
                                }
                            }
                        }
                        OverlayAction::CaptureScreenshot => {
                            // Screenshot flow - close all windows, capture, open editor
                            close_all_capture_windows(&app_clone);

                            // Use window capture if a window was selected, otherwise region capture
                            let capture_result = if let Some(hwnd) = window_id {
                                log::debug!("[CAPTURE] Using window capture for hwnd={}", hwnd);
                                crate::commands::capture::capture_window_fast(hwnd).await
                            } else {
                                log::debug!("[CAPTURE] Using region capture: x={}, y={}, w={}, h={}", x, y, width, height);
                                let selection = crate::commands::capture::ScreenRegionSelection {
                                    x, y, width, height,
                                };
                                crate::commands::capture::capture_screen_region_fast(selection).await
                            };

                            match capture_result {
                                Ok(result) => {
                                    // Open editor with the captured image
                                    if let Err(e) = crate::commands::window::open_editor_fast(
                                        app_clone.clone(),
                                        result.file_path,
                                        result.width,
                                        result.height,
                                    ).await {
                                        log::error!("Failed to open editor: {}", e);
                                        restore_main_if_visible(&app_clone);
                                    }
                                }
                                Err(e) => {
                                    log::error!("Failed to capture screenshot: {}", e);
                                    restore_main_if_visible(&app_clone);
                                }
                            }
                        }
                        OverlayAction::Cancelled => {
                            // User cancelled - close recording border only (toolbar persists)
                            close_recording_border_window(&app_clone);
                            restore_main_if_visible(&app_clone);
                        }
                    }
                }
                Ok(None) => {
                    // Cancelled (no selection made) - toolbar persists, just restore main
                    close_recording_border_window(&app_clone);
                    restore_main_if_visible(&app_clone);
                }
                Err(e) => {
                    log::error!("Capture overlay error: {}", e);
                    close_recording_border_window(&app_clone);
                    restore_main_if_visible(&app_clone);
                }
            }
        });
    });

    Ok(())
}

#[command]
pub async fn show_overlay(app: AppHandle, capture_type: Option<String>) -> Result<(), String> {
    trigger_capture(&app, capture_type.as_deref())
}

#[command]
pub async fn hide_overlay(app: AppHandle, restore_main_window: Option<bool>) -> Result<(), String> {
    // Restore main window if it was visible before capture started
    // Default to true for backward compatibility (screenshots)
    // Pass false when starting video recording to keep main window hidden
    let should_restore = restore_main_window.unwrap_or(true);
    if should_restore && MAIN_WAS_VISIBLE.swap(false, Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("library") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }

    Ok(())
}

/// Restore the main window (call this when video recording completes)
#[command]
pub async fn restore_main_window(app: AppHandle) -> Result<(), String> {
    // Check if main was visible before capture started
    if MAIN_WAS_VISIBLE.swap(false, Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("library") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }
    Ok(())
}

/// Show the library window (always shows, regardless of previous state)
#[command]
pub async fn show_library_window(app: AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("library") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    Ok(())
}

/// Open editor with a file path to raw RGBA data.
/// This is used with fast capture commands to skip PNG encoding on the Rust side.
/// The frontend will handle conversion to displayable format using browser APIs.
#[command]
pub async fn open_editor_fast(
    app: AppHandle,
    file_path: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Close all overlays and restore main window (this is for screenshots)
    hide_overlay(app.clone(), None).await?;

    // Show main window with the capture file path
    if let Some(main_window) = app.get_webview_window("library") {
        let _ = main_window.unminimize();

        main_window
            .show()
            .map_err(|e| format!("Failed to show main window: {}", e))?;

        let _ = main_window.request_user_attention(Some(tauri::UserAttentionType::Informational));

        main_window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        // Emit a different event for fast capture with file path
        let payload = serde_json::json!({
            "file_path": file_path,
            "width": width,
            "height": height,
        });

        main_window
            .emit("capture-complete-fast", payload)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}

/// Exclude a window from screen capture using Windows API.
/// This prevents the window from appearing in screenshots and screen recordings.
#[cfg(target_os = "windows")]
fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get HWND: {}", e))?;

    unsafe {
        SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE)
            .map_err(|e| format!("Failed to set display affinity: {:?}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn exclude_window_from_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    // Not supported on non-Windows platforms
    Ok(())
}

/// Show the recording border window (synchronous version for internal use).
pub fn show_recording_border_sync(
    app: &AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    show_recording_border_impl(app.clone(), x, y, width, height)
}

/// Show the recording border window around the recording region.
/// This is a transparent click-through window that shows a border to indicate
/// what area is being recorded. The window is excluded from screen capture
/// so it won't appear in recordings.
///
/// Parameters:
/// - x, y: Top-left corner of the recording region (screen coordinates)
/// - width, height: Dimensions of the recording region
#[command]
pub async fn show_recording_border(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    show_recording_border_impl(app, x, y, width, height)
}

fn show_recording_border_impl(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // No padding - position window exactly at the recording region
    // The border will be drawn at the exact edge of the recording area
    let window_x = x;
    let window_y = y;
    let window_width = width;
    let window_height = height;

    // Check if window already exists
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        // Window exists - reposition and resize it using physical coordinates
        let _ = set_physical_bounds(&window, window_x, window_y, window_width, window_height);
        window
            .show()
            .map_err(|e| format!("Failed to show recording border: {}", e))?;
        window
            .set_always_on_top(true)
            .map_err(|e| format!("Failed to set always on top: {}", e))?;
        return Ok(());
    }

    // Create the window
    let url = WebviewUrl::App("recording-border.html".into());

    let window = WebviewWindowBuilder::new(&app, RECORDING_BORDER_LABEL, url)
        .title("")
        .inner_size(window_width as f64, window_height as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false) // Start hidden, position first
        .focused(false) // Don't steal focus from user's work
        .build()
        .map_err(|e| format!("Failed to create recording border window: {}", e))?;

    // Set position/size using physical coordinates to match recording coordinates
    set_physical_bounds(&window, window_x, window_y, window_width, window_height)?;

    // CRITICAL: Exclude window from screen capture so it doesn't appear in recordings
    // TEMPORARILY DISABLED FOR MARKETING SCREENSHOTS
    exclude_window_from_capture(&window)?;

    // Apply DWM blur-behind for true transparency on Windows
    if let Err(e) = apply_dwm_transparency(&window) {
        log::warn!("Failed to apply DWM transparency to border: {}", e);
    }

    // Make it click-through so users can interact with the content below
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("Failed to set ignore cursor events: {}", e))?;

    // Now show the window
    window
        .show()
        .map_err(|e| format!("Failed to show window: {}", e))?;

    // Ensure always on top
    window
        .set_always_on_top(true)
        .map_err(|e| format!("Failed to set always on top: {}", e))?;

    Ok(())
}

/// Hide the recording border window.
#[command]
pub async fn hide_recording_border(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close recording border: {}", e))?;
    }
    Ok(())
}

// Toolbar positioning is now handled by frontend (CaptureToolbarWindow.tsx)
// Frontend measures content and calculates position dynamically

/// Create the capture toolbar window (hidden).
/// Frontend will measure content, calculate position, and call set_capture_toolbar_bounds to show.
/// This allows frontend to fully control sizing/positioning without hardcoded dimensions.
///
/// If selection bounds are provided, emits `confirm-selection` event to the window.
#[command]
pub async fn show_capture_toolbar(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Check if window already exists
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        // Emit confirm-selection to update bounds and mark selection confirmed
        let _ = window.emit(
            "confirm-selection",
            serde_json::json!({
                "x": x, "y": y, "width": width, "height": height
            }),
        );
        window
            .show()
            .map_err(|e| format!("Failed to show toolbar: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus toolbar: {}", e))?;
        return Ok(());
    }

    // No URL params - toolbar always starts in startup state
    let url = WebviewUrl::App("capture-toolbar.html".into());

    // Create window hidden - frontend will configure size/position and show it
    // Uses custom titlebar like the main library window (decorations: false, transparent: true)
    let window = WebviewWindowBuilder::new(&app, CAPTURE_TOOLBAR_LABEL, url)
        .title("SnapIt Capture")
        .transparent(true)
        .decorations(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false) // Auto-resized by frontend
        .shadow(true)
        .visible(false) // Hidden until frontend configures bounds
        .focused(false)
        .build()
        .map_err(|e| format!("Failed to create capture toolbar window: {}", e))?;

    // Fixed toolbar size: 1280x144px
    let toolbar_width = 1280u32;
    let toolbar_height = 144u32;
    let initial_x = x + (width as i32 / 2) - (toolbar_width as i32 / 2);
    let initial_y = y + height as i32 + 8; // Below selection

    set_physical_bounds(&window, initial_x, initial_y, toolbar_width, toolbar_height)?;

    // Emit confirm-selection after a short delay to ensure frontend is ready
    let app_clone = app.clone();
    let bounds = serde_json::json!({ "x": x, "y": y, "width": width, "height": height });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        if let Some(window) = app_clone.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
            let _ = window.emit("confirm-selection", bounds);
        }
    });

    Ok(())
}

/// Update the capture toolbar with new selection dimensions.
/// Emits event to frontend which handles repositioning.
#[command]
pub async fn update_capture_toolbar(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) else {
        return Ok(());
    };

    // Emit selection update - frontend will reposition
    let _ = window.emit(
        "selection-updated",
        serde_json::json!({
            "x": x, "y": y, "width": width, "height": height
        }),
    );

    // Ensure toolbar stays on top
    let _ = window.set_always_on_top(true);

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = SetWindowPos(
                    HWND(hwnd.0),
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }

    Ok(())
}

/// Hide the capture toolbar window (does NOT close it).
#[command]
pub async fn hide_capture_toolbar(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        window
            .hide()
            .map_err(|e| format!("Failed to hide capture toolbar: {}", e))?;
    }
    Ok(())
}

/// Close the capture toolbar window (actually destroys it).
#[command]
pub async fn close_capture_toolbar(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close capture toolbar: {}", e))?;
    }
    Ok(())
}

/// Show and bring the capture toolbar to front.
#[command]
pub async fn bring_capture_toolbar_to_front(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) else {
        return Ok(());
    };

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
            SWP_SHOWWINDOW, SW_RESTORE, SW_SHOW,
        };

        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = ShowWindow(HWND(hwnd.0), SW_RESTORE);
                let _ = ShowWindow(HWND(hwnd.0), SW_SHOW);
                let _ = SetWindowPos(
                    HWND(hwnd.0),
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
                let _ = SetForegroundWindow(HWND(hwnd.0));
            }
        }
    }

    window
        .show()
        .map_err(|e| format!("Failed to show toolbar: {}", e))?;
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus toolbar: {}", e))?;

    Ok(())
}

/// Resize the capture toolbar window based on actual content size.
/// Called by frontend after measuring rendered content via getBoundingClientRect().
/// Frontend sends CSS pixels (logical), so we use Logical size to match.
#[command]
pub async fn resize_capture_toolbar(app: AppHandle, width: u32, height: u32) -> Result<(), String> {
    const MAX_WIDTH: u32 = 1280;

    let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) else {
        return Ok(());
    };

    // Clamp width to max
    let width = width.min(MAX_WIDTH);

    // Use Logical size since frontend sends CSS pixels from getBoundingClientRect()
    // This ensures the window size matches the content size at any DPI scaling
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: width as f64,
            height: height as f64,
        }))
        .map_err(|e| format!("Failed to set size: {}", e))?;

    Ok(())
}

/// Set capture toolbar bounds (position + size) and show the window.
/// Called by frontend after measuring content and calculating position.
/// This allows frontend to fully control toolbar layout without hardcoded dimensions.
/// Set only the position of the capture toolbar (preserves current size)
#[command]
pub async fn set_capture_toolbar_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) else {
        return Ok(());
    };

    // Get current size
    let size = window
        .outer_size()
        .map_err(|e| format!("Failed to get size: {}", e))?;

    // Set position only (preserve size)
    set_physical_bounds(&window, x, y, size.width, size.height)?;

    Ok(())
}

#[command]
pub async fn set_capture_toolbar_bounds(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) else {
        return Ok(());
    };

    // Set position and size using physical coordinates
    set_physical_bounds(&window, x, y, width, height)?;

    // Ensure window is visible and on top
    window
        .show()
        .map_err(|e| format!("Failed to show toolbar: {}", e))?;
    window
        .set_always_on_top(true)
        .map_err(|e| format!("Failed to set always on top: {}", e))?;

    // Re-apply DWM transparency
    if let Err(e) = apply_dwm_transparency(&window) {
        log::warn!("Failed to apply DWM transparency: {}", e);
    }

    // Bring toolbar to front and focus it
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE,
            SWP_NOSIZE, SWP_SHOWWINDOW,
        };

        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let hwnd = HWND(hwnd.0);
                // Set as topmost
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
                // Bring to top of Z-order
                let _ = BringWindowToTop(hwnd);
                // Set as foreground window (gives keyboard focus)
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }

    Ok(())
}

/// Set whether the capture toolbar should ignore cursor events (click-through).
/// NOTE: This is now a no-op since toolbar uses decorations (title bar).
/// Kept for API compatibility.
#[command]
pub async fn set_capture_toolbar_ignore_cursor(
    _app: AppHandle,
    _ignore: bool,
) -> Result<(), String> {
    // No-op: toolbar now has decorations, no click-through needed
    Ok(())
}

// ============================================================================
// Countdown Window
// ============================================================================

const COUNTDOWN_WINDOW_LABEL: &str = "countdown";

/// Show the countdown overlay window during recording countdown.
/// The window is transparent, click-through, and displays a centered countdown number.
/// Window size matches the recording region exactly (physical coordinates).
#[command]
pub async fn show_countdown_window(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Close existing window if any
    if let Some(window) = app.get_webview_window(COUNTDOWN_WINDOW_LABEL) {
        let _ = window.close();
    }

    let url = WebviewUrl::App("countdown.html".into());

    let window = WebviewWindowBuilder::new(&app, COUNTDOWN_WINDOW_LABEL, url)
        .title("Countdown")
        .inner_size(width as f64, height as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false) // Start hidden, position first
        .build()
        .map_err(|e| format!("Failed to create countdown window: {}", e))?;

    // Use physical coordinates to match the recording region exactly
    set_physical_bounds(&window, x, y, width, height)?;

    // Make click-through
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("Failed to set cursor events: {}", e))?;

    // Apply DWM blur-behind for true transparency on Windows
    if let Err(e) = apply_dwm_transparency(&window) {
        log::warn!("Failed to apply DWM transparency to countdown: {}", e);
    }

    // Now show the window
    window
        .show()
        .map_err(|e| format!("Failed to show window: {}", e))?;

    // Exclude from capture
    // TEMPORARILY DISABLED FOR MARKETING SCREENSHOTS
    // let _ = exclude_window_from_capture(&window);

    Ok(())
}

/// Hide the countdown window.
#[command]
pub async fn hide_countdown_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(COUNTDOWN_WINDOW_LABEL) {
        window
            .close()
            .map_err(|e| format!("Failed to close countdown window: {}", e))?;
    }
    Ok(())
}

// ============================================================================
// Startup Toolbar (shown on app launch)
// ============================================================================

/// Show the startup toolbar window (floating, centered on primary monitor).
/// This is the main toolbar shown on app startup for initiating captures.
/// Different from capture toolbar which appears during region selection.
#[command]
pub async fn show_startup_toolbar(app: AppHandle) -> Result<(), String> {
    log::info!("[show_startup_toolbar] Called");

    // Check if window already exists
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        log::info!("[show_startup_toolbar] Window already exists, showing it");
        window
            .show()
            .map_err(|e| format!("Failed to show toolbar: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus toolbar: {}", e))?;
        return Ok(());
    }

    log::info!("[show_startup_toolbar] Window does not exist, creating new one");

    // Get primary monitor info for centering
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?;

    let primary_monitor = monitors
        .into_iter()
        .next()
        .ok_or_else(|| "No monitors found".to_string())?;

    let monitor_pos = primary_monitor.position();
    let monitor_size = primary_monitor.size();

    // No URL params - toolbar starts in startup state by default
    let url = WebviewUrl::App("capture-toolbar.html".into());

    // Fixed toolbar size: 1280x144px
    let initial_width = 1280u32;
    let initial_height = 144u32;

    // Position at bottom-center of primary monitor
    let x = monitor_pos.x + (monitor_size.width as i32 - initial_width as i32) / 2;
    let y = monitor_pos.y + monitor_size.height as i32 - initial_height as i32 - 100; // 100px from bottom

    log::info!(
        "[show_startup_toolbar] Creating window at position ({}, {}) with size {}x{}",
        x,
        y,
        initial_width,
        initial_height
    );

    // Create window - visible immediately, frontend will resize after measuring
    // Uses custom titlebar like the main library window (decorations: false, transparent: true)
    let window = WebviewWindowBuilder::new(&app, CAPTURE_TOOLBAR_LABEL, url)
        .title("SnapIt Capture")
        .transparent(true)
        .decorations(false)
        .maximizable(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .resizable(false) // Auto-resized by frontend
        .shadow(true)
        .visible(true) // Show immediately - frontend will resize after measuring
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to create startup toolbar window: {}", e))?;

    log::info!("[show_startup_toolbar] Window created successfully");

    // Set position/size using physical coordinates
    set_physical_bounds(&window, x, y, initial_width, initial_height)?;

    // Show the window immediately - frontend will resize it after measuring content
    // This ensures the window appears even if frontend has timing issues
    window
        .show()
        .map_err(|e| format!("Failed to show toolbar: {}", e))?;
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus toolbar: {}", e))?;

    log::info!("[show_startup_toolbar] Window shown and focused");

    Ok(())
}

/// Hide the startup toolbar (used when starting a capture).
#[command]
pub async fn hide_startup_toolbar(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        window
            .hide()
            .map_err(|e| format!("Failed to hide toolbar: {}", e))?;
    }
    Ok(())
}

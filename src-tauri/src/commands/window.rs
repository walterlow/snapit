use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::capture::fallback::get_monitors;

// Recording border window label (legacy, kept for compatibility)
const RECORDING_BORDER_LABEL: &str = "recording-border";

// Capture toolbar window label (legacy, kept for compatibility)
const CAPTURE_TOOLBAR_LABEL: &str = "capture-toolbar";

// Unified capture controls window - combines border + toolbar in single fullscreen WebView
const CAPTURE_CONTROLS_LABEL: &str = "capture-controls";

// Track if main window was visible before capture started
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Close all capture-related windows (unified controls and legacy separate windows)
fn close_capture_windows(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_CONTROLS_LABEL) {
        let _ = window.close();
    }
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        let _ = window.close();
    }
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        let _ = window.close();
    }
}

/// Restore main window if it was visible before capture started
fn restore_main_if_visible(app: &AppHandle) {
    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("main") {
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
    window.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition { x, y }
    )).map_err(|e| format!("Failed to set position: {}", e))
}

/// Resize a window using physical (pixel) dimensions.
/// Use this when you have dimensions from Windows APIs.
fn set_physical_size(window: &tauri::WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    window.set_size(tauri::Size::Physical(
        tauri::PhysicalSize { width, height }
    )).map_err(|e| format!("Failed to set size: {}", e))
}

/// Position and resize a window using physical (pixel) coordinates.
/// Convenience wrapper for set_physical_position + set_physical_size.
fn set_physical_bounds(window: &tauri::WebviewWindow, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    set_physical_position(window, x, y)?;
    set_physical_size(window, width, height)
}

/// Apply DWM blur-behind transparency to a window.
/// This uses a tiny off-screen blur region trick (from PowerToys) to get
/// DWM-composited transparency without WS_EX_LAYERED, avoiding hardware video blackout.
#[cfg(target_os = "windows")]
fn apply_dwm_transparency(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmEnableBlurBehindWindow, DWM_BLURBEHIND, DWM_BB_ENABLE, DWM_BB_BLURREGION};
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, HRGN};
    use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
    use windows::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN;
    
    let hwnd = window.hwnd().map_err(|e| format!("Failed to get HWND: {}", e))?;
    
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
fn apply_dwm_transparency(_window: &tauri::WebviewWindow) -> Result<(), String> {
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
    
    let hwnd = window.hwnd().map_err(|e| format!("Failed to get HWND: {}", e))?;
    
    unsafe {
        let preference = DWMWCP_ROUND;
        DwmSetWindowAttribute(
            HWND(hwnd.0),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        ).map_err(|e| format!("Failed to set rounded corners: {:?}", e))?;
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
    // Convert to owned String early to avoid lifetime issues with thread spawn
    let ct = capture_type.unwrap_or("screenshot").to_string();
    
    // Hide main window first
    if let Some(main_window) = app.get_webview_window("main") {
        let was_visible = main_window.is_visible().unwrap_or(false);
        MAIN_WAS_VISIBLE.store(was_visible, Ordering::SeqCst);
        let _ = main_window.hide();
    }
    
    // Clone capture type as owned String for use in spawned thread
    let is_gif = ct == "gif";
    let ct_for_thread = ct.clone();
    
    // Launch DirectComposition overlay in background
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            use crate::commands::capture_overlay::{OverlayAction, OverlayResult};
            
            match crate::commands::capture_overlay::show_capture_overlay(app_clone.clone(), None, Some(ct_for_thread)).await {
                Ok(Some(result)) => {
                    let OverlayResult { x, y, width, height, action } = result;
                    
                    match action {
                        OverlayAction::StartRecording => {
                            // Start recording flow
                            // The unified capture-controls window handles both border and toolbar
                            // (created by show_toolbar in wndproc.rs when selection was finalized)
                            
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
                                    eprintln!("Failed to show countdown window: {}", e);
                                }
                            }
                            
                            // Get system audio setting
                            let system_audio_enabled = crate::commands::video_recording::get_system_audio_enabled();
                            
                            // Start the recording with the selected region
                            let settings = crate::commands::video_recording::RecordingSettings {
                                format,
                                mode: crate::commands::video_recording::RecordingMode::Region {
                                    x, y, width, height
                                },
                                fps: 30,
                                max_duration_secs: None,
                                include_cursor: true,
                                audio: crate::commands::video_recording::AudioSettings {
                                    capture_system_audio: system_audio_enabled,
                                    capture_microphone: false,
                                },
                                quality: 80,
                                countdown_secs,
                            };
                            
                            if let Err(e) = crate::commands::video_recording::recorder::start_recording(
                                app_clone.clone(), settings.clone(), 
                                crate::commands::video_recording::generate_output_path(&settings)
                                    .unwrap_or_else(|_| std::env::temp_dir().join("recording.mp4"))
                            ).await {
                                eprintln!("Failed to start recording: {}", e);
                                // Close controls window and restore main window on error
                                if let Some(controls) = app_clone.get_webview_window(CAPTURE_CONTROLS_LABEL) {
                                    let _ = controls.close();
                                }
                                // Also try legacy window names
                                if let Some(toolbar) = app_clone.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
                                    let _ = toolbar.close();
                                }
                                if let Some(main_window) = app_clone.get_webview_window("main") {
                                    if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                        let _ = main_window.show();
                                    }
                                }
                            }
                        }
                        OverlayAction::CaptureScreenshot => {
                            // Screenshot flow - close controls, capture region, open editor
                            close_capture_windows(&app_clone);
                            
                            // Capture the region
                            let selection = crate::commands::capture::ScreenRegionSelection {
                                x, y, width, height,
                            };
                            
                            match crate::commands::capture::capture_screen_region_fast(selection).await {
                                Ok(result) => {
                                    // Open editor with the captured image
                                    if let Err(e) = crate::commands::window::open_editor_fast(
                                        app_clone.clone(),
                                        result.file_path,
                                        result.width,
                                        result.height,
                                    ).await {
                                        eprintln!("Failed to open editor: {}", e);
                                        restore_main_if_visible(&app_clone);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Failed to capture screenshot: {}", e);
                                    restore_main_if_visible(&app_clone);
                                }
                            }
                        }
                        OverlayAction::Cancelled => {
                            // User cancelled - close windows and restore main
                            close_capture_windows(&app_clone);
                            restore_main_if_visible(&app_clone);
                        }
                    }
                }
                Ok(None) => {
                    // Cancelled (no selection made) - restore main window
                    close_capture_windows(&app_clone);
                    restore_main_if_visible(&app_clone);
                }
                Err(e) => {
                    eprintln!("DComp overlay error: {}", e);
                    close_capture_windows(&app_clone);
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
        if let Some(main_window) = app.get_webview_window("main") {
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
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }
    Ok(())
}

#[command]
pub async fn open_editor(app: AppHandle, image_data: String) -> Result<(), String> {
    // Close all overlays and restore main window (this is for screenshots)
    hide_overlay(app.clone(), None).await?;

    // Show main window with the captured image
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.unminimize();

        main_window
            .show()
            .map_err(|e| format!("Failed to show main window: {}", e))?;

        let _ = main_window.request_user_attention(Some(tauri::UserAttentionType::Informational));

        main_window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        main_window
            .emit("capture-complete", &image_data)
            .map_err(|e| format!("Failed to emit event: {}", e))?;
    }

    Ok(())
}

/// Fast open_editor variant that accepts a file path to raw RGBA data.
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
    if let Some(main_window) = app.get_webview_window("main") {
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
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    
    let hwnd = window.hwnd().map_err(|e| format!("Failed to get HWND: {}", e))?;
    
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
        window.show().map_err(|e| format!("Failed to show recording border: {}", e))?;
        window.set_always_on_top(true).map_err(|e| format!("Failed to set always on top: {}", e))?;
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
    // exclude_window_from_capture(&window)?;
    
    // Apply DWM blur-behind for true transparency on Windows
    if let Err(e) = apply_dwm_transparency(&window) {
        eprintln!("Warning: Failed to apply DWM transparency to border: {}", e);
    }

    // Make it click-through so users can interact with the content below
    window.set_ignore_cursor_events(true)
        .map_err(|e| format!("Failed to set ignore cursor events: {}", e))?;

    // Now show the window
    window.show().map_err(|e| format!("Failed to show window: {}", e))?;

    // Ensure always on top
    window.set_always_on_top(true)
        .map_err(|e| format!("Failed to set always on top: {}", e))?;

    Ok(())
}

/// Hide the recording border window.
#[command]
pub async fn hide_recording_border(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        window.close().map_err(|e| format!("Failed to close recording border: {}", e))?;
    }
    Ok(())
}

// Generous toolbar window dimensions - large enough for any content + shadows
// Content centers via CSS, transparent areas are invisible
const TOOLBAR_WINDOW_WIDTH: i32 = 900;
const TOOLBAR_WINDOW_HEIGHT: i32 = 160;
const TOOLBAR_MARGIN: i32 = 8;

/// Calculate toolbar position based on selection and monitor bounds.
/// Positions toolbar centered below selection, with fallbacks for edge cases.
fn calculate_toolbar_position(
    sel_x: i32,
    sel_y: i32,
    sel_width: u32,
    sel_height: u32,
    mon_x: i32,
    mon_y: i32,
    mon_width: u32,
    mon_height: u32,
) -> (i32, i32) {
    let sel_center_x = sel_x + (sel_width as i32) / 2;
    let sel_bottom = sel_y + sel_height as i32;
    let mon_right = mon_x + mon_width as i32;
    let mon_bottom = mon_y + mon_height as i32;
    
    // Default: centered below selection
    let mut pos_x = sel_center_x - TOOLBAR_WINDOW_WIDTH / 2;
    let mut pos_y = sel_bottom + TOOLBAR_MARGIN;
    
    // Check if toolbar would be off-screen at bottom
    if pos_y + TOOLBAR_WINDOW_HEIGHT > mon_bottom - TOOLBAR_MARGIN {
        // Try placing above selection
        let above_y = sel_y - TOOLBAR_WINDOW_HEIGHT - TOOLBAR_MARGIN;
        if above_y >= mon_y + TOOLBAR_MARGIN {
            pos_y = above_y;
        } else {
            // Place inside selection at bottom
            pos_y = sel_bottom - TOOLBAR_WINDOW_HEIGHT - 20;
        }
    }
    
    // Clamp horizontal position to monitor bounds
    if pos_x < mon_x + TOOLBAR_MARGIN {
        pos_x = mon_x + TOOLBAR_MARGIN;
    } else if pos_x + TOOLBAR_WINDOW_WIDTH > mon_right - TOOLBAR_MARGIN {
        pos_x = mon_right - TOOLBAR_MARGIN - TOOLBAR_WINDOW_WIDTH;
    }
    
    // Final vertical clamp
    let min_y = mon_y + TOOLBAR_MARGIN;
    let max_y = mon_bottom - TOOLBAR_MARGIN - TOOLBAR_WINDOW_HEIGHT;
    pos_y = pos_y.max(min_y).min(max_y);
    
    (pos_x, pos_y)
}

/// Show the capture toolbar window.
/// Uses fixed window size with CSS-centered content for instant, flicker-free appearance.
/// Rust calculates position and shows window immediately - no frontend round-trips.
#[command]
pub async fn show_capture_toolbar(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Get monitor info for positioning
    let monitors = get_monitors().unwrap_or_default();
    
    // Find which monitor contains the selection center
    let sel_center_x = x + (width as i32) / 2;
    let sel_center_y = y + (height as i32) / 2;
    
    let current_monitor = monitors.iter().find(|m| {
        sel_center_x >= m.x && sel_center_x < m.x + m.width as i32 &&
        sel_center_y >= m.y && sel_center_y < m.y + m.height as i32
    });
    
    // Calculate position
    let (pos_x, pos_y) = if let Some(mon) = current_monitor {
        calculate_toolbar_position(x, y, width, height, mon.x, mon.y, mon.width, mon.height)
    } else {
        // Fallback: centered below selection
        (x + (width as i32) / 2 - TOOLBAR_WINDOW_WIDTH / 2, y + height as i32 + TOOLBAR_MARGIN)
    };
    
    // Check if window already exists
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        // Reposition existing window using physical coordinates
        let _ = set_physical_position(&window, pos_x, pos_y);
        window.set_always_on_top(true).map_err(|e| format!("Failed to set always on top: {}", e))?;
        
        // Emit selection update for dimension display
        let _ = window.emit("selection-updated", serde_json::json!({
            "x": x, "y": y, "width": width, "height": height
        }));
        return Ok(());
    }

    // URL with selection dimensions for the dimension badge
    let url = WebviewUrl::App(
        format!("capture-toolbar.html?x={}&y={}&width={}&height={}", x, y, width, height).into()
    );
    
    let window = WebviewWindowBuilder::new(&app, CAPTURE_TOOLBAR_LABEL, url)
        .title("Selection Toolbar")
        .inner_size(TOOLBAR_WINDOW_WIDTH as f64, TOOLBAR_WINDOW_HEIGHT as f64)
        .position(pos_x as f64, pos_y as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(true) // Show immediately - no flicker
        .focused(false)
        .build()
        .map_err(|e| format!("Failed to create capture toolbar window: {}", e))?;

    // Apply DWM blur-behind for true transparency on Windows
    if let Err(e) = apply_dwm_transparency(&window) {
        eprintln!("Warning: Failed to apply DWM transparency to toolbar: {}", e);
    }

    Ok(())
}

/// Update the capture toolbar with new selection dimensions.
/// Rust handles repositioning directly - no frontend round-trips.
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
    
    // Get monitor info for positioning
    let monitors = get_monitors().unwrap_or_default();
    let sel_center_x = x + (width as i32) / 2;
    let sel_center_y = y + (height as i32) / 2;
    
    let current_monitor = monitors.iter().find(|m| {
        sel_center_x >= m.x && sel_center_x < m.x + m.width as i32 &&
        sel_center_y >= m.y && sel_center_y < m.y + m.height as i32
    });
    
    // Calculate and set new position
    let (pos_x, pos_y) = if let Some(mon) = current_monitor {
        calculate_toolbar_position(x, y, width, height, mon.x, mon.y, mon.width, mon.height)
    } else {
        (x + (width as i32) / 2 - TOOLBAR_WINDOW_WIDTH / 2, y + height as i32 + TOOLBAR_MARGIN)
    };
    
    let _ = set_physical_position(&window, pos_x, pos_y);
    
    // Emit selection update for dimension display only
    let _ = window.emit("selection-updated", serde_json::json!({
        "x": x, "y": y, "width": width, "height": height
    }));
    
    // Ensure toolbar stays on top
    let _ = window.set_always_on_top(true);
    
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};
        
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = SetWindowPos(
                    HWND(hwnd.0),
                    HWND_TOPMOST,
                    0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
                );
            }
        }
    }
    
    Ok(())
}

/// Hide the DirectComposition overlay toolbar window.
#[command]
pub async fn hide_capture_toolbar(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        window.close().map_err(|e| format!("Failed to close dcomp toolbar: {}", e))?;
    }
    Ok(())
}

// ============================================================================
// Unified Capture Controls Window
// ============================================================================

/// Show the unified capture controls window.
/// This is a single fullscreen transparent WebView that contains both:
/// - Recording border (CSS positioned, pointer-events: none)
/// - Toolbar (CSS positioned, receives clicks)
/// 
/// No window sizing complexity - just CSS positioning in a fullscreen window.
#[command]
pub async fn show_capture_controls(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Get virtual screen bounds (all monitors)
    let (vs_x, vs_y, vs_w, vs_h) = get_virtual_screen_bounds();
    
    // Get monitor info for toolbar positioning
    let monitors = get_monitors().unwrap_or_default();
    let sel_center_x = x + (width as i32) / 2;
    let sel_center_y = y + (height as i32) / 2;
    
    let current_monitor = monitors.iter().find(|m| {
        sel_center_x >= m.x && sel_center_x < m.x + m.width as i32 &&
        sel_center_y >= m.y && sel_center_y < m.y + m.height as i32
    });
    
    let mon_params = if let Some(mon) = current_monitor {
        format!("&monX={}&monY={}&monW={}&monH={}", mon.x, mon.y, mon.width, mon.height)
    } else {
        format!("&monX={}&monY={}&monW={}&monH={}", vs_x, vs_y, vs_w, vs_h)
    };
    
    // Close existing window if any
    if let Some(window) = app.get_webview_window(CAPTURE_CONTROLS_LABEL) {
        let _ = window.close();
    }
    
    // Also close legacy windows if they exist
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        let _ = window.close();
    }
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        let _ = window.close();
    }

    // URL with selection + monitor + virtual screen info
    let url = WebviewUrl::App(
        format!("capture-controls.html?x={}&y={}&width={}&height={}{}&vsX={}&vsY={}&vsW={}&vsH={}",
            x, y, width, height, mon_params, vs_x, vs_y, vs_w, vs_h).into()
    );
    
    let window = WebviewWindowBuilder::new(&app, CAPTURE_CONTROLS_LABEL, url)
        .title("Capture Controls")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false) // Start hidden, position first
        .focused(false)
        .build()
        .map_err(|e| format!("Failed to create capture controls window: {}", e))?;
    
    // Use physical coordinates to match screen coordinates from capture overlay
    set_physical_bounds(&window, vs_x, vs_y, vs_w, vs_h)?;
    
    // Now show
    window.show().map_err(|e| format!("Failed to show window: {}", e))?;

    // Apply DWM blur-behind for true transparency
    if let Err(e) = apply_dwm_transparency(&window) {
        eprintln!("Warning: Failed to apply DWM transparency: {}", e);
    }
    
    // Don't set ignore_cursor_events - let CSS handle it:
    // - Container has pointer-events: none (click-through for transparent areas)
    // - Toolbar wrapper has pointer-events: auto (receives clicks)

    Ok(())
}

/// Get virtual screen bounds (spans all monitors)
fn get_virtual_screen_bounds() -> (i32, i32, u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN};
    
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN) as u32;
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN) as u32;
        (x, y, width, height)
    }
}

/// Hide the capture controls window.
#[command]
pub async fn hide_capture_controls(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CAPTURE_CONTROLS_LABEL) {
        window.close().map_err(|e| format!("Failed to close capture controls: {}", e))?;
    }
    Ok(())
}

/// Update the capture controls with new selection (for repositioning during resize).
#[command]
pub async fn update_capture_controls(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAPTURE_CONTROLS_LABEL) else {
        return Ok(());
    };
    
    // Emit selection update to frontend
    let _ = window.emit("selection-updated", serde_json::json!({
        "x": x, "y": y, "width": width, "height": height
    }));
    
    Ok(())
}

// ============================================================================
// Countdown Window
// ============================================================================

const COUNTDOWN_WINDOW_LABEL: &str = "countdown";

/// Show the countdown overlay window during recording countdown.
/// The window is fullscreen, transparent, click-through, and displays a large countdown number.
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
    window.set_ignore_cursor_events(true)
        .map_err(|e| format!("Failed to set cursor events: {}", e))?;
    
    // Apply DWM blur-behind for true transparency on Windows
    if let Err(e) = apply_dwm_transparency(&window) {
        eprintln!("Warning: Failed to apply DWM transparency to countdown: {}", e);
    }
    
    // Now show the window
    window.show().map_err(|e| format!("Failed to show window: {}", e))?;

    // Exclude from capture
    // TEMPORARILY DISABLED FOR MARKETING SCREENSHOTS
    // let _ = exclude_window_from_capture(&window);

    Ok(())
}

/// Hide the countdown window.
#[command]
pub async fn hide_countdown_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(COUNTDOWN_WINDOW_LABEL) {
        window.close().map_err(|e| format!("Failed to close countdown window: {}", e))?;
    }
    Ok(())
}

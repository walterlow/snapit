use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::capture::fallback::get_monitors;

// Recording border window label
const RECORDING_BORDER_LABEL: &str = "recording-border";

// DirectComposition overlay toolbar window label
const DCOMP_TOOLBAR_LABEL: &str = "dcomp-toolbar";

// Track if main window was visible before capture started
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);



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
            use crate::commands::dcomp_overlay::{OverlayAction, OverlayResult};
            
            match crate::commands::dcomp_overlay::show_dcomp_video_overlay(app_clone.clone(), None, Some(ct_for_thread)).await {
                Ok(Some(result)) => {
                    let OverlayResult { x, y, width, height, action } = result;
                    
                    match action {
                        OverlayAction::StartRecording => {
                            // Start recording flow
                            // The dcomp-toolbar window stays open and handles recording controls
                            
                            // Show recording border around the selection
                            if let Err(e) = crate::commands::window::show_recording_border_sync(
                                &app_clone, x, y, width, height
                            ) {
                                eprintln!("Failed to show recording border: {}", e);
                            }
                            
                            // Determine format based on capture type
                            let format = if is_gif {
                                crate::commands::video_recording::RecordingFormat::Gif
                            } else {
                                crate::commands::video_recording::RecordingFormat::Mp4
                            };
                            
                            // Emit format to the toolbar so it displays the correct badge
                            let format_str = if is_gif { "gif" } else { "mp4" };
                            let _ = app_clone.emit("recording-format", format_str);
                            
                            // Get countdown setting (set by frontend via set_recording_countdown command)
                            let countdown_secs = crate::commands::video_recording::get_countdown_secs();
                            
                            // Show countdown overlay window if countdown is enabled
                            if countdown_secs > 0 {
                                if let Err(e) = show_countdown_window(app_clone.clone(), x, y, width, height).await {
                                    eprintln!("Failed to show countdown window: {}", e);
                                }
                            }
                            
                            // Start the recording with the selected region
                            let settings = crate::commands::video_recording::RecordingSettings {
                                format,
                                mode: crate::commands::video_recording::RecordingMode::Region {
                                    x, y, width, height
                                },
                                fps: 30,
                                max_duration_secs: None,
                                include_cursor: true,
                                audio: crate::commands::video_recording::AudioSettings::default(),
                                quality: 80,
                                countdown_secs,
                            };
                            
                            if let Err(e) = crate::commands::video_recording::recorder::start_recording(
                                app_clone.clone(), settings.clone(), 
                                crate::commands::video_recording::generate_output_path(&settings)
                                    .unwrap_or_else(|_| std::env::temp_dir().join("recording.mp4"))
                            ).await {
                                eprintln!("Failed to start recording: {}", e);
                                // Close toolbar and restore main window on error
                                if let Some(toolbar) = app_clone.get_webview_window(DCOMP_TOOLBAR_LABEL) {
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
                            // Screenshot flow - close toolbar, capture region, open editor
                            if let Some(toolbar) = app_clone.get_webview_window(DCOMP_TOOLBAR_LABEL) {
                                let _ = toolbar.close();
                            }
                            
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
                                        // Restore main window on error
                                        if let Some(main_window) = app_clone.get_webview_window("main") {
                                            if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                                let _ = main_window.show();
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Failed to capture screenshot: {}", e);
                                    // Restore main window on error
                                    if let Some(main_window) = app_clone.get_webview_window("main") {
                                        if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                            let _ = main_window.show();
                                        }
                                    }
                                }
                            }
                        }
                        OverlayAction::Cancelled => {
                            // User cancelled - close toolbar and restore main window
                            if let Some(toolbar) = app_clone.get_webview_window(DCOMP_TOOLBAR_LABEL) {
                                let _ = toolbar.close();
                            }
                            if let Some(main_window) = app_clone.get_webview_window("main") {
                                if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                    let _ = main_window.show();
                                }
                            }
                        }
                    }
                }
                Ok(None) => {
                    // Cancelled (no selection made) - restore main window
                    if let Some(toolbar) = app_clone.get_webview_window(DCOMP_TOOLBAR_LABEL) {
                        let _ = toolbar.close();
                    }
                    if let Some(main_window) = app_clone.get_webview_window("main") {
                        if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                            let _ = main_window.show();
                        }
                    }
                }
                Err(e) => {
                    eprintln!("DComp overlay error: {}", e);
                    // Restore main window on error
                    if let Some(toolbar) = app_clone.get_webview_window(DCOMP_TOOLBAR_LABEL) {
                        let _ = toolbar.close();
                    }
                    if let Some(main_window) = app_clone.get_webview_window("main") {
                        if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                            let _ = main_window.show();
                        }
                    }
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
    // Add padding around the border so the border itself is visible outside the recording region
    // Use larger padding to account for scale factors and ensure border is definitely outside
    let border_padding = 6;
    let window_x = x - border_padding;
    let window_y = y - border_padding;
    let window_width = width + (border_padding as u32 * 2);
    let window_height = height + (border_padding as u32 * 2);

    // Check if window already exists
    if let Some(window) = app.get_webview_window(RECORDING_BORDER_LABEL) {
        // Window exists - reposition and resize it using physical coordinates
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition { x: window_x, y: window_y }
        ));
        let _ = window.set_size(tauri::Size::Physical(
            tauri::PhysicalSize { width: window_width, height: window_height }
        ));
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

    // Set position using physical coordinates to match recording coordinates
    window.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition { x: window_x, y: window_y }
    )).map_err(|e| format!("Failed to set position: {}", e))?;
    
    window.set_size(tauri::Size::Physical(
        tauri::PhysicalSize { width: window_width, height: window_height }
    )).map_err(|e| format!("Failed to set size: {}", e))?;

    // CRITICAL: Exclude window from screen capture so it doesn't appear in recordings
    exclude_window_from_capture(&window)?;
    
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

/// Show the DirectComposition overlay toolbar window.
/// Creates the window if it doesn't exist, or repositions and shows it if hidden.
/// 
/// Parameters:
/// - x: X position of the selection region (screen coordinates)
/// - y: Y position (bottom) of the selection region (screen coordinates)
/// - width: Width of the selection region
/// - height: Height of the selection region (used to calculate toolbar position)
#[command]
pub async fn show_dcomp_toolbar(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Initial window dimensions - generous size to let frontend toolbar render naturally
    // Frontend will measure content and call resize_dcomp_toolbar to fit exactly
    // Extra space is transparent and click-through until resize happens
    let window_width: i32 = 600;
    let window_height: i32 = 80;

    // Get monitors to detect fullscreen and find alternate monitor
    let monitors = get_monitors().unwrap_or_default();
    
    // Calculate selection center and bottom for positioning
    let sel_center_x = x + (width as i32) / 2;
    let sel_center_y = y + (height as i32) / 2;
    let sel_bottom = y + height as i32;
    
    // Find which monitor contains the selection center
    let current_monitor = monitors.iter().find(|m| {
        sel_center_x >= m.x && sel_center_x < m.x + m.width as i32 &&
        sel_center_y >= m.y && sel_center_y < m.y + m.height as i32
    });
    
    // Check if selection is fullscreen (covers >90% of monitor)
    let is_fullscreen = if let Some(mon) = current_monitor {
        width >= (mon.width * 9 / 10) && height >= (mon.height * 9 / 10)
    } else {
        false
    };
    
    // Calculate toolbar position - centered horizontally below selection
    let toolbar_x = sel_center_x - window_width / 2;
    
    let (mut pos_x, mut pos_y) = if is_fullscreen {
        // For fullscreen, try to find alternate monitor
        let alternate = monitors.iter().find(|m| {
            if let Some(curr) = current_monitor {
                m.x != curr.x || m.y != curr.y
            } else {
                false
            }
        });
        
        if let Some(alt_mon) = alternate {
            // Place in center of alternate monitor
            (
                alt_mon.x + (alt_mon.width as i32 - window_width) / 2,
                alt_mon.y + (alt_mon.height as i32 - window_height) / 2
            )
        } else {
            // No alternate monitor, place at bottom center inside selection
            (toolbar_x, sel_bottom - window_height - 60)
        }
    } else {
        // Normal selection: place below selection, horizontally centered
        (toolbar_x, sel_bottom + 12)
    };
    
    // Bounds checking: ensure toolbar is fully visible on current monitor
    if let Some(mon) = current_monitor {
        let mon_right = mon.x + mon.width as i32;
        let mon_bottom = mon.y + mon.height as i32;
        let margin = 8; // Small margin from screen edges
        
        // Check if toolbar would be off-screen at the bottom
        if pos_y + window_height > mon_bottom - margin {
            // Try placing above the selection instead
            let above_y = y - window_height - 12;
            if above_y >= mon.y + margin {
                pos_y = above_y;
            } else {
                // Can't fit above either, place inside selection at bottom
                pos_y = sel_bottom - window_height - 20;
            }
        }
        
        // Clamp horizontal position to screen bounds
        if pos_x < mon.x + margin {
            pos_x = mon.x + margin;
        } else if pos_x + window_width > mon_right - margin {
            pos_x = mon_right - window_width - margin;
        }
        
        // Final safety check: ensure toolbar is at least partially visible
        pos_y = pos_y.max(mon.y + margin).min(mon_bottom - window_height - margin);
    }
    
    // Check if window already exists
    if let Some(window) = app.get_webview_window(DCOMP_TOOLBAR_LABEL) {
        // Window exists - reposition and show it
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition { x: pos_x, y: pos_y }
        ));
        window.show().map_err(|e| format!("Failed to show dcomp toolbar: {}", e))?;
        window.set_always_on_top(true).map_err(|e| format!("Failed to set always on top: {}", e))?;
        window.set_focus().map_err(|e| format!("Failed to focus dcomp toolbar: {}", e))?;
        return Ok(());
    }

    // Create the window with dimensions in URL params
    let url = WebviewUrl::App(
        format!("dcomp-toolbar.html?width={}&height={}", width, height).into()
    );
    
    let window = WebviewWindowBuilder::new(&app, DCOMP_TOOLBAR_LABEL, url)
        .title("Selection Toolbar")
        .inner_size(window_width as f64, window_height as f64)
        .position(pos_x as f64, pos_y as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(true)
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to create dcomp toolbar window: {}", e))?;

    // Exclude from capture so it doesn't appear in recordings
    let _ = exclude_window_from_capture(&window);
    
    // Apply DWM blur-behind for true transparency on Windows
    if let Err(e) = apply_dwm_transparency(&window) {
        eprintln!("Warning: Failed to apply DWM transparency to toolbar: {}", e);
    }
    
    // Note: Rounded corners disabled for testing square layout
    // if let Err(e) = apply_rounded_corners(&window) {
    //     eprintln!("Warning: Failed to apply rounded corners: {}", e);
    // }

    // Ensure always on top
    window.set_always_on_top(true).map_err(|e| format!("Failed to set always on top: {}", e))?;
    window.set_focus().map_err(|e| format!("Failed to focus dcomp toolbar: {}", e))?;

    Ok(())
}

/// Update the DirectComposition overlay toolbar position and dimensions.
/// This is called during resize to update the toolbar in real-time.
#[command]
pub async fn update_dcomp_toolbar(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Window dimensions - use generous defaults for positioning calculations
    // Frontend controls actual size via resize_dcomp_toolbar
    let window_width: i32 = 600;
    let window_height: i32 = 80;

    // Position toolbar centered below the selection
    let selection_bottom = y + height as i32;
    let sel_center_x = x + (width as i32) / 2;
    let mut pos_x = sel_center_x - window_width / 2;
    let mut pos_y = selection_bottom + 12; // 12px below selection
    
    // Get monitors for bounds checking
    let monitors = get_monitors().unwrap_or_default();
    let sel_center_y = y + (height as i32) / 2;
    
    // Find which monitor contains the selection center
    let current_monitor = monitors.iter().find(|m| {
        sel_center_x >= m.x && sel_center_x < m.x + m.width as i32 &&
        sel_center_y >= m.y && sel_center_y < m.y + m.height as i32
    });
    
    // Bounds checking: ensure toolbar is fully visible on current monitor
    if let Some(mon) = current_monitor {
        let mon_right = mon.x + mon.width as i32;
        let mon_bottom = mon.y + mon.height as i32;
        let margin = 8;
        
        // Check if toolbar would be off-screen at the bottom
        if pos_y + window_height > mon_bottom - margin {
            // Try placing above the selection instead
            let above_y = y - window_height - 12;
            if above_y >= mon.y + margin {
                pos_y = above_y;
            } else {
                // Can't fit above either, place inside selection at bottom
                pos_y = selection_bottom - window_height - 20;
            }
        }
        
        // Clamp horizontal position to screen bounds
        if pos_x < mon.x + margin {
            pos_x = mon.x + margin;
        } else if pos_x + window_width > mon_right - margin {
            pos_x = mon_right - window_width - margin;
        }
        
        // Final safety check
        pos_y = pos_y.max(mon.y + margin).min(mon_bottom - window_height - margin);
    }

    if let Some(window) = app.get_webview_window(DCOMP_TOOLBAR_LABEL) {
        // Reposition the toolbar
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition { x: pos_x, y: pos_y }
        ));
        
        // Emit dimensions update to the toolbar window
        let _ = window.emit("dcomp-toolbar-dimensions", serde_json::json!({
            "width": width,
            "height": height
        }));
        
        // Bring toolbar to front (it might have gone behind the overlay)
        let _ = window.set_always_on_top(true);
        
        // Use Win32 API to ensure it's truly on top
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
    }
    
    Ok(())
}

/// Hide the DirectComposition overlay toolbar window.
#[command]
pub async fn hide_dcomp_toolbar(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DCOMP_TOOLBAR_LABEL) {
        window.close().map_err(|e| format!("Failed to close dcomp toolbar: {}", e))?;
    }
    Ok(())
}

/// Resize the DirectComposition overlay toolbar window.
/// Called by frontend after measuring its content size.
#[command]
pub async fn resize_dcomp_toolbar(
    app: AppHandle,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DCOMP_TOOLBAR_LABEL) {
        window.set_size(tauri::Size::Physical(
            tauri::PhysicalSize { width, height }
        )).map_err(|e| format!("Failed to resize toolbar: {}", e))?;
    }
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
    window.set_position(tauri::Position::Physical(
        tauri::PhysicalPosition { x, y }
    )).map_err(|e| format!("Failed to set position: {}", e))?;
    
    window.set_size(tauri::Size::Physical(
        tauri::PhysicalSize { width, height }
    )).map_err(|e| format!("Failed to set size: {}", e))?;

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
    let _ = exclude_window_from_capture(&window);

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

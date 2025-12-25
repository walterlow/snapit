use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::capture::fallback::get_monitors;

// Recording controls window label
const RECORDING_CONTROLS_LABEL: &str = "recording-controls";

// Recording border window label
const RECORDING_BORDER_LABEL: &str = "recording-border";

// DirectComposition overlay toolbar window label
const DCOMP_TOOLBAR_LABEL: &str = "dcomp-toolbar";

// Track if main window was visible before capture started
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

// Track if capture is currently in progress (overlays are showing)
static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// Track if overlays have been pre-created
static OVERLAYS_CREATED: AtomicBool = AtomicBool::new(false);

// Store overlay window labels for reuse
static OVERLAY_LABELS: Mutex<Vec<String>> = Mutex::new(Vec::new());

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

/// Pre-create overlay windows at startup (hidden) for instant show later.
/// Uses DWM-based transparency instead of WS_EX_LAYERED to avoid hardware video blackout.
pub fn precreate_overlays(app: &AppHandle) -> Result<(), String> {
    if OVERLAYS_CREATED.load(Ordering::SeqCst) {
        return Ok(());
    }

    let monitors = get_monitors().map_err(|e| format!("Failed to get monitors: {}", e))?;
    let mut labels = OVERLAY_LABELS.lock().unwrap();
    labels.clear();

    for (idx, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay_{}", idx);

        let x = monitor.x as f64;
        let y = monitor.y as f64;
        let width = monitor.width as f64;
        let height = monitor.height as f64;
        let scale = monitor.scale_factor;

        let url = WebviewUrl::App(
            format!(
                "overlay.html?monitor={}&x={}&y={}&width={}&height={}&scale={}",
                idx, monitor.x, monitor.y, monitor.width, monitor.height, scale
            )
            .into(),
        );

        // Use transparent(true) for proper alpha blending.
        // We also apply DWM blur-behind which may help with hardware video composition.
        let window = WebviewWindowBuilder::new(app, &label, url)
            .title("")
            .inner_size(width, height)
            .position(x, y)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false) // Start hidden!
            .build()
            .map_err(|e| format!("Failed to create overlay: {}", e))?;

        // Apply DWM blur-behind (may help with hardware video composition)
        if let Err(e) = apply_dwm_transparency(&window) {
            eprintln!("Warning: Failed to apply DWM blur-behind to overlay {}: {}", idx, e);
        }

        // Move off-screen initially
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition { x: -10000, y: -10000 }
        ));

        labels.push(label);
    }

    OVERLAYS_CREATED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Trigger the capture overlay - just show pre-created windows (fast!)
/// capture_type: "screenshot", "video", or "gif"
/// 
/// For video/gif capture, uses DirectComposition overlay to avoid blackout issues
/// with hardware-accelerated video content.
pub fn trigger_capture(app: &AppHandle, capture_type: Option<&str>) -> Result<(), String> {
    let ct = capture_type.unwrap_or("screenshot");
    
    // For video/gif, use DirectComposition overlay to avoid video blackout
    if ct == "video" || ct == "gif" {
        // Hide main window first
        if let Some(main_window) = app.get_webview_window("main") {
            let was_visible = main_window.is_visible().unwrap_or(false);
            MAIN_WAS_VISIBLE.store(was_visible, Ordering::SeqCst);
            let _ = main_window.hide();
        }
        
        // Launch DirectComposition overlay in background
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                match crate::commands::dcomp_overlay::show_dcomp_video_overlay(app_clone.clone(), None).await {
                    Ok(Some((_x, _y, _width, _height))) => {
                        // Selection confirmed - the overlay already emitted events
                        // The React toolbar handles the next steps
                    }
                    Ok(None) => {
                        // Cancelled - restore main window
                        if let Some(main_window) = app_clone.get_webview_window("main") {
                            if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                let _ = main_window.show();
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("DComp overlay error: {}", e);
                        // Restore main window on error
                        if let Some(main_window) = app_clone.get_webview_window("main") {
                            if MAIN_WAS_VISIBLE.load(Ordering::SeqCst) {
                                let _ = main_window.show();
                            }
                        }
                    }
                }
            });
        });
        
        return Ok(());
    }
    
    let monitors = get_monitors().map_err(|e| format!("Failed to get monitors: {}", e))?;
    let current_monitor_count = monitors.len();

    // Check if we need to recreate overlays (monitor count changed or not created yet)
    let labels = OVERLAY_LABELS.lock().unwrap();
    let existing_overlay_count = labels.len();
    drop(labels); // Release lock before potential recreation

    if !OVERLAYS_CREATED.load(Ordering::SeqCst) || existing_overlay_count != current_monitor_count {
        // Close any existing overlays first
        let labels = OVERLAY_LABELS.lock().unwrap();
        for label in labels.iter() {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
        drop(labels);

        // Reset the flag and recreate
        OVERLAYS_CREATED.store(false, Ordering::SeqCst);
        precreate_overlays(app)?;
    }

    let labels = OVERLAY_LABELS.lock().unwrap();

    // Only track main window visibility if we're starting a NEW capture session
    // This prevents overwriting the saved state if trigger_capture is called multiple times
    if !CAPTURE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        // This is a new capture session - save the current main window visibility
        if let Some(main_window) = app.get_webview_window("main") {
            let was_visible = main_window.is_visible().unwrap_or(false);
            MAIN_WAS_VISIBLE.store(was_visible, Ordering::SeqCst);
            let _ = main_window.hide();
        }
    }

    // Show and position pre-created overlays (fast - no window creation!)
    for (idx, label) in labels.iter().enumerate() {
        if let Some(window) = app.get_webview_window(label) {
            if let Some(monitor) = monitors.get(idx) {
                // Reset overlay state BEFORE showing to avoid flash of old content
                // Include capture type so overlay knows what mode to start in
                let payload = serde_json::json!({ "captureType": ct });
                let _ = window.emit("reset-overlay", payload);

                let _ = window.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition { x: monitor.x, y: monitor.y }
                ));
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                // No matching monitor - ensure overlay is hidden
                let _ = window.hide();
            }
        }
    }

    Ok(())
}

/// Flush DWM compositor to ensure window position changes are rendered
#[cfg(target_os = "windows")]
fn flush_compositor() {
    use windows::Win32::Graphics::Dwm::DwmFlush;
    unsafe {
        // DwmFlush waits for the next vertical blank and ensures all pending
        // composition operations are completed before returning
        let _ = DwmFlush();
    }
}

#[cfg(not(target_os = "windows"))]
fn flush_compositor() {
    // No-op on non-Windows platforms
}

/// Move all overlays off-screen (instant, synchronous) - call before capture
#[command]
pub async fn move_overlays_offscreen(app: AppHandle) -> Result<(), String> {
    let labels = OVERLAY_LABELS.lock().unwrap();

    for label in labels.iter() {
        if let Some(window) = app.get_webview_window(label) {
            // Move way off screen - this is instant and synchronous
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition { x: -10000, y: -10000 }
            ));
        }
    }

    // Flush DWM compositor to ensure the position change is rendered
    flush_compositor();

    // Minimal delay for GPU to process
    std::thread::sleep(std::time::Duration::from_millis(8));

    Ok(())
}

#[command]
pub async fn show_overlay(app: AppHandle, capture_type: Option<String>) -> Result<(), String> {
    trigger_capture(&app, capture_type.as_deref())
}

#[command]
pub async fn hide_overlay(app: AppHandle, restore_main_window: Option<bool>) -> Result<(), String> {
    // Hide overlays
    let labels = OVERLAY_LABELS.lock().unwrap();
    for label in labels.iter() {
        if let Some(window) = app.get_webview_window(label) {
            // Move off-screen and hide
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition { x: -10000, y: -10000 }
            ));
            let _ = window.hide();
        }
    }
    drop(labels);

    // Mark capture as no longer in progress
    CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);

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

/// Show the recording controls window.
/// Creates the window if it doesn't exist, or shows it if hidden.
/// 
/// Parameters:
/// - x: X position for bottom-center of the recording region (screen coordinates)
/// - y: Y position for bottom of the recording region (screen coordinates)
/// - region_width: Width of the recording region (to center the controls)
#[command]
pub async fn show_recording_controls(
    app: AppHandle,
    x: Option<i32>,
    y: Option<i32>,
    region_width: Option<i32>,
) -> Result<(), String> {
    // Window dimensions
    let window_width: f64 = 280.0;
    let window_height: f64 = 52.0;

    // Calculate position
    let (pos_x, pos_y) = if let (Some(region_x), Some(region_y), Some(r_width)) = (x, y, region_width) {
        // Position at bottom-center of the region, with some offset below the region
        let center_x = region_x + (r_width / 2) - (window_width as i32 / 2);
        let below_y = region_y + 16; // 16px below the region bottom
        (center_x, below_y)
    } else {
        // Fallback: position at top-center of primary monitor
        let monitors = get_monitors().map_err(|e| format!("Failed to get monitors: {}", e))?;
        let primary = monitors.iter().find(|m| m.is_primary)
            .or_else(|| monitors.first())
            .ok_or("No monitors found")?;

        let monitor_width = primary.width as i32;
        let monitor_x = primary.x;
        let monitor_y = primary.y;

        let center_x = monitor_x + (monitor_width / 2) - (window_width as i32 / 2);
        let top_y = monitor_y + 20;
        (center_x, top_y)
    };

    // Check if window already exists
    if let Some(window) = app.get_webview_window(RECORDING_CONTROLS_LABEL) {
        // Window exists - reposition and show it
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition { x: pos_x, y: pos_y }
        ));
        window.show().map_err(|e| format!("Failed to show recording controls: {}", e))?;
        window.set_always_on_top(true).map_err(|e| format!("Failed to set always on top: {}", e))?;
        window.set_focus().map_err(|e| format!("Failed to focus recording controls: {}", e))?;
        return Ok(());
    }

    // Create the window
    // CRITICAL: shadow(false) is REQUIRED on Windows for decorationless windows to receive mouse events
    // See: https://github.com/tauri-apps/tauri/issues/8519
    // transparent(true) allows the rounded corners in CSS to show through
    let url = WebviewUrl::App("recording-controls.html".into());
    
    let window = WebviewWindowBuilder::new(&app, RECORDING_CONTROLS_LABEL, url)
        .title("Recording")
        .inner_size(window_width, window_height)
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
        .map_err(|e| format!("Failed to create recording controls window: {}", e))?;

    // Ensure always on top is set (sometimes needs to be called after creation)
    window.set_always_on_top(true).map_err(|e| format!("Failed to set always on top: {}", e))?;
    window.set_focus().map_err(|e| format!("Failed to focus recording controls: {}", e))?;

    Ok(())
}

/// Hide the recording controls window.
#[command]
pub async fn hide_recording_controls(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(RECORDING_CONTROLS_LABEL) {
        window.close().map_err(|e| format!("Failed to close recording controls: {}", e))?;
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
    // Window dimensions - matches RecordingToolbar component size
    let window_width: i32 = 380;
    let window_height: i32 = 56;

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
    
    let (pos_x, pos_y) = if is_fullscreen {
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
    // Window dimensions - matches RecordingToolbar component size
    let window_width: f64 = 380.0;

    // Position toolbar centered below the selection
    let selection_bottom = y + height as i32;
    let pos_x = x + (width as i32 / 2) - (window_width as i32 / 2);
    let pos_y = selection_bottom + 12; // 12px below selection

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

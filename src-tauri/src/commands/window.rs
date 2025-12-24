use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, PhysicalPosition, PhysicalSize};
use xcap::Monitor;

// Recording controls window label
const RECORDING_CONTROLS_LABEL: &str = "recording-controls";

// Track if main window was visible before capture started
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

// Track if capture is currently in progress (overlays are showing)
static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// Track if overlays have been pre-created
static OVERLAYS_CREATED: AtomicBool = AtomicBool::new(false);

// Store overlay window labels for reuse
static OVERLAY_LABELS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Pre-create overlay windows at startup (hidden) for instant show later
pub fn precreate_overlays(app: &AppHandle) -> Result<(), String> {
    if OVERLAYS_CREATED.load(Ordering::SeqCst) {
        return Ok(());
    }

    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
    let mut labels = OVERLAY_LABELS.lock().unwrap();
    labels.clear();

    for (idx, monitor) in monitors.iter().enumerate() {
        let label = format!("overlay_{}", idx);

        let x = monitor.x().unwrap_or(0) as f64;
        let y = monitor.y().unwrap_or(0) as f64;
        let width = monitor.width().unwrap_or(1920) as f64;
        let height = monitor.height().unwrap_or(1080) as f64;
        let scale = monitor.scale_factor().unwrap_or(1.0);

        let url = WebviewUrl::App(
            format!(
                "overlay.html?monitor={}&x={}&y={}&width={}&height={}&scale={}",
                idx, x as i32, y as i32, width as u32, height as u32, scale
            )
            .into(),
        );

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
pub fn trigger_capture(app: &AppHandle, capture_type: Option<&str>) -> Result<(), String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
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

    // Determine capture type (default to screenshot)
    let ct = capture_type.unwrap_or("screenshot");

    // Show and position pre-created overlays (fast - no window creation!)
    for (idx, label) in labels.iter().enumerate() {
        if let Some(window) = app.get_webview_window(label) {
            if let Some(monitor) = monitors.get(idx) {
                let x = monitor.x().unwrap_or(0) as f64;
                let y = monitor.y().unwrap_or(0) as f64;

                // Reset overlay state BEFORE showing to avoid flash of old content
                // Include capture type so overlay knows what mode to start in
                let payload = serde_json::json!({ "captureType": ct });
                let _ = window.emit("reset-overlay", payload);

                let _ = window.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition { x: x as i32, y: y as i32 }
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
pub async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let labels = OVERLAY_LABELS.lock().unwrap();

    // Hide overlays instead of closing (fast - can reuse!)
    for label in labels.iter() {
        if let Some(window) = app.get_webview_window(label) {
            // Reset state before hiding to ensure clean state for next capture
            let _ = window.emit("reset-overlay", ());
            // Move off-screen and hide
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition { x: -10000, y: -10000 }
            ));
            let _ = window.hide();
        }
    }

    // Mark capture as no longer in progress
    CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);

    // Restore main window if it was visible before capture started
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
    // Close all overlays
    hide_overlay(app.clone()).await?;

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
    // Close all overlays
    hide_overlay(app.clone()).await?;

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
        let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
        let primary = monitors.iter().find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .ok_or("No monitors found")?;

        let monitor_width = primary.width().unwrap_or(1920) as i32;
        let monitor_x = primary.x().unwrap_or(0);
        let monitor_y = primary.y().unwrap_or(0);

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

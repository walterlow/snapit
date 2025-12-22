use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use xcap::Monitor;

// Track if main window was visible before capture started
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

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
pub fn trigger_capture(app: &AppHandle) -> Result<(), String> {
    let start = std::time::Instant::now();

    let monitors = Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;
    let current_monitor_count = monitors.len();

    // Check if we need to recreate overlays (monitor count changed or not created yet)
    let labels = OVERLAY_LABELS.lock().unwrap();
    let existing_overlay_count = labels.len();
    drop(labels); // Release lock before potential recreation

    if !OVERLAYS_CREATED.load(Ordering::SeqCst) || existing_overlay_count != current_monitor_count {
        println!("[TIMING] Overlays need (re)creation: existing={}, monitors={}",
            existing_overlay_count, current_monitor_count);

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
        let create_start = std::time::Instant::now();
        precreate_overlays(app)?;
        println!("[TIMING] Overlay recreation: {:?}", create_start.elapsed());
    }

    let labels = OVERLAY_LABELS.lock().unwrap();

    // Track if main window was visible before hiding it
    if let Some(main_window) = app.get_webview_window("main") {
        let was_visible = main_window.is_visible().unwrap_or(false);
        MAIN_WAS_VISIBLE.store(was_visible, Ordering::SeqCst);
        let _ = main_window.hide();
    }

    // Show and position pre-created overlays (fast - no window creation!)
    let show_start = std::time::Instant::now();
    for (idx, label) in labels.iter().enumerate() {
        if let Some(window) = app.get_webview_window(label) {
            if let Some(monitor) = monitors.get(idx) {
                let x = monitor.x().unwrap_or(0) as f64;
                let y = monitor.y().unwrap_or(0) as f64;

                // Reset overlay state BEFORE showing to avoid flash of old content
                let _ = window.emit("reset-overlay", ());

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
    println!("[TIMING] Show overlays: {:?} (count: {})", show_start.elapsed(), labels.len());
    println!("[TIMING] trigger_capture TOTAL: {:?}", start.elapsed());

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
    let start = std::time::Instant::now();
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
    let flush_start = std::time::Instant::now();
    flush_compositor();
    println!("[TIMING] DWM flush: {:?}", flush_start.elapsed());

    // Minimal delay for GPU to process
    std::thread::sleep(std::time::Duration::from_millis(8));
    println!("[TIMING] move_overlays_offscreen TOTAL: {:?}", start.elapsed());

    Ok(())
}

#[command]
pub async fn show_overlay(app: AppHandle) -> Result<(), String> {
    trigger_capture(&app)
}

#[command]
pub async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let start = std::time::Instant::now();
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

    // Restore main window if it was visible before capture started
    if MAIN_WAS_VISIBLE.swap(false, Ordering::SeqCst) {
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
        }
    }
    println!("[TIMING] hide_overlay: {:?}", start.elapsed());

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
    let start = std::time::Instant::now();

    // Close all overlays
    hide_overlay(app.clone()).await?;

    // Show main window with the capture file path
    let show_start = std::time::Instant::now();
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.unminimize();

        main_window
            .show()
            .map_err(|e| format!("Failed to show main window: {}", e))?;

        let _ = main_window.request_user_attention(Some(tauri::UserAttentionType::Informational));

        main_window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        println!("[TIMING] Show main window: {:?}", show_start.elapsed());

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
    println!("[TIMING] open_editor_fast TOTAL: {:?}", start.elapsed());

    Ok(())
}

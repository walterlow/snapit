//! Capture toolbar and startup toolbar commands.

use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::{apply_dwm_transparency, set_physical_bounds, CAPTURE_TOOLBAR_LABEL};

// ============================================================================
// Capture Toolbar
// ============================================================================

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

/// Set capture toolbar bounds (position + size) and show the window.
/// Called by frontend after measuring content and calculating position.
/// This allows frontend to fully control toolbar layout without hardcoded dimensions.
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
// Startup Toolbar
// ============================================================================

/// Show the startup toolbar window (floating, centered on primary monitor).
/// This is the main toolbar shown on app startup for initiating captures.
/// Different from capture toolbar which appears during region selection.
#[command]
pub async fn show_startup_toolbar(app: AppHandle) -> Result<(), String> {
    log::info!("[show_startup_toolbar] Called");

    // Check if window already exists
    if let Some(window) = app.get_webview_window(CAPTURE_TOOLBAR_LABEL) {
        log::info!("[show_startup_toolbar] Window already exists, bringing to front");

        // Use Windows API to forcefully bring window to front
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                BringWindowToTop, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_TOPMOST,
                SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE, SW_SHOW,
            };

            if let Ok(hwnd) = window.hwnd() {
                unsafe {
                    let hwnd = HWND(hwnd.0);
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    let _ = ShowWindow(hwnd, SW_SHOW);
                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                    );
                    let _ = BringWindowToTop(hwnd);
                    let _ = SetForegroundWindow(hwnd);
                }
            }
        }

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

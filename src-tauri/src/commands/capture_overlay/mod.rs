//! DirectComposition-based overlay for screen capture region selection.
//!
//! This module creates a transparent overlay using DirectComposition instead of
//! traditional WS_EX_LAYERED windows, which allows it to work with hardware-accelerated
//! video content without causing blackout issues.
//!
//! # Features
//!
//! - Window detection and highlighting (click to select window)
//! - Region selection with drag (drag to select custom region)
//! - Crosshair cursor display
//! - Semi-transparent overlay with clear selection area
//! - Resize handles for adjusting selection
//! - Multi-monitor support
//!
//! # Architecture
//!
//! ```text
//! mod.rs (public API)
//!   |
//!   +-- types.rs (types, enums, constants)
//!   +-- state.rs (overlay state management)
//!   +-- commands.rs (Tauri commands)
//!   +-- render.rs (Direct2D rendering)
//!   +-- wndproc.rs (Win32 message handling)
//!   +-- graphics/ (D3D11, D2D, DirectComposition)
//!   +-- input/ (hit-testing, window detection)
//! ```

pub mod commands;
mod graphics;
mod input;
mod render;
mod state;
pub mod types;
mod wndproc;

#[cfg(test)]
mod tests;

// Re-exports for public API
pub use types::{CaptureType, OverlayAction, OverlayMode, OverlayResult, SelectionEvent};

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use tauri::{command, AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, GetCursorPos, GetSystemMetrics,
    LoadCursorW, PeekMessageW, RegisterClassW, SetWindowLongPtrW, ShowWindow,
    CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, IDC_CROSS, MSG, PM_REMOVE,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SW_SHOW, WINDOW_EX_STYLE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

use commands::{clear_pending_command, take_pending_command, take_pending_dimensions};
use graphics::{compositor, d2d, d3d};
use state::{GraphicsState, MonitorInfo, OverlayState};
use types::*;
use wndproc::wnd_proc;

/// Track if the overlay window class has been registered
static OVERLAY_CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Track if an overlay is currently active (prevent multiple overlays)
static OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Track if preview overlay is active
static PREVIEW_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Signal to stop the preview overlay
static PREVIEW_SHOULD_STOP: AtomicBool = AtomicBool::new(false);

/// Show the capture overlay for region selection.
///
/// Spans the entire virtual screen (all monitors) for seamless multi-monitor support.
/// Uses DirectComposition to avoid video blackout issues.
///
/// # Arguments
/// * `app` - Tauri app handle
/// * `_monitor_index` - Ignored (legacy parameter, we now span all monitors)
/// * `capture_type` - "screenshot", "video", or "gif"
///   - Screenshot: immediately captures after selection (no toolbar)
///   - Video/GIF: shows toolbar for recording controls
/// * `source_mode` - "display", "window", or "region"
///   - Display: click on monitor to select entire display
///   - Window: click on window to select it
///   - Region: drag to select custom region (default)
/// * `preselect_monitor` - Optional monitor index to pre-select (skips interactive selection)
/// * `preselect_window` - Optional window HWND to pre-select (skips interactive selection)
///
/// # Returns
/// The selection result if confirmed, or None if cancelled
#[command]
pub async fn show_capture_overlay(
    app: AppHandle,
    _monitor_index: Option<usize>,
    capture_type: Option<String>,
    source_mode: Option<String>,
    preselect_monitor: Option<usize>,
    preselect_window: Option<isize>,
) -> Result<Option<OverlayResult>, String> {
    log::info!("[show_capture_overlay] Called with capture_type: {:?}, source_mode: {:?}, preselect_monitor: {:?}, preselect_window: {:?}", 
        capture_type, source_mode, preselect_monitor, preselect_window);
    
    let app_clone = app.clone();
    let ct = CaptureType::from_str(capture_type.as_deref().unwrap_or("video"));
    let mode = OverlayMode::from_str(source_mode.as_deref().unwrap_or("region"));

    // Get virtual screen bounds (spans all monitors)
    let (x, y, width, height) = get_virtual_screen_bounds();
    let bounds = Rect::from_xywh(x, y, width, height);
    log::info!("[show_capture_overlay] Virtual screen bounds: x={}, y={}, w={}, h={}", x, y, width, height);

    // Calculate pre-selection bounds if provided
    let preselect_bounds = if let Some(monitor_idx) = preselect_monitor {
        get_monitor_bounds(monitor_idx)
    } else if let Some(hwnd) = preselect_window {
        render::get_window_bounds_by_hwnd(hwnd)
    } else {
        None
    };
    
    log::info!("[show_capture_overlay] Preselect bounds: {:?}", preselect_bounds);

    tokio::task::spawn_blocking(move || run_overlay(app_clone, bounds, ct, mode, preselect_bounds))
        .await
        .map_err(|e| format!("Task failed: {:?}", e))?
}

/// Get bounds for a specific monitor by index
fn get_monitor_bounds(monitor_idx: usize) -> Option<Rect> {
    if let Ok(monitors) = xcap::Monitor::all() {
        if let Some(mon) = monitors.get(monitor_idx) {
            let x = mon.x().unwrap_or(0);
            let y = mon.y().unwrap_or(0);
            let w = mon.width().unwrap_or(1920) as i32;
            let h = mon.height().unwrap_or(1080) as i32;
            return Some(Rect::new(x, y, x + w, y + h));
        }
    }
    None
}

/// Get the virtual screen bounds (all monitors combined)
fn get_virtual_screen_bounds() -> (i32, i32, u32, u32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN) as u32,
            GetSystemMetrics(SM_CYVIRTUALSCREEN) as u32,
        )
    }
}

/// Run the overlay window and message loop.
fn run_overlay(
    app: AppHandle,
    bounds: Rect,
    capture_type: CaptureType,
    overlay_mode: OverlayMode,
    preselect_bounds: Option<Rect>,
) -> Result<Option<OverlayResult>, String> {
    log::info!("[run_overlay] Starting overlay for {:?} with mode {:?}, preselect: {:?}", capture_type, overlay_mode, preselect_bounds);
    
    // Prevent concurrent overlays
    if OVERLAY_ACTIVE.swap(true, Ordering::SeqCst) {
        log::warn!("[run_overlay] Overlay already active, returning None");
        return Ok(None);
    }

    // Guard to reset flag on exit
    struct ActiveGuard;
    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
    let _guard = ActiveGuard;

    // Clear any stale pending commands from previous overlay sessions
    clear_pending_command();

    // Register window class if needed
    register_overlay_class()?;

    unsafe {
        let hinstance = GetModuleHandleW(None)
            .map_err(|e| format!("Failed to get module handle: {:?}", e))?;

        let class_name: Vec<u16> = OVERLAY_CLASS_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // Create window with DirectComposition style
        let ex_style = WINDOW_EX_STYLE(
            WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0,
        );

        let hwnd = CreateWindowExW(
            ex_style,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_POPUP,
            bounds.left,
            bounds.top,
            bounds.width() as i32,
            bounds.height() as i32,
            None,
            None,
            hinstance,
            None,
        )
        .map_err(|e| format!("Failed to create window: {:?}", e))?;

        // Initialize graphics
        let d3d_device =
            d3d::create_device().map_err(|e| format!("Failed to create D3D11 device: {:?}", e))?;

        let swap_chain = d3d::create_swap_chain(&d3d_device, bounds.width(), bounds.height())
            .map_err(|e| format!("Failed to create swap chain: {:?}", e))?;

        let compositor_resources = compositor::create_compositor(&d3d_device, hwnd, &swap_chain)
            .map_err(|e| format!("Failed to create DirectComposition: {:?}", e))?;

        let d2d_resources = d2d::create_resources(&d3d_device)
            .map_err(|e| format!("Failed to create D2D resources: {:?}", e))?;

        // Get initial cursor position
        let mut cursor_pos = POINT::default();
        let _ = GetCursorPos(&mut cursor_pos);
        let initial_cursor_x = cursor_pos.x - bounds.left;
        let initial_cursor_y = cursor_pos.y - bounds.top;

        // Create state
        let monitor_info = MonitorInfo::new(bounds.left, bounds.top, bounds.width(), bounds.height());
        
        // If we have preselected bounds, convert to local coordinates and set up adjustment mode
        // Display/window preselection should be locked (no resize/move allowed)
        let adjustment = if let Some(presel) = preselect_bounds {
            let local_bounds = monitor_info.screen_rect_to_local(presel);
            let mut adj = state::AdjustmentState::default();
            adj.is_active = true;
            adj.is_locked = true; // Lock preselected display/window bounds
            adj.bounds = local_bounds;
            adj.original_bounds = local_bounds;
            log::info!("[run_overlay] Starting in locked adjustment mode with bounds: {:?}", local_bounds);
            adj
        } else {
            Default::default()
        };
        
        let mut state = Box::new(OverlayState {
            app_handle: app,
            capture_type,
            overlay_mode,
            hwnd,
            monitor: monitor_info,
            drag: Default::default(),
            adjustment,
            cursor: state::CursorState {
                position: types::Point::new(initial_cursor_x, initial_cursor_y),
                hovered_window: None,
            },
            graphics: Box::new(GraphicsState {
                swap_chain,
                comp_device: compositor_resources.device.clone(),
                compositor: compositor_resources,
                d2d: d2d_resources,
            }),
            should_close: false,
            last_emit_time: Instant::now(),
            result: Default::default(),
        });

        // Store state pointer in window
        let state_ptr = &mut *state as *mut OverlayState;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);

        // Initial render
        render::render(&state).map_err(|e| format!("Failed to render: {:?}", e))?;
        
        // If we have preselected bounds, confirm selection on existing startup toolbar
        // and make overlay click-through (locked selection doesn't need input)
        if preselect_bounds.is_some() {
            if let Some(screen_sel) = state.get_screen_selection() {
                // Emit confirm-selection to update existing toolbar (avoids destroy/recreate crash)
                // This sets selectionConfirmed=true and updates the selection bounds
                let _ = state.app_handle.emit("confirm-selection", serde_json::json!({
                    "x": screen_sel.left,
                    "y": screen_sel.top,
                    "width": screen_sel.width(),
                    "height": screen_sel.height()
                }));
                log::info!("[run_overlay] Confirmed selection on existing toolbar for preselection");
            }
            // Make overlay click-through for locked preselection
            // This is bulletproof - no Z-order fighting with toolbar
            use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TRANSPARENT, WS_EX_LAYERED};
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            let new_style = ex_style | WS_EX_TRANSPARENT.0 as i32 | WS_EX_LAYERED.0 as i32;
            SetWindowLongW(hwnd, GWL_EXSTYLE, new_style);
            log::info!("[run_overlay] Made overlay click-through for locked preselection");
        }

        // Show window
        let _ = ShowWindow(hwnd, SW_SHOW);

        // Force window to foreground
        let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);

        // Message loop
        let mut msg = MSG::default();
        let mut esc_was_pressed = false;

        loop {
            if state.should_close {
                break;
            }

            // Poll ESC key using GetAsyncKeyState
            // (WS_EX_NOACTIVATE windows don't receive keyboard messages normally)
            // Only handle ESC when NOT in adjustment mode - toolbar handles ESC when visible
            let esc_pressed = (GetAsyncKeyState(0x1B) as u16 & 0x8000) != 0;
            if esc_pressed && !esc_was_pressed && !state.adjustment.is_active {
                log::info!("[Overlay] ESC pressed, cancelling overlay");
                state.cancel();
            }
            esc_was_pressed = esc_pressed;

            // Check for pending commands from toolbar
            if state.adjustment.is_active {
                match take_pending_command() {
                    OverlayCommand::ConfirmRecording => {
                        if let Some(selection) = state.get_screen_selection() {
                            state.result.confirm(selection, OverlayAction::StartRecording);
                            state.should_close = true;
                        }
                    }
                    OverlayCommand::ConfirmScreenshot => {
                        if let Some(selection) = state.get_screen_selection() {
                            state.result.confirm(selection, OverlayAction::CaptureScreenshot);
                            state.should_close = true;
                        }
                    }
                    OverlayCommand::Reselect => {
                        state.reselect();
                        // Emit reselecting event (NOT closed) - webcam should stay open
                        let _ = state.app_handle.emit("capture-overlay-reselecting", ());
                        let _ = render::render(&state);
                    }
                    OverlayCommand::Cancel => {
                        state.cancel();
                    }
                    OverlayCommand::SetDimensions => {
                        let (new_width, new_height) = take_pending_dimensions();
                        if new_width > 0 && new_height > 0 {
                            // Calculate new bounds centered on current selection
                            let current = state.adjustment.bounds;
                            let (cx, cy) = current.center();
                            let half_w = new_width as i32 / 2;
                            let half_h = new_height as i32 / 2;
                            state.adjustment.bounds = Rect::new(
                                cx - half_w,
                                cy - half_h,
                                cx - half_w + new_width as i32,
                                cy - half_h + new_height as i32,
                            );
                            // Emit selection update and re-render
                            let screen_sel = state.monitor.local_rect_to_screen(state.adjustment.bounds);
                            let _ = state.app_handle.emit("selection-updated", SelectionEvent::from(screen_sel));
                            let _ = render::render(&state);
                        }
                    }
                    OverlayCommand::None => {}
                }
            }

            // Process window messages
            if PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == 0x0012 {
                    // WM_QUIT
                    break;
                }
                let _ = windows::Win32::UI::WindowsAndMessaging::TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }

        // Build result
        let result = if state.result.confirmed {
            state.result.selection.map(|sel| OverlayResult {
                x: sel.left,
                y: sel.top,
                width: sel.width(),
                height: sel.height(),
                action: state.result.action,
                window_id: state.result.window_id,
            })
        } else {
            None
        };

        // Emit overlay closed event
        if state.result.action != OverlayAction::StartRecording {
            let _ = state.app_handle.emit("capture-overlay-closed", ());
        } else {
            // For recording, emit a different event so the toolbar knows it's safe to proceed
            let _ = state.app_handle.emit("overlay-ready-for-recording", ());
        }

        // Bring toolbar back to front after overlay closes (with delay for z-order to settle)
        let app_for_toolbar = state.app_handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Some(win) = app_for_toolbar.get_webview_window("capture-toolbar") {
                if let Ok(toolbar_hwnd) = win.hwnd() {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        SetWindowPos, SetForegroundWindow, ShowWindow,
                        HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE, SW_SHOW,
                    };
                    unsafe {
                        // Restore if minimized
                        let _ = ShowWindow(HWND(toolbar_hwnd.0), SW_RESTORE);
                        // Show the window
                        let _ = ShowWindow(HWND(toolbar_hwnd.0), SW_SHOW);
                        // Set as topmost
                        let _ = SetWindowPos(
                            HWND(toolbar_hwnd.0),
                            HWND_TOPMOST,
                            0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                        );
                        // Force foreground
                        let _ = SetForegroundWindow(HWND(toolbar_hwnd.0));
                    }
                }
                let _ = win.show();
                let _ = win.set_focus();
            }
        });

        // If cancelled (no result), reset toolbar to startup state and show it
        if result.is_none() {
            log::info!("[Overlay] Result is None (cancelled), resetting toolbar to startup state");
            // Emit reset event so frontend resets selectionConfirmed=false
            let _ = state.app_handle.emit("reset-to-startup", ());

            let app_handle = state.app_handle.clone();
            tauri::async_runtime::spawn(async move {
                log::info!("[Overlay] Spawned task to show startup toolbar");
                if let Err(e) = crate::commands::window::show_startup_toolbar(app_handle).await {
                    log::error!("Failed to show startup toolbar after cancel: {}", e);
                } else {
                    log::info!("[Overlay] show_startup_toolbar completed successfully");
                }
            });
        } else {
            log::info!("[Overlay] Result is Some (confirmed), not showing startup toolbar");
        }

        // Cleanup
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);

        Ok(result)
    }
}

/// Start the highlight preview overlay.
/// 
/// This overlay is click-through (WS_EX_TRANSPARENT) and only renders
/// highlights based on HIGHLIGHTED_MONITOR/HIGHLIGHTED_WINDOW atomics.
/// Used by picker panels to show visual feedback while hovering items.
#[command]
pub async fn start_highlight_preview() -> Result<(), String> {
    log::info!("[start_highlight_preview] Starting preview overlay");
    
    // Check if already active
    if PREVIEW_ACTIVE.load(Ordering::SeqCst) {
        log::info!("[start_highlight_preview] Preview already active");
        return Ok(());
    }
    
    // Can't run preview while main overlay is active
    if OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        log::warn!("[start_highlight_preview] Main overlay is active, skipping preview");
        return Ok(());
    }
    
    // Reset stop signal
    PREVIEW_SHOULD_STOP.store(false, Ordering::SeqCst);
    
    // Get virtual screen bounds
    let (x, y, width, height) = get_virtual_screen_bounds();
    let bounds = Rect::from_xywh(x, y, width, height);
    log::info!("[start_highlight_preview] Bounds: {:?}", bounds);
    
    // Spawn on tokio blocking thread pool (better managed than raw thread)
    // Don't await - let it run in background
    tokio::task::spawn_blocking(move || {
        log::info!("[start_highlight_preview] Thread started, calling run_preview_overlay");
        if let Err(e) = run_preview_overlay(bounds) {
            log::error!("[start_highlight_preview] Preview overlay error: {}", e);
        }
        log::info!("[start_highlight_preview] Thread finished");
    });
    
    log::info!("[start_highlight_preview] Returning Ok");
    Ok(())
}

/// Stop the highlight preview overlay.
#[command]
pub async fn stop_highlight_preview() -> Result<(), String> {
    log::info!("[stop_highlight_preview] Stopping preview overlay");
    PREVIEW_SHOULD_STOP.store(true, Ordering::SeqCst);
    // Clear any highlights
    commands::clear_highlights();
    Ok(())
}

/// Check if preview overlay is active
#[command]
pub async fn is_highlight_preview_active() -> bool {
    PREVIEW_ACTIVE.load(Ordering::SeqCst)
}

/// Run the preview overlay - click-through, render-only.
fn run_preview_overlay(bounds: Rect) -> Result<(), String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    
    log::info!("[run_preview_overlay] Starting");
    
    // Set active flag
    if PREVIEW_ACTIVE.swap(true, Ordering::SeqCst) {
        log::info!("[run_preview_overlay] Already running, exiting");
        return Ok(()); // Already running
    }
    
    // Initialize COM for this thread (required for D3D11/DirectComposition)
    log::info!("[run_preview_overlay] Initializing COM");
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    
    // Guard to reset flag and uninitialize COM on exit
    struct PreviewGuard;
    impl Drop for PreviewGuard {
        fn drop(&mut self) {
            PREVIEW_ACTIVE.store(false, Ordering::SeqCst);
            unsafe { CoUninitialize(); }
            log::info!("[run_preview_overlay] Preview overlay stopped");
        }
    }
    let _guard = PreviewGuard;
    
    // Register window class if needed
    log::info!("[run_preview_overlay] Registering window class");
    register_overlay_class()?;
    
    unsafe {
        log::info!("[run_preview_overlay] Getting module handle");
        let hinstance = GetModuleHandleW(None)
            .map_err(|e| format!("Failed to get module handle: {:?}", e))?;
        
        let class_name: Vec<u16> = OVERLAY_CLASS_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        
        // Create window with DirectComposition style AND click-through
        // WS_EX_TRANSPARENT makes the window click-through
        let ex_style = WINDOW_EX_STYLE(
            WS_EX_NOREDIRECTIONBITMAP 
                | WS_EX_TOPMOST.0 
                | WS_EX_TOOLWINDOW.0 
                | WS_EX_NOACTIVATE.0
                | 0x00000020, // WS_EX_TRANSPARENT
        );
        
        log::info!("[run_preview_overlay] Creating window");
        let hwnd = CreateWindowExW(
            ex_style,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_POPUP,
            bounds.left,
            bounds.top,
            bounds.width() as i32,
            bounds.height() as i32,
            None,
            None,
            hinstance,
            None,
        )
        .map_err(|e| format!("Failed to create preview window: {:?}", e))?;
        
        // Initialize graphics
        log::info!("[run_preview_overlay] Creating D3D11 device");
        let d3d_device = d3d::create_device()
            .map_err(|e| format!("Failed to create D3D11 device: {:?}", e))?;
        
        log::info!("[run_preview_overlay] Creating swap chain");
        let swap_chain = d3d::create_swap_chain(&d3d_device, bounds.width(), bounds.height())
            .map_err(|e| format!("Failed to create swap chain: {:?}", e))?;
        
        log::info!("[run_preview_overlay] Creating DirectComposition");
        let compositor_resources = compositor::create_compositor(&d3d_device, hwnd, &swap_chain)
            .map_err(|e| format!("Failed to create DirectComposition: {:?}", e))?;
        
        log::info!("[run_preview_overlay] Creating D2D resources");
        let d2d_resources = d2d::create_resources(&d3d_device)
            .map_err(|e| format!("Failed to create D2D resources: {:?}", e))?;
        
        // Show window
        log::info!("[run_preview_overlay] Showing window");
        let _ = ShowWindow(hwnd, SW_SHOW);
        
        // Preview render loop - no message handling, just render highlights
        let mut last_monitor = -2i32; // Use -2 as "uninitialized" vs -1 as "no highlight"
        let mut last_window = -1isize;
        
        while !PREVIEW_SHOULD_STOP.load(Ordering::SeqCst) {
            // Check current highlight state
            let current_monitor = commands::get_highlighted_monitor();
            let current_window = commands::get_highlighted_window();
            
            // Only re-render if highlight changed
            if current_monitor != last_monitor || current_window != last_window {
                last_monitor = current_monitor;
                last_window = current_window;
                
                // Render the preview
                if let Err(e) = render_preview(
                    &d2d_resources,
                    &swap_chain,
                    &compositor_resources.device,
                    bounds,
                    current_monitor,
                    current_window,
                ) {
                    log::error!("[run_preview_overlay] Render error: {:?}", e);
                }
            }
            
            // Process window messages (required for window to stay alive)
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == 0x0012 { // WM_QUIT
                    break;
                }
                DispatchMessageW(&msg);
            }
            
            // Small sleep to avoid burning CPU
            std::thread::sleep(std::time::Duration::from_millis(16)); // ~60fps
        }
        
        // Cleanup
        let _ = DestroyWindow(hwnd);
    }
    
    Ok(())
}

/// Render the preview overlay with current highlights.
fn render_preview(
    d2d: &d2d::D2DResources,
    swap_chain: &windows::Win32::Graphics::Dxgi::IDXGISwapChain1,
    comp_device: &windows::Win32::Graphics::DirectComposition::IDCompositionDevice,
    bounds: Rect,
    highlighted_monitor: i32,
    highlighted_window: isize,
) -> windows::core::Result<()> {
    use windows::Win32::Graphics::Direct2D::Common::{D2D1_COLOR_F, D2D_RECT_F};
    use windows::Win32::Graphics::Dxgi::{IDXGISurface, DXGI_PRESENT};
    
    unsafe {
        let surface: IDXGISurface = swap_chain.GetBuffer(0)?;
        let target_bitmap = d2d::create_target_bitmap(&d2d.context, &surface)?;
        
        d2d.context.SetTarget(&target_bitmap);
        d2d.context.BeginDraw();
        
        // Clear with fully transparent
        d2d.context.Clear(Some(&D2D1_COLOR_F {
            r: 0.0, g: 0.0, b: 0.0, a: 0.0,
        }));
        
        let width = bounds.width() as f32;
        let height = bounds.height() as f32;
        
        // Determine clear rect based on highlights
        let clear_rect = if highlighted_window != 0 {
            // Highlight specific window
            if let Some(win_bounds) = render::get_window_bounds_by_hwnd(highlighted_window) {
                // Convert to local coordinates
                D2D_RECT_F {
                    left: ((win_bounds.left - bounds.left) as f32).max(0.0),
                    top: ((win_bounds.top - bounds.top) as f32).max(0.0),
                    right: ((win_bounds.right - bounds.left) as f32).min(width),
                    bottom: ((win_bounds.bottom - bounds.top) as f32).min(height),
                }
            } else {
                // Window not found, no highlight
                D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height }
            }
        } else if highlighted_monitor >= 0 {
            // Highlight specific monitor
            if let Ok(monitors) = xcap::Monitor::all() {
                if let Some(mon) = monitors.get(highlighted_monitor as usize) {
                    let mon_x = mon.x().unwrap_or(0);
                    let mon_y = mon.y().unwrap_or(0);
                    let mon_w = mon.width().unwrap_or(1920) as i32;
                    let mon_h = mon.height().unwrap_or(1080) as i32;
                    
                    D2D_RECT_F {
                        left: (mon_x - bounds.left) as f32,
                        top: (mon_y - bounds.top) as f32,
                        right: (mon_x - bounds.left + mon_w) as f32,
                        bottom: (mon_y - bounds.top + mon_h) as f32,
                    }
                } else {
                    D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height }
                }
            } else {
                D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height }
            }
        } else {
            // No highlight - show nothing (fully transparent)
            D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height }
        };
        
        // Draw dim overlay if we have a highlight
        let has_highlight = highlighted_monitor >= 0 || highlighted_window != 0;
        if has_highlight {
            // Draw dim around clear rect
            // Top
            if clear_rect.top > 0.0 {
                d2d.context.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: clear_rect.top },
                    &d2d.brushes.overlay,
                );
            }
            // Bottom
            if clear_rect.bottom < height {
                d2d.context.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: clear_rect.bottom, right: width, bottom: height },
                    &d2d.brushes.overlay,
                );
            }
            // Left
            if clear_rect.left > 0.0 {
                d2d.context.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: clear_rect.top, right: clear_rect.left, bottom: clear_rect.bottom },
                    &d2d.brushes.overlay,
                );
            }
            // Right
            if clear_rect.right < width {
                d2d.context.FillRectangle(
                    &D2D_RECT_F { left: clear_rect.right, top: clear_rect.top, right: width, bottom: clear_rect.bottom },
                    &d2d.brushes.overlay,
                );
            }
            
            // Draw border around highlight
            d2d.context.DrawRectangle(&clear_rect, &d2d.brushes.border, 2.0, None);
        }
        
        d2d.context.EndDraw(None, None)?;
        
        swap_chain.Present(1, DXGI_PRESENT(0)).ok()?;
        comp_device.Commit()?;
    }
    
    Ok(())
}

/// Register the overlay window class.
fn register_overlay_class() -> Result<(), String> {
    if OVERLAY_CLASS_REGISTERED.load(Ordering::SeqCst) {
        return Ok(());
    }

    unsafe {
        let hinstance =
            GetModuleHandleW(None).map_err(|e| format!("Failed to get module handle: {:?}", e))?;

        let class_name: Vec<u16> = OVERLAY_CLASS_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            hCursor: LoadCursorW(None, IDC_CROSS)
                .map_err(|e| format!("Failed to load cursor: {:?}", e))?,
            ..Default::default()
        };

        let atom = RegisterClassW(&wc);
        if atom == 0 {
            return Err("Failed to register window class".to_string());
        }

        OVERLAY_CLASS_REGISTERED.store(true, Ordering::SeqCst);
    }

    Ok(())
}

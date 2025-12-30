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
pub use types::{CaptureType, OverlayAction, OverlayResult, SelectionEvent};

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use tauri::{command, AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::POINT;
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

use commands::{take_pending_command, take_pending_dimensions};
use graphics::{compositor, d2d, d3d};
use state::{GraphicsState, MonitorInfo, OverlayState};
use types::*;
use wndproc::wnd_proc;

/// Track if the overlay window class has been registered
static OVERLAY_CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Track if an overlay is currently active (prevent multiple overlays)
static OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

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
///
/// # Returns
/// The selection result if confirmed, or None if cancelled
#[command]
pub async fn show_capture_overlay(
    app: AppHandle,
    _monitor_index: Option<usize>,
    capture_type: Option<String>,
) -> Result<Option<OverlayResult>, String> {
    log::info!("[show_capture_overlay] Called with capture_type: {:?}", capture_type);
    
    let app_clone = app.clone();
    let ct = CaptureType::from_str(capture_type.as_deref().unwrap_or("video"));

    // Get virtual screen bounds (spans all monitors)
    let (x, y, width, height) = get_virtual_screen_bounds();
    let bounds = Rect::from_xywh(x, y, width, height);
    log::info!("[show_capture_overlay] Virtual screen bounds: x={}, y={}, w={}, h={}", x, y, width, height);

    tokio::task::spawn_blocking(move || run_overlay(app_clone, bounds, ct))
        .await
        .map_err(|e| format!("Task failed: {:?}", e))?
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
) -> Result<Option<OverlayResult>, String> {
    log::info!("[run_overlay] Starting overlay for {:?}", capture_type);
    
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
        let mut state = Box::new(OverlayState {
            app_handle: app,
            capture_type,
            hwnd,
            monitor: MonitorInfo::new(bounds.left, bounds.top, bounds.width(), bounds.height()),
            drag: Default::default(),
            adjustment: Default::default(),
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
            let esc_pressed = (GetAsyncKeyState(0x1B) as u16 & 0x8000) != 0;
            if esc_pressed && !esc_was_pressed {
                log::info!("[Overlay] ESC pressed, cancelling overlay");
                if state.adjustment.is_active {
                    state.adjustment.reset();
                }
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

        // Emit overlay closed event (only if not starting recording)
        if state.result.action != OverlayAction::StartRecording {
            let _ = state.app_handle.emit("capture-overlay-closed", ());
        }

        // If cancelled (no result), show the startup toolbar again
        if result.is_none() {
            log::info!("[Overlay] Result is None (cancelled), will show startup toolbar");
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

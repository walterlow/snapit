//! DirectComposition-based overlay for video/gif region selection.
//! 
//! This module creates a transparent overlay using DirectComposition instead of
//! WS_EX_LAYERED windows. This allows the overlay to work with hardware-accelerated
//! video without causing blackout issues.
//!
//! Features:
//! - Window detection and highlighting (click to select window)
//! - Region selection with drag (drag to select custom region)
//! - Crosshair cursor display
//! - Semi-transparent overlay with clear selection area

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use windows::core::{Interface, PCWSTR};
use windows::Foundation::Numerics::Matrix3x2;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM, POINT, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory2, IDXGIDevice, IDXGIFactory2, IDXGISwapChain1, IDXGISurface,
    DXGI_SWAP_CHAIN_DESC1, DXGI_USAGE_RENDER_TARGET_OUTPUT,
    DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_CREATE_FACTORY_FLAGS,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC, DXGI_ALPHA_MODE_PREMULTIPLIED,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1Factory1, ID2D1DeviceContext, ID2D1Device, ID2D1Bitmap1,
    ID2D1SolidColorBrush, ID2D1RenderTarget,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
    D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
    D2D1_BRUSH_PROPERTIES, D2D1_DRAW_TEXT_OPTIONS_NONE,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat,
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_STRETCH_NORMAL, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_COLOR_F, D2D_RECT_F, D2D_POINT_2F, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, PAINTSTRUCT,
    MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetWindowLongPtrW, SetWindowLongPtrW, GetWindowRect, SetWindowPos,
    LoadCursorW, PeekMessageW, RegisterClassW, SetCursor,
    ShowWindow, IsWindowVisible, GetWindowLongW, GetSystemMetrics,
    CS_HREDRAW, CS_VREDRAW, IDC_CROSS, IDC_ARROW, IDC_SIZEALL,
    IDC_SIZENWSE, IDC_SIZENESW, IDC_SIZENS, IDC_SIZEWE, IDC_HAND,
    MSG, PM_REMOVE, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE,
    SW_SHOW, WINDOW_EX_STYLE, WNDCLASSW, WS_POPUP, GWL_STYLE, GWL_EXSTYLE,
    WM_CREATE, WM_DESTROY, WM_PAINT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_KEYDOWN, WM_KEYUP, WM_RBUTTONDOWN, WM_SETCURSOR, WS_EX_TOPMOST, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE,
    WS_CHILD, WS_EX_APPWINDOW,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    GWLP_USERDATA, HTCLIENT,
};

// Extended window style for no redirection bitmap
const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000;

/// Detected window under cursor
#[derive(Clone, Default)]
struct DetectedWindow {
    #[allow(dead_code)]
    hwnd: isize, // Kept for potential future use (window title, etc.)
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Handle position for resize gizmo
#[derive(Clone, Copy, PartialEq, Debug)]
enum HandlePosition {
    None,
    TopLeft,
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
    Interior, // For moving the entire selection
}

/// Panel button identifiers
#[derive(Clone, Copy, PartialEq, Debug)]
enum PanelButton {
    None,
    Record,
    Webcam,
    SystemAudio,
    Microphone,
    Capture,
    Reselect,
    Cancel,
}

/// Result action from overlay
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum OverlayAction {
    Cancelled,
    StartRecording,
    CaptureScreenshot,
}

/// Event payload for dcomp-overlay-adjustment-ready
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAdjustmentEvent {
    /// Screen X coordinate of selection
    pub x: i32,
    /// Screen Y coordinate of selection
    pub y: i32,
    /// Width of selection
    pub width: u32,
    /// Height of selection
    pub height: u32,
}

// Panel constants
const PANEL_HEIGHT: f32 = 50.0;
const PANEL_PADDING: f32 = 8.0;
const PANEL_BUTTON_SIZE: f32 = 36.0;
const PANEL_BUTTON_GAP: f32 = 4.0;
const PANEL_CORNER_RADIUS: f32 = 8.0;

/// Overlay state - stored in window user data
struct OverlayState {
    // Tauri app handle for emitting events
    app_handle: AppHandle,
    
    // Mode: true = region selection in progress, false = window detection mode
    is_selecting: bool,
    is_dragging: bool, // True if user has dragged more than threshold
    shift_held: bool,  // True when Shift key is held (for square selection)
    
    // Adjustment mode - after initial selection, allow resize/move before confirming
    is_adjusting: bool,
    adjust_handle: HandlePosition, // Which handle is being dragged
    is_adjust_dragging: bool,      // True when dragging a handle or moving selection
    adjust_drag_start_x: i32,      // Mouse position when adjustment drag started
    adjust_drag_start_y: i32,
    
    // Confirmed selection bounds (in local coordinates) - used during adjustment
    sel_left: i32,
    sel_top: i32,
    sel_right: i32,
    sel_bottom: i32,
    
    // Original selection bounds when drag started (for calculating delta)
    orig_sel_left: i32,
    orig_sel_top: i32,
    orig_sel_right: i32,
    orig_sel_bottom: i32,
    
    // Selection coordinates (local to monitor) - used during initial drag
    start_x: i32,
    start_y: i32,
    current_x: i32,
    current_y: i32,
    
    // Cursor position (for crosshair)
    cursor_x: i32,
    cursor_y: i32,
    
    // Detected window under cursor
    hovered_window: Option<DetectedWindow>,
    
    // Monitor info
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    overlay_hwnd: HWND,
    
    // DirectComposition resources
    swap_chain: IDXGISwapChain1,
    dcomp_device: IDCompositionDevice,
    _dcomp_target: IDCompositionTarget,
    _dcomp_visual: IDCompositionVisual,
    
    // Direct2D resources
    d2d_context: ID2D1DeviceContext,
    overlay_brush: ID2D1SolidColorBrush,
    border_brush: ID2D1SolidColorBrush,
    crosshair_brush: ID2D1SolidColorBrush,
    text_brush: ID2D1SolidColorBrush,
    text_bg_brush: ID2D1SolidColorBrush,
    handle_brush: ID2D1SolidColorBrush,
    handle_border_brush: ID2D1SolidColorBrush,
    panel_bg_brush: ID2D1SolidColorBrush,
    panel_button_brush: ID2D1SolidColorBrush,
    panel_button_hover_brush: ID2D1SolidColorBrush,
    record_button_brush: ID2D1SolidColorBrush,
    icon_brush: ID2D1SolidColorBrush,
    disabled_brush: ID2D1SolidColorBrush,
    
    // DirectWrite resources
    text_format: IDWriteTextFormat,
    
    // Panel state
    hovered_button: PanelButton,
    webcam_enabled: bool,
    system_audio_enabled: bool,
    mic_enabled: bool,
    
    // Control
    should_close: bool,
    last_event_emit_time: std::time::Instant,
    
    // Result
    selection_confirmed: bool,
    result_action: OverlayAction,
    final_selection: Option<(i32, i32, u32, u32)>,
}

static OVERLAY_CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);
const OVERLAY_CLASS_NAME: &str = "SnapItDCompOverlay";
const DRAG_THRESHOLD: i32 = 5;
const HANDLE_SIZE: i32 = 10; // Size of resize handles in pixels
const HANDLE_HALF: i32 = HANDLE_SIZE / 2;

// Set to false to hide the Direct2D panel and use React-based toolbar instead
const SHOW_D2D_PANEL: bool = false;

// =============================================================================
// Overlay Command System (for communication from React toolbar)
// =============================================================================

/// Commands that can be sent to the running overlay
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
enum OverlayCommand {
    None = 0,
    ConfirmRecording = 1,
    ConfirmScreenshot = 2,
    Reselect = 3,
    Cancel = 4,
}

impl From<u8> for OverlayCommand {
    fn from(value: u8) -> Self {
        match value {
            1 => Self::ConfirmRecording,
            2 => Self::ConfirmScreenshot,
            3 => Self::Reselect,
            4 => Self::Cancel,
            _ => Self::None,
        }
    }
}

/// Global pending command for the overlay
static PENDING_OVERLAY_COMMAND: AtomicU8 = AtomicU8::new(0);

/// Get and clear the pending overlay command
fn take_pending_command() -> OverlayCommand {
    let cmd = PENDING_OVERLAY_COMMAND.swap(0, Ordering::SeqCst);
    OverlayCommand::from(cmd)
}

/// Set a pending command for the overlay
fn set_pending_command(cmd: OverlayCommand) {
    PENDING_OVERLAY_COMMAND.store(cmd as u8, Ordering::SeqCst);
}

// =============================================================================
// Tauri Commands for Overlay Control
// =============================================================================

/// Confirm the overlay selection and start recording
#[tauri::command]
pub async fn dcomp_overlay_confirm(action: String) -> Result<(), String> {
    let cmd = match action.as_str() {
        "recording" => OverlayCommand::ConfirmRecording,
        "screenshot" => OverlayCommand::ConfirmScreenshot,
        _ => return Err(format!("Unknown action: {}", action)),
    };
    set_pending_command(cmd);
    Ok(())
}

/// Cancel the overlay and close
#[tauri::command]
pub async fn dcomp_overlay_cancel() -> Result<(), String> {
    set_pending_command(OverlayCommand::Cancel);
    Ok(())
}

/// Go back to selection mode (reselect region)
#[tauri::command]
pub async fn dcomp_overlay_reselect() -> Result<(), String> {
    set_pending_command(OverlayCommand::Reselect);
    Ok(())
}

// =============================================================================

/// Hit-test which handle (if any) is at the given point
fn hit_test_handle(x: i32, y: i32, left: i32, top: i32, right: i32, bottom: i32) -> HandlePosition {
    let cx = (left + right) / 2;
    let cy = (top + bottom) / 2;
    
    // Check corners first (they have priority)
    // Top-left
    if (x - left).abs() <= HANDLE_HALF && (y - top).abs() <= HANDLE_HALF {
        return HandlePosition::TopLeft;
    }
    // Top-right
    if (x - right).abs() <= HANDLE_HALF && (y - top).abs() <= HANDLE_HALF {
        return HandlePosition::TopRight;
    }
    // Bottom-left
    if (x - left).abs() <= HANDLE_HALF && (y - bottom).abs() <= HANDLE_HALF {
        return HandlePosition::BottomLeft;
    }
    // Bottom-right
    if (x - right).abs() <= HANDLE_HALF && (y - bottom).abs() <= HANDLE_HALF {
        return HandlePosition::BottomRight;
    }
    
    // Check edge handles
    // Top
    if (x - cx).abs() <= HANDLE_HALF && (y - top).abs() <= HANDLE_HALF {
        return HandlePosition::Top;
    }
    // Bottom
    if (x - cx).abs() <= HANDLE_HALF && (y - bottom).abs() <= HANDLE_HALF {
        return HandlePosition::Bottom;
    }
    // Left
    if (x - left).abs() <= HANDLE_HALF && (y - cy).abs() <= HANDLE_HALF {
        return HandlePosition::Left;
    }
    // Right
    if (x - right).abs() <= HANDLE_HALF && (y - cy).abs() <= HANDLE_HALF {
        return HandlePosition::Right;
    }
    
    // Check if inside the selection (for moving)
    if x > left && x < right && y > top && y < bottom {
        return HandlePosition::Interior;
    }
    
    HandlePosition::None
}

/// Calculate the panel position based on selection and monitor layout
/// Returns (panel_x, panel_y, panel_width) in local overlay coordinates
fn calculate_panel_position(
    sel_left: i32, sel_top: i32, sel_right: i32, sel_bottom: i32,
    _monitor_x: i32, _monitor_y: i32, monitor_width: u32, monitor_height: u32,
) -> (f32, f32, f32) {
    // Panel width calculation: buttons + dimensions + padding
    // Record(36) + gap + Webcam(36) + gap + Audio(36) + gap + Mic(36) + gap + Dims(~100) + gap + Capture(36) + gap + Reselect(36) + gap + Cancel(36) + padding
    let panel_width = PANEL_PADDING * 2.0 + PANEL_BUTTON_SIZE * 7.0 + PANEL_BUTTON_GAP * 8.0 + 100.0;
    let panel_height = PANEL_HEIGHT;
    
    // Selection center and dimensions
    let sel_center_x = (sel_left + sel_right) as f32 / 2.0;
    let sel_width = (sel_right - sel_left) as u32;
    let sel_height = (sel_bottom - sel_top) as u32;
    
    // Check if selection is nearly fullscreen on this monitor
    let is_fullscreen = sel_width >= monitor_width - 20 && sel_height >= monitor_height - 20;
    
    // Default: center below selection
    let mut panel_x = sel_center_x - panel_width / 2.0;
    let mut panel_y = sel_bottom as f32 + 15.0;
    
    if is_fullscreen {
        // For fullscreen, we need to check if there's another monitor
        // For now, place at bottom center of the current monitor with some margin
        panel_x = (monitor_width as f32 - panel_width) / 2.0;
        panel_y = monitor_height as f32 - panel_height - 60.0;
    } else {
        // Check if panel would go off screen bottom
        if panel_y + panel_height > monitor_height as f32 - 10.0 {
            // Place above selection instead
            panel_y = sel_top as f32 - panel_height - 15.0;
            
            // If still off screen (top), place inside at bottom
            if panel_y < 10.0 {
                panel_y = sel_bottom as f32 - panel_height - 15.0;
            }
        }
        
        // Clamp X to screen bounds
        if panel_x < 10.0 {
            panel_x = 10.0;
        }
        if panel_x + panel_width > monitor_width as f32 - 10.0 {
            panel_x = monitor_width as f32 - panel_width - 10.0;
        }
    }
    
    (panel_x, panel_y, panel_width)
}

/// Get the button rectangles for hit testing
/// Returns a list of (button_id, rect) tuples
fn get_panel_button_rects(panel_x: f32, panel_y: f32) -> Vec<(PanelButton, D2D_RECT_F)> {
    let mut buttons = Vec::new();
    let mut x = panel_x + PANEL_PADDING;
    let y = panel_y + (PANEL_HEIGHT - PANEL_BUTTON_SIZE) / 2.0;
    
    // Record button
    buttons.push((PanelButton::Record, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    x += PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP;
    
    // Webcam button
    buttons.push((PanelButton::Webcam, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    x += PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP;
    
    // System Audio button
    buttons.push((PanelButton::SystemAudio, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    x += PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP;
    
    // Microphone button
    buttons.push((PanelButton::Microphone, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    x += PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP;
    
    // Skip dimensions display area (100px)
    x += 100.0 + PANEL_BUTTON_GAP;
    
    // Capture button
    buttons.push((PanelButton::Capture, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    x += PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP;
    
    // Reselect button
    buttons.push((PanelButton::Reselect, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    x += PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP;
    
    // Cancel button
    buttons.push((PanelButton::Cancel, D2D_RECT_F {
        left: x, top: y, right: x + PANEL_BUTTON_SIZE, bottom: y + PANEL_BUTTON_SIZE
    }));
    
    buttons
}

/// Hit test which panel button is at the given point
fn hit_test_panel_button(x: i32, y: i32, panel_x: f32, panel_y: f32, panel_width: f32) -> PanelButton {
    let xf = x as f32;
    let yf = y as f32;
    
    // First check if inside panel at all
    if xf < panel_x || xf > panel_x + panel_width || 
       yf < panel_y || yf > panel_y + PANEL_HEIGHT {
        return PanelButton::None;
    }
    
    // Check each button
    for (button, rect) in get_panel_button_rects(panel_x, panel_y) {
        if xf >= rect.left && xf <= rect.right && yf >= rect.top && yf <= rect.bottom {
            return button;
        }
    }
    
    PanelButton::None
}

/// Check if a window is valid for selection (visible, not a system window, etc.)
fn is_valid_window_for_capture(hwnd: HWND, exclude_hwnd: HWND) -> Option<DetectedWindow> {
    unsafe {
        // Skip our overlay
        if hwnd == exclude_hwnd {
            return None;
        }
        
        // Must be visible
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        
        // Get styles
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        
        // Skip child windows
        if (style & WS_CHILD.0) != 0 {
            return None;
        }
        
        // Skip tool windows unless they have WS_EX_APPWINDOW
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 && (ex_style & WS_EX_APPWINDOW.0) == 0 {
            return None;
        }
        
        // Skip windows with WS_EX_NOREDIRECTIONBITMAP (like our DirectComposition overlay)
        if (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0 {
            return None;
        }
        
        // Get window rect WITHOUT shadow using DwmGetWindowAttribute
        // DWMWA_EXTENDED_FRAME_BOUNDS gives us the actual visible bounds
        let mut rect = RECT::default();
        let dwm_result = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        
        // Fall back to GetWindowRect if DWM fails (e.g., for non-DWM windows)
        if dwm_result.is_err() {
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return None;
            }
        }
        
        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;
        
        // Skip tiny windows
        if width < 50 || height < 50 {
            return None;
        }
        
        Some(DetectedWindow {
            hwnd: hwnd.0 as isize,
            x: rect.left,
            y: rect.top,
            width,
            height,
        })
    }
}

/// Get the top-level window at a screen point by enumerating windows in z-order.
/// This avoids issues with WindowFromPoint returning our overlay.
fn get_window_at_screen_point(screen_x: i32, screen_y: i32, exclude_hwnd: HWND) -> Option<DetectedWindow> {
    use windows::Win32::UI::WindowsAndMessaging::{GetTopWindow, GetWindow, GetDesktopWindow, GW_HWNDNEXT};
    
    unsafe {
        // Get the desktop window and start from its first child (topmost window)
        let desktop = GetDesktopWindow();
        let mut hwnd = match GetTopWindow(desktop) {
            Ok(h) if !h.0.is_null() => h,
            _ => return None,
        };
        
        // Iterate through windows in z-order (topmost first)
        loop {
            // Get window rect
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                // Check if point is inside this window
                if screen_x >= rect.left && screen_x < rect.right &&
                   screen_y >= rect.top && screen_y < rect.bottom {
                    // Check if it's a valid window for capture
                    if let Some(detected) = is_valid_window_for_capture(hwnd, exclude_hwnd) {
                        return Some(detected);
                    }
                }
            }
            
            // Move to next window in z-order
            hwnd = match GetWindow(hwnd, GW_HWNDNEXT) {
                Ok(next) if !next.0.is_null() => next,
                _ => break,
            };
        }
        
        None
    }
}

/// Initialize Direct3D11 device
fn create_d3d11_device() -> windows::core::Result<ID3D11Device> {
    let mut device: Option<ID3D11Device> = None;
    
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
    }
    
    Ok(device.unwrap())
}

/// Create Direct2D factory and device context
fn create_d2d_context(d3d_device: &ID3D11Device) -> windows::core::Result<(ID2D1Factory1, ID2D1DeviceContext)> {
    unsafe {
        let d2d_factory: ID2D1Factory1 = D2D1CreateFactory(
            D2D1_FACTORY_TYPE_SINGLE_THREADED,
            None,
        )?;
        
        let dxgi_device: IDXGIDevice = d3d_device.cast()?;
        let d2d_device: ID2D1Device = d2d_factory.CreateDevice(&dxgi_device)?;
        let d2d_context = d2d_device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
        
        Ok((d2d_factory, d2d_context))
    }
}

/// Create DXGI swap chain for composition
fn create_swap_chain(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> windows::core::Result<IDXGISwapChain1> {
    unsafe {
        let dxgi_device: IDXGIDevice = device.cast()?;
        let dxgi_factory: IDXGIFactory2 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0))?;
        
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: windows::Win32::Graphics::Dxgi::DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
            Flags: 0,
        };
        
        let swap_chain = dxgi_factory.CreateSwapChainForComposition(&dxgi_device, &desc, None)?;
        
        Ok(swap_chain)
    }
}

/// Create DirectComposition device and visual tree
fn create_dcomp(
    device: &ID3D11Device,
    hwnd: HWND,
    swap_chain: &IDXGISwapChain1,
) -> windows::core::Result<(IDCompositionDevice, IDCompositionTarget, IDCompositionVisual)> {
    unsafe {
        let dxgi_device: IDXGIDevice = device.cast()?;
        
        let dcomp_device: IDCompositionDevice = DCompositionCreateDevice(&dxgi_device)?;
        let target = dcomp_device.CreateTargetForHwnd(hwnd, true)?;
        let visual = dcomp_device.CreateVisual()?;
        
        visual.SetContent(swap_chain)?;
        target.SetRoot(&visual)?;
        dcomp_device.Commit()?;
        
        Ok((dcomp_device, target, visual))
    }
}

/// Render the overlay content using Direct2D
fn render_overlay(state: &OverlayState) -> windows::core::Result<()> {
    unsafe {
        let dxgi_surface: IDXGISurface = state.swap_chain.GetBuffer(0)?;
        
        let bitmap_props = windows::Win32::Graphics::Direct2D::D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        
        let target_bitmap: ID2D1Bitmap1 = state.d2d_context.CreateBitmapFromDxgiSurface(&dxgi_surface, Some(&bitmap_props))?;
        
        state.d2d_context.SetTarget(&target_bitmap);
        state.d2d_context.BeginDraw();
        
        // Clear with fully transparent
        state.d2d_context.Clear(Some(&D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }));
        
        let width = state.monitor_width as f32;
        let height = state.monitor_height as f32;
        
        // Determine the "clear" area (not dimmed)
        // - Adjustment mode: show the adjustable selection
        // - When dragging: show selection rectangle
        // - When hovering window: show that window
        // - When hovering desktop (no window): show entire monitor (no dim)
        let (clear_rect, draw_border, draw_handles): (D2D_RECT_F, bool, bool) = if state.is_adjusting {
            // Adjustment mode - show the selection with handles
            (D2D_RECT_F { 
                left: state.sel_left as f32, 
                top: state.sel_top as f32, 
                right: state.sel_right as f32, 
                bottom: state.sel_bottom as f32 
            }, true, true)
        } else if state.is_dragging {
            // Region selection mode - show selection rectangle
            let mut sel_x1 = state.start_x.min(state.current_x) as f32;
            let mut sel_y1 = state.start_y.min(state.current_y) as f32;
            let mut sel_x2 = state.start_x.max(state.current_x) as f32;
            let mut sel_y2 = state.start_y.max(state.current_y) as f32;
            
            // If Shift is held, constrain to square
            if state.shift_held {
                let sel_width = sel_x2 - sel_x1;
                let sel_height = sel_y2 - sel_y1;
                let size = sel_width.max(sel_height);
                
                // Expand from the drag start point in the direction of the cursor
                if state.current_x >= state.start_x {
                    sel_x2 = sel_x1 + size;
                } else {
                    sel_x1 = sel_x2 - size;
                }
                if state.current_y >= state.start_y {
                    sel_y2 = sel_y1 + size;
                } else {
                    sel_y1 = sel_y2 - size;
                }
            }
            
            (D2D_RECT_F { left: sel_x1, top: sel_y1, right: sel_x2, bottom: sel_y2 }, true, false)
        } else if let Some(ref win) = state.hovered_window {
            // Window detection mode - show hovered window
            let local_x = (win.x - state.monitor_x) as f32;
            let local_y = (win.y - state.monitor_y) as f32;
            let local_right = local_x + win.width as f32;
            let local_bottom = local_y + win.height as f32;
            
            // Clamp to monitor bounds
            let left = local_x.max(0.0);
            let top = local_y.max(0.0);
            let right = local_right.min(width);
            let bottom = local_bottom.min(height);
            
            (D2D_RECT_F { left, top, right, bottom }, true, false)
        } else {
            // No window detected (desktop/empty area) - show entire monitor as clear
            (D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height }, false, false)
        };
        
        // Draw overlay around the clear area (4 rectangles for dimming)
        // Top
        if clear_rect.top > 0.0 {
            state.d2d_context.FillRectangle(
                &D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: clear_rect.top },
                &state.overlay_brush,
            );
        }
        // Bottom
        if clear_rect.bottom < height {
            state.d2d_context.FillRectangle(
                &D2D_RECT_F { left: 0.0, top: clear_rect.bottom, right: width, bottom: height },
                &state.overlay_brush,
            );
        }
        // Left
        if clear_rect.left > 0.0 {
            state.d2d_context.FillRectangle(
                &D2D_RECT_F { left: 0.0, top: clear_rect.top, right: clear_rect.left, bottom: clear_rect.bottom },
                &state.overlay_brush,
            );
        }
        // Right
        if clear_rect.right < width {
            state.d2d_context.FillRectangle(
                &D2D_RECT_F { left: clear_rect.right, top: clear_rect.top, right: width, bottom: clear_rect.bottom },
                &state.overlay_brush,
            );
        }
        
        // Draw border around the selection/window (but not for full-screen desktop mode)
        if draw_border {
            state.d2d_context.DrawRectangle(
                &clear_rect,
                &state.border_brush,
                2.0,
                None,
            );
        }
        
        // Draw crosshair at cursor position with gap at center
        // Only draw when NOT in adjustment mode, and only within the current monitor
        if !state.is_adjusting {
            let cx = state.cursor_x as f32;
            let cy = state.cursor_y as f32;
            let gap = 10.0_f32; // Gap radius around cursor
            
            // Get the monitor bounds for the current cursor position
            let screen_x = state.monitor_x + state.cursor_x;
            let screen_y = state.monitor_y + state.cursor_y;
            let cursor_point = POINT { x: screen_x, y: screen_y };
            
            let hmonitor = MonitorFromPoint(cursor_point, MONITOR_DEFAULTTONEAREST);
            let mut monitor_info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            
            // Get monitor bounds and convert to local overlay coordinates
            let (mon_left, mon_top, mon_right, mon_bottom) = if GetMonitorInfoW(hmonitor, &mut monitor_info).as_bool() {
                let rc = monitor_info.rcMonitor;
                (
                    (rc.left - state.monitor_x) as f32,
                    (rc.top - state.monitor_y) as f32,
                    (rc.right - state.monitor_x) as f32,
                    (rc.bottom - state.monitor_y) as f32,
                )
            } else {
                // Fallback to full overlay if we can't get monitor info
                (0.0, 0.0, width, height)
            };
            
            // Horizontal line (left segment) - from monitor left edge to cursor
            if cx > mon_left + gap {
                state.d2d_context.DrawLine(
                    D2D_POINT_2F { x: mon_left, y: cy },
                    D2D_POINT_2F { x: cx - gap, y: cy },
                    &state.crosshair_brush,
                    1.0,
                    None,
                );
            }
            // Horizontal line (right segment) - from cursor to monitor right edge
            if cx + gap < mon_right {
                state.d2d_context.DrawLine(
                    D2D_POINT_2F { x: cx + gap, y: cy },
                    D2D_POINT_2F { x: mon_right, y: cy },
                    &state.crosshair_brush,
                    1.0,
                    None,
                );
            }
            // Vertical line (top segment) - from monitor top edge to cursor
            if cy > mon_top + gap {
                state.d2d_context.DrawLine(
                    D2D_POINT_2F { x: cx, y: mon_top },
                    D2D_POINT_2F { x: cx, y: cy - gap },
                    &state.crosshair_brush,
                    1.0,
                    None,
                );
            }
            // Vertical line (bottom segment) - from cursor to monitor bottom edge
            if cy + gap < mon_bottom {
                state.d2d_context.DrawLine(
                    D2D_POINT_2F { x: cx, y: cy + gap },
                    D2D_POINT_2F { x: cx, y: mon_bottom },
                    &state.crosshair_brush,
                    1.0,
                    None,
                );
            }
        } // End of crosshair drawing (not in adjustment mode)
        
        // Draw size indicator when selecting or hovering a window
        // Hide in adjustment mode when using React toolbar (SHOW_D2D_PANEL = false)
        if draw_border && (SHOW_D2D_PANEL || !state.is_adjusting) {
            let sel_width = (clear_rect.right - clear_rect.left) as u32;
            let sel_height = (clear_rect.bottom - clear_rect.top) as u32;
            
            // Format the size text
            let size_text = format!("{} x {}", sel_width, sel_height);
            let size_text_wide: Vec<u16> = size_text.encode_utf16().chain(std::iter::once(0)).collect();
            
            // Calculate text box dimensions
            let text_width = 100.0_f32;
            let text_height = 24.0_f32;
            let padding = 6.0_f32;
            let margin = 8.0_f32;
            
            // Position below the selection, centered horizontally
            let box_x = clear_rect.left + (clear_rect.right - clear_rect.left - text_width) / 2.0;
            let box_y = clear_rect.bottom + margin;
            
            // Clamp to screen bounds
            let box_x = box_x.max(padding).min(width - text_width - padding);
            let box_y = if box_y + text_height + padding > height {
                // If below screen, show above selection
                clear_rect.top - margin - text_height
            } else {
                box_y
            }.max(padding);
            
            // Draw background rounded rect
            let bg_rect = D2D_RECT_F {
                left: box_x,
                top: box_y,
                right: box_x + text_width,
                bottom: box_y + text_height,
            };
            
            // Use FillRoundedRectangle for nicer look
            let rounded_rect = windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT {
                rect: bg_rect,
                radiusX: 4.0,
                radiusY: 4.0,
            };
            state.d2d_context.FillRoundedRectangle(&rounded_rect, &state.text_bg_brush);
            
            // Draw text
            state.d2d_context.DrawText(
                &size_text_wide[..size_text_wide.len() - 1], // Exclude null terminator
                &state.text_format,
                &bg_rect,
                &state.text_brush,
                D2D1_DRAW_TEXT_OPTIONS_NONE,
                windows::Win32::Graphics::DirectWrite::DWRITE_MEASURING_MODE_NATURAL,
            );
            
        }
        
        // Draw resize handles in adjustment mode
        if draw_handles {
            let hh = HANDLE_HALF as f32;
            
            let left = clear_rect.left;
            let top = clear_rect.top;
            let right = clear_rect.right;
            let bottom = clear_rect.bottom;
            let cx = (left + right) / 2.0;
            let cy = (top + bottom) / 2.0;
            
            // Helper to draw a single handle
            let draw_handle = |ctx: &ID2D1DeviceContext, x: f32, y: f32, 
                              fill: &ID2D1SolidColorBrush, border: &ID2D1SolidColorBrush| {
                let rect = D2D_RECT_F {
                    left: x - hh,
                    top: y - hh,
                    right: x + hh,
                    bottom: y + hh,
                };
                ctx.FillRectangle(&rect, fill);
                ctx.DrawRectangle(&rect, border, 1.0, None);
            };
            
            // Draw all 8 handles
            // Corners
            draw_handle(&state.d2d_context, left, top, &state.handle_brush, &state.handle_border_brush);      // TopLeft
            draw_handle(&state.d2d_context, right, top, &state.handle_brush, &state.handle_border_brush);     // TopRight
            draw_handle(&state.d2d_context, left, bottom, &state.handle_brush, &state.handle_border_brush);   // BottomLeft
            draw_handle(&state.d2d_context, right, bottom, &state.handle_brush, &state.handle_border_brush);  // BottomRight
            
            // Edges
            draw_handle(&state.d2d_context, cx, top, &state.handle_brush, &state.handle_border_brush);        // Top
            draw_handle(&state.d2d_context, cx, bottom, &state.handle_brush, &state.handle_border_brush);     // Bottom
            draw_handle(&state.d2d_context, left, cy, &state.handle_brush, &state.handle_border_brush);       // Left
            draw_handle(&state.d2d_context, right, cy, &state.handle_brush, &state.handle_border_brush);      // Right
            
            // Draw recording settings panel (D2D version - hidden when using React toolbar)
            // When SHOW_D2D_PANEL is false, a React-based toolbar window is shown instead
            if SHOW_D2D_PANEL {
            let (panel_x, panel_y, panel_width) = calculate_panel_position(
                state.sel_left, state.sel_top, state.sel_right, state.sel_bottom,
                state.monitor_x, state.monitor_y, state.monitor_width, state.monitor_height
            );
            
            // Panel background
            let panel_rect = D2D_RECT_F {
                left: panel_x,
                top: panel_y,
                right: panel_x + panel_width,
                bottom: panel_y + PANEL_HEIGHT,
            };
            let panel_rounded = windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT {
                rect: panel_rect,
                radiusX: PANEL_CORNER_RADIUS,
                radiusY: PANEL_CORNER_RADIUS,
            };
            state.d2d_context.FillRoundedRectangle(&panel_rounded, &state.panel_bg_brush);
            
            // Draw panel buttons
            let button_rects = get_panel_button_rects(panel_x, panel_y);
            for (button_id, rect) in &button_rects {
                let is_hovered = *button_id == state.hovered_button;
                let btn_rounded = windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT {
                    rect: *rect,
                    radiusX: 4.0,
                    radiusY: 4.0,
                };
                
                // Button background
                let bg_brush = if is_hovered {
                    &state.panel_button_hover_brush
                } else {
                    &state.panel_button_brush
                };
                
                // Special red background for record button
                if *button_id == PanelButton::Record {
                    state.d2d_context.FillRoundedRectangle(&btn_rounded, &state.record_button_brush);
                } else {
                    state.d2d_context.FillRoundedRectangle(&btn_rounded, bg_brush);
                }
                
                // Draw button icons/symbols
                let center_x = (rect.left + rect.right) / 2.0;
                let center_y = (rect.top + rect.bottom) / 2.0;
                
                match button_id {
                    PanelButton::Record => {
                        // White filled circle for record
                        let ellipse = windows::Win32::Graphics::Direct2D::D2D1_ELLIPSE {
                            point: D2D_POINT_2F { x: center_x, y: center_y },
                            radiusX: 10.0,
                            radiusY: 10.0,
                        };
                        state.d2d_context.FillEllipse(&ellipse, &state.handle_brush);
                    }
                    PanelButton::Webcam => {
                        // Simple camera icon (rectangle with lens circle)
                        let cam_rect = D2D_RECT_F {
                            left: center_x - 10.0, top: center_y - 6.0,
                            right: center_x + 6.0, bottom: center_y + 6.0,
                        };
                        state.d2d_context.FillRectangle(&cam_rect, &state.icon_brush);
                        // Lens
                        let lens = windows::Win32::Graphics::Direct2D::D2D1_ELLIPSE {
                            point: D2D_POINT_2F { x: center_x + 8.0, y: center_y },
                            radiusX: 4.0,
                            radiusY: 4.0,
                        };
                        state.d2d_context.FillEllipse(&lens, &state.icon_brush);
                        // Cross out line if disabled
                        if !state.webcam_enabled {
                            state.d2d_context.DrawLine(
                                D2D_POINT_2F { x: rect.left + 6.0, y: rect.bottom - 6.0 },
                                D2D_POINT_2F { x: rect.right - 6.0, y: rect.top + 6.0 },
                                &state.disabled_brush, 2.0, None
                            );
                        }
                    }
                    PanelButton::SystemAudio => {
                        // Speaker icon
                        let spk_rect = D2D_RECT_F {
                            left: center_x - 4.0, top: center_y - 5.0,
                            right: center_x + 2.0, bottom: center_y + 5.0,
                        };
                        state.d2d_context.FillRectangle(&spk_rect, &state.icon_brush);
                        // Sound waves
                        if state.system_audio_enabled {
                            state.d2d_context.DrawLine(
                                D2D_POINT_2F { x: center_x + 5.0, y: center_y - 6.0 },
                                D2D_POINT_2F { x: center_x + 5.0, y: center_y + 6.0 },
                                &state.icon_brush, 2.0, None
                            );
                            state.d2d_context.DrawLine(
                                D2D_POINT_2F { x: center_x + 9.0, y: center_y - 8.0 },
                                D2D_POINT_2F { x: center_x + 9.0, y: center_y + 8.0 },
                                &state.icon_brush, 2.0, None
                            );
                        } else {
                            state.d2d_context.DrawLine(
                                D2D_POINT_2F { x: rect.left + 6.0, y: rect.bottom - 6.0 },
                                D2D_POINT_2F { x: rect.right - 6.0, y: rect.top + 6.0 },
                                &state.disabled_brush, 2.0, None
                            );
                        }
                    }
                    PanelButton::Microphone => {
                        // Mic icon (rounded rect + stand)
                        let mic_body = windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT {
                            rect: D2D_RECT_F {
                                left: center_x - 4.0, top: center_y - 8.0,
                                right: center_x + 4.0, bottom: center_y + 2.0,
                            },
                            radiusX: 4.0, radiusY: 4.0,
                        };
                        let mic_brush = if state.mic_enabled { &state.record_button_brush } else { &state.icon_brush };
                        state.d2d_context.FillRoundedRectangle(&mic_body, mic_brush);
                        // Stand
                        state.d2d_context.DrawLine(
                            D2D_POINT_2F { x: center_x, y: center_y + 2.0 },
                            D2D_POINT_2F { x: center_x, y: center_y + 8.0 },
                            &state.icon_brush, 2.0, None
                        );
                        if !state.mic_enabled {
                            state.d2d_context.DrawLine(
                                D2D_POINT_2F { x: rect.left + 6.0, y: rect.bottom - 6.0 },
                                D2D_POINT_2F { x: rect.right - 6.0, y: rect.top + 6.0 },
                                &state.disabled_brush, 2.0, None
                            );
                        }
                    }
                    PanelButton::Capture => {
                        // Camera/screenshot icon
                        let cam_rect = D2D_RECT_F {
                            left: center_x - 10.0, top: center_y - 6.0,
                            right: center_x + 10.0, bottom: center_y + 8.0,
                        };
                        state.d2d_context.DrawRectangle(&cam_rect, &state.icon_brush, 2.0, None);
                        let lens = windows::Win32::Graphics::Direct2D::D2D1_ELLIPSE {
                            point: D2D_POINT_2F { x: center_x, y: center_y + 1.0 },
                            radiusX: 5.0,
                            radiusY: 5.0,
                        };
                        state.d2d_context.DrawEllipse(&lens, &state.icon_brush, 2.0, None);
                    }
                    PanelButton::Reselect => {
                        // Circular arrow (refresh icon)
                        let arc = windows::Win32::Graphics::Direct2D::D2D1_ELLIPSE {
                            point: D2D_POINT_2F { x: center_x, y: center_y },
                            radiusX: 8.0,
                            radiusY: 8.0,
                        };
                        state.d2d_context.DrawEllipse(&arc, &state.icon_brush, 2.0, None);
                        // Arrow head
                        state.d2d_context.DrawLine(
                            D2D_POINT_2F { x: center_x + 8.0, y: center_y },
                            D2D_POINT_2F { x: center_x + 4.0, y: center_y - 4.0 },
                            &state.icon_brush, 2.0, None
                        );
                        state.d2d_context.DrawLine(
                            D2D_POINT_2F { x: center_x + 8.0, y: center_y },
                            D2D_POINT_2F { x: center_x + 12.0, y: center_y - 4.0 },
                            &state.icon_brush, 2.0, None
                        );
                    }
                    PanelButton::Cancel => {
                        // X icon
                        state.d2d_context.DrawLine(
                            D2D_POINT_2F { x: center_x - 8.0, y: center_y - 8.0 },
                            D2D_POINT_2F { x: center_x + 8.0, y: center_y + 8.0 },
                            &state.icon_brush, 2.0, None
                        );
                        state.d2d_context.DrawLine(
                            D2D_POINT_2F { x: center_x + 8.0, y: center_y - 8.0 },
                            D2D_POINT_2F { x: center_x - 8.0, y: center_y + 8.0 },
                            &state.icon_brush, 2.0, None
                        );
                    }
                    PanelButton::None => {}
                }
            }
            
            // Draw dimensions display
            let sel_w = (state.sel_right - state.sel_left) as u32;
            let sel_h = (state.sel_bottom - state.sel_top) as u32;
            let dims_text = format!("{} x {}", sel_w, sel_h);
            let dims_text_wide: Vec<u16> = dims_text.encode_utf16().chain(std::iter::once(0)).collect();
            
            // Position after mic button, before capture button
            let dims_x = panel_x + PANEL_PADDING + (PANEL_BUTTON_SIZE + PANEL_BUTTON_GAP) * 4.0;
            let dims_y = panel_y + (PANEL_HEIGHT - 24.0) / 2.0;
            let dims_rect = D2D_RECT_F {
                left: dims_x,
                top: dims_y,
                right: dims_x + 100.0,
                bottom: dims_y + 24.0,
            };
            
            // Draw dims background
            let dims_rounded = windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT {
                rect: dims_rect,
                radiusX: 4.0,
                radiusY: 4.0,
            };
            state.d2d_context.FillRoundedRectangle(&dims_rounded, &state.panel_button_brush);
            
            state.d2d_context.DrawText(
                &dims_text_wide[..dims_text_wide.len() - 1],
                &state.text_format,
                &dims_rect,
                &state.text_brush,
                D2D1_DRAW_TEXT_OPTIONS_NONE,
                windows::Win32::Graphics::DirectWrite::DWRITE_MEASURING_MODE_NATURAL,
            );
            } // End of SHOW_D2D_PANEL block
        }
        
        state.d2d_context.EndDraw(None, None)?;
        
        // Present
        state.swap_chain.Present(1, windows::Win32::Graphics::Dxgi::DXGI_PRESENT(0)).ok()?;
        state.dcomp_device.Commit()?;
    }
    
    Ok(())
}

/// Window procedure for overlay
unsafe extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
    
    match msg {
        WM_CREATE => {
            LRESULT(0)
        }
        
        WM_SETCURSOR => {
            if (lparam.0 as u32 & 0xFFFF) == HTCLIENT as u32 {
                if !state_ptr.is_null() {
                    let state = &*state_ptr;
                    
                    if state.is_adjusting {
                        // Check if over panel button first (only if D2D panel is shown)
                        if SHOW_D2D_PANEL {
                            let (panel_x, panel_y, panel_width) = calculate_panel_position(
                                state.sel_left, state.sel_top, state.sel_right, state.sel_bottom,
                                state.monitor_x, state.monitor_y, state.monitor_width, state.monitor_height
                            );
                            let button = hit_test_panel_button(state.cursor_x, state.cursor_y, panel_x, panel_y, panel_width);
                            
                            if button != PanelButton::None {
                                // Show hand cursor for buttons
                                if let Ok(cursor) = LoadCursorW(None, IDC_HAND) {
                                    SetCursor(cursor);
                                    return LRESULT(1);
                                }
                            }
                        }
                        
                        // In adjustment mode - show appropriate resize cursor
                        let handle = if state.is_adjust_dragging {
                            // While dragging, keep showing the cursor for the handle being dragged
                            state.adjust_handle
                        } else {
                            // Check what's under cursor
                            hit_test_handle(state.cursor_x, state.cursor_y, 
                                          state.sel_left, state.sel_top, state.sel_right, state.sel_bottom)
                        };
                        
                        let cursor_id = match handle {
                            HandlePosition::TopLeft | HandlePosition::BottomRight => IDC_SIZENWSE,
                            HandlePosition::TopRight | HandlePosition::BottomLeft => IDC_SIZENESW,
                            HandlePosition::Top | HandlePosition::Bottom => IDC_SIZENS,
                            HandlePosition::Left | HandlePosition::Right => IDC_SIZEWE,
                            HandlePosition::Interior => IDC_SIZEALL,
                            HandlePosition::None => IDC_ARROW,
                        };
                        
                        if let Ok(cursor) = LoadCursorW(None, cursor_id) {
                            SetCursor(cursor);
                            return LRESULT(1);
                        }
                    } else {
                        // Normal mode - show crosshair
                        if let Ok(cursor) = LoadCursorW(None, IDC_CROSS) {
                            SetCursor(cursor);
                            return LRESULT(1);
                        }
                    }
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let _hdc = BeginPaint(hwnd, &mut ps);
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        
        WM_LBUTTONDOWN => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                let x = (lparam.0 & 0xFFFF) as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                
                if state.is_adjusting {
                    // Check panel button click first (only if D2D panel is shown)
                    let button = if SHOW_D2D_PANEL {
                        let (panel_x, panel_y, panel_width) = calculate_panel_position(
                            state.sel_left, state.sel_top, state.sel_right, state.sel_bottom,
                            state.monitor_x, state.monitor_y, state.monitor_width, state.monitor_height
                        );
                        hit_test_panel_button(x, y, panel_x, panel_y, panel_width)
                    } else {
                        PanelButton::None
                    };
                    
                    match button {
                        PanelButton::Record => {
                            // Start recording
                            let width = (state.sel_right - state.sel_left) as u32;
                            let height = (state.sel_bottom - state.sel_top) as u32;
                            let screen_x = state.monitor_x + state.sel_left;
                            let screen_y = state.monitor_y + state.sel_top;
                            state.selection_confirmed = true;
                            state.result_action = OverlayAction::StartRecording;
                            state.final_selection = Some((screen_x, screen_y, width, height));
                            state.should_close = true;
                        }
                        PanelButton::Webcam => {
                            state.webcam_enabled = !state.webcam_enabled;
                            let _ = render_overlay(state);
                        }
                        PanelButton::SystemAudio => {
                            state.system_audio_enabled = !state.system_audio_enabled;
                            let _ = render_overlay(state);
                        }
                        PanelButton::Microphone => {
                            state.mic_enabled = !state.mic_enabled;
                            let _ = render_overlay(state);
                        }
                        PanelButton::Capture => {
                            // Capture screenshot
                            let width = (state.sel_right - state.sel_left) as u32;
                            let height = (state.sel_bottom - state.sel_top) as u32;
                            let screen_x = state.monitor_x + state.sel_left;
                            let screen_y = state.monitor_y + state.sel_top;
                            state.selection_confirmed = true;
                            state.result_action = OverlayAction::CaptureScreenshot;
                            state.final_selection = Some((screen_x, screen_y, width, height));
                            state.should_close = true;
                        }
                        PanelButton::Reselect => {
                            // Go back to selection mode
                            state.is_adjusting = false;
                            state.sel_left = 0;
                            state.sel_top = 0;
                            state.sel_right = 0;
                            state.sel_bottom = 0;
                            let _ = render_overlay(state);
                        }
                        PanelButton::Cancel => {
                            state.should_close = true;
                            state.selection_confirmed = false;
                            state.result_action = OverlayAction::Cancelled;
                        }
                        PanelButton::None => {
                            // Check if clicking on a handle or inside selection
                            let handle = hit_test_handle(x, y, state.sel_left, state.sel_top, state.sel_right, state.sel_bottom);
                            if handle != HandlePosition::None {
                                state.adjust_handle = handle;
                                state.is_adjust_dragging = true;
                                state.adjust_drag_start_x = x;
                                state.adjust_drag_start_y = y;
                                // Store original selection bounds
                                state.orig_sel_left = state.sel_left;
                                state.orig_sel_top = state.sel_top;
                                state.orig_sel_right = state.sel_right;
                                state.orig_sel_bottom = state.sel_bottom;
                            }
                        }
                    }
                } else {
                    // Normal selection mode
                    state.is_selecting = true;
                    state.is_dragging = false;
                    state.start_x = x;
                    state.start_y = y;
                    state.current_x = x;
                    state.current_y = y;
                }
            }
            LRESULT(0)
        }
        
        WM_MOUSEMOVE => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                let x = (lparam.0 & 0xFFFF) as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
                
                state.cursor_x = x;
                state.cursor_y = y;
                
                if state.is_adjusting {
                    if state.is_adjust_dragging {
                        // Calculate delta from drag start
                        let dx = x - state.adjust_drag_start_x;
                        let dy = y - state.adjust_drag_start_y;
                        
                        // Apply delta based on which handle is being dragged
                        match state.adjust_handle {
                            HandlePosition::TopLeft => {
                                state.sel_left = state.orig_sel_left + dx;
                                state.sel_top = state.orig_sel_top + dy;
                            }
                            HandlePosition::Top => {
                                state.sel_top = state.orig_sel_top + dy;
                            }
                            HandlePosition::TopRight => {
                                state.sel_right = state.orig_sel_right + dx;
                                state.sel_top = state.orig_sel_top + dy;
                            }
                            HandlePosition::Right => {
                                state.sel_right = state.orig_sel_right + dx;
                            }
                            HandlePosition::BottomRight => {
                                state.sel_right = state.orig_sel_right + dx;
                                state.sel_bottom = state.orig_sel_bottom + dy;
                            }
                            HandlePosition::Bottom => {
                                state.sel_bottom = state.orig_sel_bottom + dy;
                            }
                            HandlePosition::BottomLeft => {
                                state.sel_left = state.orig_sel_left + dx;
                                state.sel_bottom = state.orig_sel_bottom + dy;
                            }
                            HandlePosition::Left => {
                                state.sel_left = state.orig_sel_left + dx;
                            }
                            HandlePosition::Interior => {
                                // Move entire selection
                                state.sel_left = state.orig_sel_left + dx;
                                state.sel_top = state.orig_sel_top + dy;
                                state.sel_right = state.orig_sel_right + dx;
                                state.sel_bottom = state.orig_sel_bottom + dy;
                            }
                            HandlePosition::None => {}
                        }
                        
                        // Ensure minimum size and correct orientation
                        if state.sel_right < state.sel_left + 20 {
                            state.sel_right = state.sel_left + 20;
                        }
                        if state.sel_bottom < state.sel_top + 20 {
                            state.sel_bottom = state.sel_top + 20;
                        }
                        
                        // Update React toolbar dimensions and position (throttled to ~20fps)
                        if !SHOW_D2D_PANEL {
                            let now = std::time::Instant::now();
                            if now.duration_since(state.last_event_emit_time).as_millis() >= 50 {
                                state.last_event_emit_time = now;
                                let sel_width = (state.sel_right - state.sel_left) as u32;
                                let sel_height = (state.sel_bottom - state.sel_top) as u32;
                                
                                // Convert selection to screen coordinates
                                let screen_sel_x = state.monitor_x + state.sel_left;
                                let screen_sel_y = state.monitor_y + state.sel_top;
                                let screen_sel_bottom = state.monitor_y + state.sel_bottom;
                                let screen_sel_center_x = screen_sel_x + sel_width as i32 / 2;
                                let screen_sel_center_y = screen_sel_y + sel_height as i32 / 2;
                                
                                if let Some(toolbar_window) = state.app_handle.get_webview_window("dcomp-toolbar") {
                                    // Update dimensions via JS
                                    let js = format!(
                                        "if (window.__updateDimensions) {{ window.__updateDimensions({}, {}); }}",
                                        sel_width, sel_height
                                    );
                                    let _ = toolbar_window.eval(&js);
                                    
                                    // Calculate toolbar position
                                    let toolbar_width = 380i32;
                                    let toolbar_height = 56i32;
                                    
                                    // Find which monitor contains the selection center
                                    let (pos_x, pos_y) = if let Ok(monitors) = xcap::Monitor::all() {
                                        // Find the monitor containing selection center
                                        let current_monitor = monitors.iter().find(|m| {
                                            let mx = m.x().unwrap_or(0);
                                            let my = m.y().unwrap_or(0);
                                            let mw = m.width().unwrap_or(1920) as i32;
                                            let mh = m.height().unwrap_or(1080) as i32;
                                            screen_sel_center_x >= mx && screen_sel_center_x < mx + mw &&
                                            screen_sel_center_y >= my && screen_sel_center_y < my + mh
                                        });
                                        
                                        if let Some(cur_mon) = current_monitor {
                                            let cur_x = cur_mon.x().unwrap_or(0);
                                            let cur_y = cur_mon.y().unwrap_or(0);
                                            let cur_w = cur_mon.width().unwrap_or(1920);
                                            let cur_h = cur_mon.height().unwrap_or(1080);
                                            
                                            // Check if selection is fullscreen on this monitor (>90%)
                                            let is_fullscreen = sel_width >= (cur_w * 9 / 10) 
                                                && sel_height >= (cur_h * 9 / 10);
                                            
                                            if is_fullscreen {
                                                // Find alternate monitor
                                                let alternate = monitors.iter().find(|m| {
                                                    let mx = m.x().unwrap_or(0);
                                                    let my = m.y().unwrap_or(0);
                                                    mx != cur_x || my != cur_y
                                                });
                                                
                                                if let Some(alt_mon) = alternate {
                                                    // Place in center of alternate monitor
                                                    let alt_x = alt_mon.x().unwrap_or(0);
                                                    let alt_y = alt_mon.y().unwrap_or(0);
                                                    let alt_w = alt_mon.width().unwrap_or(1920) as i32;
                                                    let alt_h = alt_mon.height().unwrap_or(1080) as i32;
                                                    (
                                                        alt_x + (alt_w - toolbar_width) / 2,
                                                        alt_y + (alt_h - toolbar_height) / 2
                                                    )
                                                } else {
                                                    // No alternate monitor, place inside selection
                                                    (
                                                        screen_sel_x + (sel_width as i32 - toolbar_width) / 2,
                                                        screen_sel_bottom - toolbar_height - 60
                                                    )
                                                }
                                            } else {
                                                // Normal selection: place below selection
                                                (
                                                    screen_sel_x + (sel_width as i32 - toolbar_width) / 2,
                                                    screen_sel_bottom + 12
                                                )
                                            }
                                        } else {
                                            // Fallback: below selection
                                            (
                                                screen_sel_x + (sel_width as i32 - toolbar_width) / 2,
                                                screen_sel_bottom + 12
                                            )
                                        }
                                    } else {
                                        // No monitor info, use simple positioning
                                        (
                                            screen_sel_x + (sel_width as i32 - toolbar_width) / 2,
                                            screen_sel_bottom + 12
                                        )
                                    };
                                    
                                    // Reposition and bring to front
                                    if let Ok(hwnd) = toolbar_window.hwnd() {
                                        let _ = SetWindowPos(
                                            HWND(hwnd.0),
                                            HWND_TOPMOST,
                                            pos_x, pos_y,
                                            toolbar_width, toolbar_height,
                                            SWP_NOACTIVATE
                                        );
                                    }
                                }
                            }
                        }
                    } else {
                        // Not dragging - update hovered button (only if D2D panel is shown)
                        if SHOW_D2D_PANEL {
                            let (panel_x, panel_y, panel_width) = calculate_panel_position(
                                state.sel_left, state.sel_top, state.sel_right, state.sel_bottom,
                                state.monitor_x, state.monitor_y, state.monitor_width, state.monitor_height
                            );
                            let new_hovered = hit_test_panel_button(x, y, panel_x, panel_y, panel_width);
                            if new_hovered != state.hovered_button {
                                state.hovered_button = new_hovered;
                                // Re-render to show hover effect
                            }
                        }
                    }
                } else if state.is_selecting {
                    state.current_x = x;
                    state.current_y = y;
                    
                    // Check if we've dragged enough to enter region selection mode
                    let dx = (x - state.start_x).abs();
                    let dy = (y - state.start_y).abs();
                    if dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD {
                        state.is_dragging = true;
                        state.hovered_window = None; // Clear window detection when dragging
                    }
                } else {
                    // Window detection mode - find window under cursor
                    let screen_x = state.monitor_x + x;
                    let screen_y = state.monitor_y + y;
                    state.hovered_window = get_window_at_screen_point(screen_x, screen_y, state.overlay_hwnd);
                }
                
                let _ = render_overlay(state);
            }
            LRESULT(0)
        }
        
        WM_LBUTTONUP => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                
                if state.is_adjusting {
                    // End adjustment drag - emit final dimensions
                    if state.is_adjust_dragging && !SHOW_D2D_PANEL {
                        let screen_x = state.monitor_x + state.sel_left;
                        let screen_y = state.monitor_y + state.sel_top;
                        let width = (state.sel_right - state.sel_left) as u32;
                        let height = (state.sel_bottom - state.sel_top) as u32;
                        
                        // Emit directly to the toolbar window
                        if let Some(toolbar_window) = state.app_handle.get_webview_window("dcomp-toolbar") {
                            let payload = OverlayAdjustmentEvent {
                                x: screen_x,
                                y: screen_y,
                                width,
                                height,
                            };
                            
                            // Use window's emit method for direct targeting
                            if let Err(e) = toolbar_window.emit("dcomp-overlay-selection-updated", &payload) {
                                eprintln!("Failed to emit to toolbar on mouse up: {:?}", e);
                            }
                            
                            // Bring toolbar to front using Win32 API
                            if let Ok(hwnd) = toolbar_window.hwnd() {
                                let _ = SetWindowPos(
                                    HWND(hwnd.0),
                                    HWND_TOPMOST,
                                    0, 0, 0, 0,
                                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
                                );
                            }
                        }
                    }
                    state.is_adjust_dragging = false;
                    state.adjust_handle = HandlePosition::None;
                    let _ = render_overlay(state);
                } else if state.is_selecting {
                    state.is_selecting = false;
                    
                    if state.is_dragging {
                        // Region selection completed - enter adjustment mode
                        let mut x1 = state.start_x.min(state.current_x);
                        let mut y1 = state.start_y.min(state.current_y);
                        let mut x2 = state.start_x.max(state.current_x);
                        let mut y2 = state.start_y.max(state.current_y);
                        
                        // Apply square constraint if Shift is held
                        if state.shift_held {
                            let sel_width = x2 - x1;
                            let sel_height = y2 - y1;
                            let size = sel_width.max(sel_height);
                            
                            if state.current_x >= state.start_x {
                                x2 = x1 + size;
                            } else {
                                x1 = x2 - size;
                            }
                            if state.current_y >= state.start_y {
                                y2 = y1 + size;
                            } else {
                                y1 = y2 - size;
                            }
                        }
                        
                        let width = (x2 - x1) as u32;
                        let height = (y2 - y1) as u32;
                        
                        if width > 10 && height > 10 {
                            // Enter adjustment mode instead of closing
                            state.sel_left = x1;
                            state.sel_top = y1;
                            state.sel_right = x2;
                            state.sel_bottom = y2;
                            state.is_adjusting = true;
                            state.is_dragging = false;
                            
                            // Show and position React toolbar (when D2D panel is hidden)
                            if !SHOW_D2D_PANEL {
                                let screen_x = state.monitor_x + state.sel_left;
                                let screen_y = state.monitor_y + state.sel_top;
                                
                                // Emit event to create/show toolbar window
                                let _ = state.app_handle.emit("dcomp-overlay-adjustment-ready", OverlayAdjustmentEvent {
                                    x: screen_x,
                                    y: screen_y,
                                    width,
                                    height,
                                });
                                
                                // Give the window time to be created, then position it correctly
                                // Uses xcap::Monitor::all() for accurate multi-monitor detection
                                std::thread::sleep(std::time::Duration::from_millis(50));
                                
                                if let Some(toolbar_window) = state.app_handle.get_webview_window("dcomp-toolbar") {
                                    let toolbar_width = 380i32;
                                    let toolbar_height = 56i32;
                                    let screen_sel_bottom = screen_y + height as i32;
                                    let screen_sel_center_x = screen_x + width as i32 / 2;
                                    let screen_sel_center_y = screen_y + height as i32 / 2;
                                    
                                    let (pos_x, pos_y) = if let Ok(monitors) = xcap::Monitor::all() {
                                        let current_monitor = monitors.iter().find(|m| {
                                            let mx = m.x().unwrap_or(0);
                                            let my = m.y().unwrap_or(0);
                                            let mw = m.width().unwrap_or(1920) as i32;
                                            let mh = m.height().unwrap_or(1080) as i32;
                                            screen_sel_center_x >= mx && screen_sel_center_x < mx + mw &&
                                            screen_sel_center_y >= my && screen_sel_center_y < my + mh
                                        });
                                        
                                        if let Some(cur_mon) = current_monitor {
                                            let cur_x = cur_mon.x().unwrap_or(0);
                                            let cur_y = cur_mon.y().unwrap_or(0);
                                            let cur_w = cur_mon.width().unwrap_or(1920);
                                            let cur_h = cur_mon.height().unwrap_or(1080);
                                            
                                            let is_fullscreen = width >= (cur_w * 9 / 10) && height >= (cur_h * 9 / 10);
                                            
                                            if is_fullscreen {
                                                let alternate = monitors.iter().find(|m| {
                                                    let mx = m.x().unwrap_or(0);
                                                    let my = m.y().unwrap_or(0);
                                                    mx != cur_x || my != cur_y
                                                });
                                                
                                                if let Some(alt_mon) = alternate {
                                                    let alt_x = alt_mon.x().unwrap_or(0);
                                                    let alt_y = alt_mon.y().unwrap_or(0);
                                                    let alt_w = alt_mon.width().unwrap_or(1920) as i32;
                                                    let alt_h = alt_mon.height().unwrap_or(1080) as i32;
                                                    (alt_x + (alt_w - toolbar_width) / 2, alt_y + (alt_h - toolbar_height) / 2)
                                                } else {
                                                    (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom - toolbar_height - 60)
                                                }
                                            } else {
                                                (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom + 12)
                                            }
                                        } else {
                                            (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom + 12)
                                        }
                                    } else {
                                        (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom + 12)
                                    };
                                    
                                    if let Ok(hwnd) = toolbar_window.hwnd() {
                                        let _ = SetWindowPos(HWND(hwnd.0), HWND_TOPMOST, pos_x, pos_y, toolbar_width, toolbar_height, SWP_NOACTIVATE);
                                    }
                                }
                            }
                            
                            let _ = render_overlay(state);
                        } else {
                            state.is_dragging = false;
                        }
                    } else if let Some(ref win) = state.hovered_window {
                        // Window selection - enter adjustment mode with window bounds
                        let local_x = win.x - state.monitor_x;
                        let local_y = win.y - state.monitor_y;
                        state.sel_left = local_x;
                        state.sel_top = local_y;
                        state.sel_right = local_x + win.width as i32;
                        state.sel_bottom = local_y + win.height as i32;
                        state.is_adjusting = true;
                        
                        // Show and position React toolbar (when D2D panel is hidden)
                        if !SHOW_D2D_PANEL {
                            let screen_x = state.monitor_x + state.sel_left;
                            let screen_y = state.monitor_y + state.sel_top;
                            let sel_width = (state.sel_right - state.sel_left) as u32;
                            let sel_height = (state.sel_bottom - state.sel_top) as u32;
                            
                            // Emit event to create/show toolbar window
                            let _ = state.app_handle.emit("dcomp-overlay-adjustment-ready", OverlayAdjustmentEvent {
                                x: screen_x,
                                y: screen_y,
                                width: sel_width,
                                height: sel_height,
                            });
                            
                            // Give the window time to be created, then position it correctly
                            // Uses xcap::Monitor::all() for accurate multi-monitor detection
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            
                            if let Some(toolbar_window) = state.app_handle.get_webview_window("dcomp-toolbar") {
                                let toolbar_width = 380i32;
                                let toolbar_height = 56i32;
                                let screen_sel_bottom = screen_y + sel_height as i32;
                                let screen_sel_center_x = screen_x + sel_width as i32 / 2;
                                let screen_sel_center_y = screen_y + sel_height as i32 / 2;
                                
                                let (pos_x, pos_y) = if let Ok(monitors) = xcap::Monitor::all() {
                                    let current_monitor = monitors.iter().find(|m| {
                                        let mx = m.x().unwrap_or(0);
                                        let my = m.y().unwrap_or(0);
                                        let mw = m.width().unwrap_or(1920) as i32;
                                        let mh = m.height().unwrap_or(1080) as i32;
                                        screen_sel_center_x >= mx && screen_sel_center_x < mx + mw &&
                                        screen_sel_center_y >= my && screen_sel_center_y < my + mh
                                    });
                                    
                                    if let Some(cur_mon) = current_monitor {
                                        let cur_x = cur_mon.x().unwrap_or(0);
                                        let cur_y = cur_mon.y().unwrap_or(0);
                                        let cur_w = cur_mon.width().unwrap_or(1920);
                                        let cur_h = cur_mon.height().unwrap_or(1080);
                                        
                                        let is_fullscreen = sel_width >= (cur_w * 9 / 10) && sel_height >= (cur_h * 9 / 10);
                                        
                                        if is_fullscreen {
                                            let alternate = monitors.iter().find(|m| {
                                                let mx = m.x().unwrap_or(0);
                                                let my = m.y().unwrap_or(0);
                                                mx != cur_x || my != cur_y
                                            });
                                            
                                            if let Some(alt_mon) = alternate {
                                                let alt_x = alt_mon.x().unwrap_or(0);
                                                let alt_y = alt_mon.y().unwrap_or(0);
                                                let alt_w = alt_mon.width().unwrap_or(1920) as i32;
                                                let alt_h = alt_mon.height().unwrap_or(1080) as i32;
                                                (alt_x + (alt_w - toolbar_width) / 2, alt_y + (alt_h - toolbar_height) / 2)
                                            } else {
                                                (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom - toolbar_height - 60)
                                            }
                                        } else {
                                            (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom + 12)
                                        }
                                    } else {
                                        (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom + 12)
                                    }
                                } else {
                                    (screen_sel_center_x - toolbar_width / 2, screen_sel_bottom + 12)
                                };
                                
                                if let Ok(hwnd) = toolbar_window.hwnd() {
                                    let _ = SetWindowPos(HWND(hwnd.0), HWND_TOPMOST, pos_x, pos_y, toolbar_width, toolbar_height, SWP_NOACTIVATE);
                                }
                            }
                        }
                        
                        state.hovered_window = None;
                        let _ = render_overlay(state);
                    }
                }
            }
            LRESULT(0)
        }
        
        WM_KEYDOWN => {
            let key = wparam.0 as u32;
            if key == 0x1B { // ESC
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    if state.is_adjusting {
                        // In adjustment mode, ESC cancels and closes
                        state.is_adjusting = false;
                    }
                    state.should_close = true;
                    state.selection_confirmed = false;
                }
            } else if key == 0x0D { // VK_RETURN (Enter)
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    if state.is_adjusting {
                        // Confirm the selection
                        let width = (state.sel_right - state.sel_left) as u32;
                        let height = (state.sel_bottom - state.sel_top) as u32;
                        
                        if width > 10 && height > 10 {
                            let screen_x = state.monitor_x + state.sel_left;
                            let screen_y = state.monitor_y + state.sel_top;
                            
                            state.selection_confirmed = true;
                            state.final_selection = Some((screen_x, screen_y, width, height));
                            state.should_close = true;
                        }
                    }
                }
            } else if key == 0x10 { // VK_SHIFT
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    state.shift_held = true;
                    let _ = render_overlay(state);
                }
            }
            LRESULT(0)
        }
        
        WM_KEYUP => {
            let key = wparam.0 as u32;
            if key == 0x10 { // VK_SHIFT
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    state.shift_held = false;
                    let _ = render_overlay(state);
                }
            }
            LRESULT(0)
        }
        
        WM_RBUTTONDOWN => {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                state.should_close = true;
                state.selection_confirmed = false;
            }
            LRESULT(0)
        }
        
        WM_DESTROY => {
            LRESULT(0)
        }
        
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Register the overlay window class
fn register_overlay_class() -> windows::core::Result<()> {
    if OVERLAY_CLASS_REGISTERED.load(Ordering::SeqCst) {
        return Ok(());
    }
    
    unsafe {
        let hinstance = GetModuleHandleW(None)?;
        
        let class_name: Vec<u16> = OVERLAY_CLASS_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            hCursor: LoadCursorW(None, IDC_CROSS)?,
            ..Default::default()
        };
        
        let atom = RegisterClassW(&wc);
        if atom == 0 {
            return Err(windows::core::Error::from_win32());
        }
        
        OVERLAY_CLASS_REGISTERED.store(true, Ordering::SeqCst);
    }
    
    Ok(())
}

/// Create and show DirectComposition overlay for a monitor
pub fn show_dcomp_overlay(
    app: AppHandle,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> Result<Option<(i32, i32, u32, u32)>, String> {
    register_overlay_class().map_err(|e| format!("Failed to register class: {:?}", e))?;
    
    unsafe {
        let hinstance = GetModuleHandleW(None)
            .map_err(|e| format!("Failed to get module handle: {:?}", e))?;
        
        let class_name: Vec<u16> = OVERLAY_CLASS_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        
        let ex_style = WINDOW_EX_STYLE(
            WS_EX_NOREDIRECTIONBITMAP | 
            WS_EX_TOPMOST.0 | 
            WS_EX_TOOLWINDOW.0 |
            WS_EX_NOACTIVATE.0
        );
        
        let hwnd = CreateWindowExW(
            ex_style,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_POPUP,
            monitor_x,
            monitor_y,
            monitor_width as i32,
            monitor_height as i32,
            None,
            None,
            hinstance,
            None,
        ).map_err(|e| format!("Failed to create window: {:?}", e))?;
        
        // Initialize graphics
        let d3d_device = create_d3d11_device()
            .map_err(|e| format!("Failed to create D3D11 device: {:?}", e))?;
        
        let swap_chain = create_swap_chain(&d3d_device, monitor_width, monitor_height)
            .map_err(|e| format!("Failed to create swap chain: {:?}", e))?;
        
        let (dcomp_device, dcomp_target, dcomp_visual) = 
            create_dcomp(&d3d_device, hwnd, &swap_chain)
                .map_err(|e| format!("Failed to create DirectComposition: {:?}", e))?;
        
        let (_d2d_factory, d2d_context) = create_d2d_context(&d3d_device)
            .map_err(|e| format!("Failed to create Direct2D context: {:?}", e))?;
        
        // Create brushes using ID2D1RenderTarget interface
        let render_target: ID2D1RenderTarget = d2d_context.cast()
            .map_err(|e| format!("Failed to cast to render target: {:?}", e))?;
        
        let brush_props = D2D1_BRUSH_PROPERTIES {
            opacity: 1.0,
            transform: Matrix3x2::identity(),
        };
        
        let overlay_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.5 },
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create overlay brush: {:?}", e))?;
        
        let border_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.0, g: 0.47, b: 1.0, a: 1.0 }, // Blue
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create border brush: {:?}", e))?;
        
        let crosshair_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 0.7 }, // White semi-transparent
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create crosshair brush: {:?}", e))?;
        
        let text_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }, // White
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create text brush: {:?}", e))?;
        
        let text_bg_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.75 }, // Dark semi-transparent
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create text bg brush: {:?}", e))?;
        
        let handle_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }, // White fill
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create handle brush: {:?}", e))?;
        
        let handle_border_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.0, g: 0.47, b: 1.0, a: 1.0 }, // Blue border (same as selection)
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create handle border brush: {:?}", e))?;
        
        // Panel brushes
        let panel_bg_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.15, g: 0.15, b: 0.15, a: 0.95 }, // Dark gray panel background
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create panel bg brush: {:?}", e))?;
        
        let panel_button_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.25, g: 0.25, b: 0.25, a: 1.0 }, // Button background
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create panel button brush: {:?}", e))?;
        
        let panel_button_hover_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.35, g: 0.35, b: 0.35, a: 1.0 }, // Hovered button
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create panel button hover brush: {:?}", e))?;
        
        let record_button_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.8, g: 0.2, b: 0.2, a: 1.0 }, // Red for record
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create record button brush: {:?}", e))?;
        
        let icon_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.9, g: 0.9, b: 0.9, a: 1.0 }, // Light gray icons
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create icon brush: {:?}", e))?;
        
        let disabled_brush = render_target.CreateSolidColorBrush(
            &D2D1_COLOR_F { r: 0.9, g: 0.3, b: 0.3, a: 1.0 }, // Red for disabled slash
            Some(&brush_props),
        ).map_err(|e| format!("Failed to create disabled brush: {:?}", e))?;
        
        // Create DirectWrite factory and text format
        let dwrite_factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|e| format!("Failed to create DirectWrite factory: {:?}", e))?;
        
        let font_name: Vec<u16> = "Segoe UI".encode_utf16().chain(std::iter::once(0)).collect();
        let locale: Vec<u16> = "en-US".encode_utf16().chain(std::iter::once(0)).collect();
        
        let text_format = dwrite_factory.CreateTextFormat(
            PCWSTR(font_name.as_ptr()),
            None,
            DWRITE_FONT_WEIGHT_BOLD,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            14.0,
            PCWSTR(locale.as_ptr()),
        ).map_err(|e| format!("Failed to create text format: {:?}", e))?;
        
        text_format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)
            .map_err(|e| format!("Failed to set text alignment: {:?}", e))?;
        text_format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)
            .map_err(|e| format!("Failed to set paragraph alignment: {:?}", e))?;
        
        // Create state on heap
        let mut state = Box::new(OverlayState {
            app_handle: app,
            is_selecting: false,
            is_dragging: false,
            shift_held: false,
            // Adjustment mode fields
            is_adjusting: false,
            adjust_handle: HandlePosition::None,
            is_adjust_dragging: false,
            adjust_drag_start_x: 0,
            adjust_drag_start_y: 0,
            sel_left: 0,
            sel_top: 0,
            sel_right: 0,
            sel_bottom: 0,
            orig_sel_left: 0,
            orig_sel_top: 0,
            orig_sel_right: 0,
            orig_sel_bottom: 0,
            // Initial selection coords
            start_x: 0,
            start_y: 0,
            current_x: 0,
            current_y: 0,
            cursor_x: 0,
            cursor_y: 0,
            hovered_window: None,
            monitor_x,
            monitor_y,
            monitor_width,
            monitor_height,
            overlay_hwnd: hwnd,
            swap_chain,
            dcomp_device,
            _dcomp_target: dcomp_target,
            _dcomp_visual: dcomp_visual,
            d2d_context,
            overlay_brush,
            border_brush,
            crosshair_brush,
            text_brush,
            text_bg_brush,
            handle_brush,
            handle_border_brush,
            panel_bg_brush,
            panel_button_brush,
            panel_button_hover_brush,
            record_button_brush,
            icon_brush,
            disabled_brush,
            text_format,
            // Panel state
            hovered_button: PanelButton::None,
            webcam_enabled: false,
            system_audio_enabled: true,
            mic_enabled: true,
            should_close: false,
            last_event_emit_time: std::time::Instant::now(),
            selection_confirmed: false,
            result_action: OverlayAction::Cancelled,
            final_selection: None,
        });
        
        // Store state pointer in window
        let state_ptr = &mut *state as *mut OverlayState;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
        
        // Initial render
        render_overlay(&state).map_err(|e| format!("Failed to render: {:?}", e))?;
        
        // Show window
        let _ = ShowWindow(hwnd, SW_SHOW);
        
        // Force window to foreground to receive input
        let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        
        // Message loop
        let mut msg = MSG::default();
        loop {
            if state.should_close {
                break;
            }
            
            // Check for pending commands from React toolbar
            if state.is_adjusting && !SHOW_D2D_PANEL {
                match take_pending_command() {
                    OverlayCommand::ConfirmRecording => {
                        let width = (state.sel_right - state.sel_left) as u32;
                        let height = (state.sel_bottom - state.sel_top) as u32;
                        let screen_x = state.monitor_x + state.sel_left;
                        let screen_y = state.monitor_y + state.sel_top;
                        state.selection_confirmed = true;
                        state.result_action = OverlayAction::StartRecording;
                        state.final_selection = Some((screen_x, screen_y, width, height));
                        state.should_close = true;
                    }
                    OverlayCommand::ConfirmScreenshot => {
                        let width = (state.sel_right - state.sel_left) as u32;
                        let height = (state.sel_bottom - state.sel_top) as u32;
                        let screen_x = state.monitor_x + state.sel_left;
                        let screen_y = state.monitor_y + state.sel_top;
                        state.selection_confirmed = true;
                        state.result_action = OverlayAction::CaptureScreenshot;
                        state.final_selection = Some((screen_x, screen_y, width, height));
                        state.should_close = true;
                    }
                    OverlayCommand::Reselect => {
                        // Go back to selection mode
                        state.is_adjusting = false;
                        state.sel_left = 0;
                        state.sel_top = 0;
                        state.sel_right = 0;
                        state.sel_bottom = 0;
                        // Emit event to hide toolbar
                        let _ = state.app_handle.emit("dcomp-overlay-closed", ());
                        let _ = render_overlay(&state);
                    }
                    OverlayCommand::Cancel => {
                        state.should_close = true;
                        state.selection_confirmed = false;
                        state.result_action = OverlayAction::Cancelled;
                    }
                    OverlayCommand::None => {}
                }
            }
            
            if PeekMessageW(&mut msg, hwnd, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == 0x0012 { // WM_QUIT
                    break;
                }
                let _ = windows::Win32::UI::WindowsAndMessaging::TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        
        let result = if state.selection_confirmed {
            state.final_selection
        } else {
            None
        };
        
        // Emit overlay closed event for React toolbar
        if !SHOW_D2D_PANEL {
            let _ = state.app_handle.emit("dcomp-overlay-closed", ());
        }
        
        // Clear window user data before cleanup
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);
        
        Ok(result)
    }
}

/// Tauri command to show DirectComposition overlay for video/gif selection
/// Spans the entire virtual screen (all monitors) for seamless multi-monitor support
#[tauri::command]
pub async fn show_dcomp_video_overlay(
    app: AppHandle,
    _monitor_index: Option<usize>, // Ignored - we now span all monitors
) -> Result<Option<(i32, i32, u32, u32)>, String> {
    let app_clone = app.clone();
    
    // Get virtual screen bounds (spans all monitors)
    let (vscreen_x, vscreen_y, vscreen_width, vscreen_height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN) as u32,
            GetSystemMetrics(SM_CYVIRTUALSCREEN) as u32,
        )
    };
    
    tokio::task::spawn_blocking(move || {
        show_dcomp_overlay(app_clone, vscreen_x, vscreen_y, vscreen_width, vscreen_height)
    })
    .await
    .map_err(|e| format!("Task failed: {:?}", e))?
}

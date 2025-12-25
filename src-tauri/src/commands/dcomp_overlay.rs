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

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

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
    D2D1_BRUSH_PROPERTIES,
};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_COLOR_F, D2D_RECT_F, D2D_POINT_2F, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT,
};
use windows::Win32::Graphics::Gdi::{BeginPaint, EndPaint, PAINTSTRUCT};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetWindowLongPtrW, SetWindowLongPtrW, GetWindowRect, GetAncestor,
    LoadCursorW, PeekMessageW, RegisterClassW, SetCursor,
    ShowWindow, WindowFromPoint, IsWindowVisible, GetWindowLongW,
    CS_HREDRAW, CS_VREDRAW, IDC_CROSS, MSG, PM_REMOVE, GA_ROOT,
    SW_SHOW, WINDOW_EX_STYLE, WNDCLASSW, WS_POPUP, GWL_STYLE, GWL_EXSTYLE,
    WM_CREATE, WM_DESTROY, WM_PAINT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_KEYDOWN, WM_RBUTTONDOWN, WM_SETCURSOR, WS_EX_TOPMOST, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE,
    WS_CHILD, WS_EX_APPWINDOW,
    GWLP_USERDATA, HTCLIENT,
};

// Extended window style for no redirection bitmap
const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000;

/// Detected window under cursor
#[derive(Clone, Default)]
struct DetectedWindow {
    hwnd: isize,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Overlay state - stored in window user data
struct OverlayState {
    // Mode: true = region selection in progress, false = window detection mode
    is_selecting: bool,
    is_dragging: bool, // True if user has dragged more than threshold
    
    // Selection coordinates (local to monitor)
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
    
    // Control
    should_close: bool,
    
    // Result
    selection_confirmed: bool,
    final_selection: Option<(i32, i32, u32, u32)>,
}

static OVERLAY_CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);
const OVERLAY_CLASS_NAME: &str = "SnapItDCompOverlay";
const DRAG_THRESHOLD: i32 = 5;

/// Get the top-level window at a screen point, excluding our overlay
fn get_window_at_screen_point(screen_x: i32, screen_y: i32, exclude_hwnd: HWND) -> Option<DetectedWindow> {
    unsafe {
        let point = POINT { x: screen_x, y: screen_y };
        let hwnd = WindowFromPoint(point);
        
        if hwnd.0.is_null() || hwnd == exclude_hwnd {
            return None;
        }
        
        // Get the root/top-level window
        let root_hwnd = GetAncestor(hwnd, GA_ROOT);
        let target_hwnd = if !root_hwnd.0.is_null() { root_hwnd } else { hwnd };
        
        // Skip if it's our overlay or not visible
        if target_hwnd == exclude_hwnd || !IsWindowVisible(target_hwnd).as_bool() {
            return None;
        }
        
        // Skip tool windows and other non-app windows
        let ex_style = GetWindowLongW(target_hwnd, GWL_EXSTYLE) as u32;
        let style = GetWindowLongW(target_hwnd, GWL_STYLE) as u32;
        
        // Skip child windows
        if (style & WS_CHILD.0) != 0 {
            return None;
        }
        
        // Skip tool windows unless they have WS_EX_APPWINDOW
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 && (ex_style & WS_EX_APPWINDOW.0) == 0 {
            return None;
        }
        
        // Get window rect
        let mut rect = RECT::default();
        if GetWindowRect(target_hwnd, &mut rect).is_err() {
            return None;
        }
        
        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;
        
        // Skip tiny windows
        if width < 50 || height < 50 {
            return None;
        }
        
        Some(DetectedWindow {
            hwnd: target_hwnd.0 as isize,
            x: rect.left,
            y: rect.top,
            width,
            height,
        })
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
        let clear_rect: Option<D2D_RECT_F> = if state.is_dragging {
            // Region selection mode - show selection rectangle
            let sel_x1 = state.start_x.min(state.current_x) as f32;
            let sel_y1 = state.start_y.min(state.current_y) as f32;
            let sel_x2 = state.start_x.max(state.current_x) as f32;
            let sel_y2 = state.start_y.max(state.current_y) as f32;
            Some(D2D_RECT_F { left: sel_x1, top: sel_y1, right: sel_x2, bottom: sel_y2 })
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
            
            if right > left && bottom > top {
                Some(D2D_RECT_F { left, top, right, bottom })
            } else {
                None
            }
        } else {
            None
        };
        
        if let Some(rect) = clear_rect {
            // Draw overlay around the clear area (4 rectangles)
            // Top
            if rect.top > 0.0 {
                state.d2d_context.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: rect.top },
                    &state.overlay_brush,
                );
            }
            // Bottom
            if rect.bottom < height {
                state.d2d_context.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: rect.bottom, right: width, bottom: height },
                    &state.overlay_brush,
                );
            }
            // Left
            if rect.left > 0.0 {
                state.d2d_context.FillRectangle(
                    &D2D_RECT_F { left: 0.0, top: rect.top, right: rect.left, bottom: rect.bottom },
                    &state.overlay_brush,
                );
            }
            // Right
            if rect.right < width {
                state.d2d_context.FillRectangle(
                    &D2D_RECT_F { left: rect.right, top: rect.top, right: width, bottom: rect.bottom },
                    &state.overlay_brush,
                );
            }
            
            // Draw border around the selection/window
            state.d2d_context.DrawRectangle(
                &rect,
                &state.border_brush,
                2.0,
                None,
            );
        } else {
            // No selection - draw full overlay with crosshair
            state.d2d_context.FillRectangle(
                &D2D_RECT_F { left: 0.0, top: 0.0, right: width, bottom: height },
                &state.overlay_brush,
            );
        }
        
        // Draw crosshair at cursor position (always visible)
        let cx = state.cursor_x as f32;
        let cy = state.cursor_y as f32;
        
        // Horizontal line
        state.d2d_context.DrawLine(
            D2D_POINT_2F { x: 0.0, y: cy },
            D2D_POINT_2F { x: width, y: cy },
            &state.crosshair_brush,
            1.0,
            None,
        );
        // Vertical line
        state.d2d_context.DrawLine(
            D2D_POINT_2F { x: cx, y: 0.0 },
            D2D_POINT_2F { x: cx, y: height },
            &state.crosshair_brush,
            1.0,
            None,
        );
        
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
            // Always show crosshair cursor
            if (lparam.0 as u32 & 0xFFFF) == HTCLIENT as u32 {
                if let Ok(cursor) = LoadCursorW(None, IDC_CROSS) {
                    SetCursor(cursor);
                    return LRESULT(1);
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
                
                state.is_selecting = true;
                state.is_dragging = false;
                state.start_x = x;
                state.start_y = y;
                state.current_x = x;
                state.current_y = y;
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
                
                if state.is_selecting {
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
                
                if state.is_selecting {
                    state.is_selecting = false;
                    
                    if state.is_dragging {
                        // Region selection completed
                        let x1 = state.start_x.min(state.current_x);
                        let y1 = state.start_y.min(state.current_y);
                        let x2 = state.start_x.max(state.current_x);
                        let y2 = state.start_y.max(state.current_y);
                        
                        let width = (x2 - x1) as u32;
                        let height = (y2 - y1) as u32;
                        
                        if width > 10 && height > 10 {
                            let screen_x = state.monitor_x + x1;
                            let screen_y = state.monitor_y + y1;
                            
                            state.selection_confirmed = true;
                            state.final_selection = Some((screen_x, screen_y, width, height));
                            state.should_close = true;
                        }
                        state.is_dragging = false;
                    } else if let Some(ref win) = state.hovered_window {
                        // Window selection - user clicked on a detected window
                        state.selection_confirmed = true;
                        state.final_selection = Some((win.x, win.y, win.width, win.height));
                        state.should_close = true;
                    }
                }
            }
            LRESULT(0)
        }
        
        WM_RBUTTONDOWN | WM_KEYDOWN => {
            let key = wparam.0 as u32;
            if msg == WM_RBUTTONDOWN || key == 0x1B { // ESC
                if !state_ptr.is_null() {
                    let state = &mut *state_ptr;
                    state.should_close = true;
                    state.selection_confirmed = false;
                }
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
    _app: &AppHandle,
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
        
        // Create state on heap
        let mut state = Box::new(OverlayState {
            is_selecting: false,
            is_dragging: false,
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
            should_close: false,
            selection_confirmed: false,
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
        
        // Clear window user data before cleanup
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);
        
        Ok(result)
    }
}

/// Tauri command to show DirectComposition overlay for video/gif selection
#[tauri::command]
pub async fn show_dcomp_video_overlay(
    app: AppHandle,
    monitor_index: usize,
) -> Result<Option<(i32, i32, u32, u32)>, String> {
    use super::capture::fallback::get_monitors;
    
    let monitors = get_monitors().map_err(|e| format!("Failed to get monitors: {:?}", e))?;
    
    let monitor = monitors.get(monitor_index)
        .ok_or_else(|| format!("Monitor {} not found", monitor_index))?;
    
    let app_clone = app.clone();
    let monitor_x = monitor.x;
    let monitor_y = monitor.y;
    let monitor_width = monitor.width;
    let monitor_height = monitor.height;
    
    tokio::task::spawn_blocking(move || {
        show_dcomp_overlay(&app_clone, monitor_x, monitor_y, monitor_width, monitor_height)
    })
    .await
    .map_err(|e| format!("Task failed: {:?}", e))?
}

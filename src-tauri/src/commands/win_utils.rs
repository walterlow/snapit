//! Windows utility functions shared across capture modules.

/// Get the visible window border thickness.
/// Tries DWMWA_VISIBLE_FRAME_BORDER_THICKNESS (Win11+), falls back to DPI-based calculation.
#[cfg(target_os = "windows")]
pub fn get_visible_border_thickness(hwnd: windows::Win32::Foundation::HWND) -> i32 {
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_VISIBLE_FRAME_BORDER_THICKNESS,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;

    unsafe {
        // Try Win11+ API first
        let mut thickness: u32 = 0;
        let result = DwmGetWindowAttribute(
            hwnd,
            DWMWA_VISIBLE_FRAME_BORDER_THICKNESS,
            &mut thickness as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        );

        if result.is_ok() && thickness > 0 {
            return thickness as i32;
        }

        // DPI-based: 1px at 96 DPI, scales linearly
        let dpi = GetDpiForWindow(hwnd);
        if dpi > 0 {
            ((dpi as f32 / 96.0).round() as i32).max(1)
        } else {
            1
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_visible_border_thickness(_hwnd: isize) -> i32 {
    1
}

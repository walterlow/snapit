//! Windows API cursor capture implementation.
//!
//! Uses DrawIconEx to render cursor directly onto frame buffer,
//! which handles all cursor types correctly (color, monochrome, animated).

use super::{CachedCursor, CursorCaptureManager, CursorState};
use std::mem;
use std::sync::Arc;
use windows::Win32::{
    Foundation::POINT,
    Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    },
    UI::WindowsAndMessaging::{
        DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSORINFO_FLAGS, CURSOR_SHOWING,
        DI_NORMAL, ICONINFO,
    },
};

/// Re-export CursorCapture as an alias for the manager.
pub type CursorCapture = CursorCaptureManager;

impl CursorCaptureManager {
    /// Capture the current cursor state.
    ///
    /// Returns cursor position, visibility, and bitmap data.
    /// Uses caching to avoid expensive bitmap extraction when cursor hasn't changed.
    pub fn capture(&mut self) -> Result<CursorState, String> {
        unsafe { self.capture_internal() }
    }

    unsafe fn capture_internal(&mut self) -> Result<CursorState, String> {
        // Get cursor info (position, visibility, handle)
        let mut cursor_info = CURSORINFO {
            cbSize: mem::size_of::<CURSORINFO>() as u32,
            flags: CURSORINFO_FLAGS(0),
            hCursor: windows::Win32::UI::WindowsAndMessaging::HCURSOR::default(),
            ptScreenPos: POINT::default(),
        };

        if GetCursorInfo(&mut cursor_info).is_err() {
            return Err("GetCursorInfo failed".to_string());
        }

        // Check if cursor is visible
        if cursor_info.flags.0 & CURSOR_SHOWING.0 == 0 {
            return Ok(CursorState {
                visible: false,
                ..Default::default()
            });
        }

        let cursor_handle = cursor_info.hCursor.0 as isize;

        // Check cache for cursor bitmap
        if let Some(cached) = self.cache.get(&cursor_handle) {
            return Ok(CursorState {
                visible: true,
                screen_x: cursor_info.ptScreenPos.x,
                screen_y: cursor_info.ptScreenPos.y,
                hotspot_x: cached.hotspot_x,
                hotspot_y: cached.hotspot_y,
                width: cached.width,
                height: cached.height,
                bgra_data: Arc::clone(&cached.bgra_data), // Zero-cost clone via Arc
            });
        }

        // Extract cursor bitmap using DrawIconEx (handles all cursor types)
        eprintln!(
            "[CURSOR] Cache miss for handle {}, extracting with DrawIconEx...",
            cursor_handle
        );
        let cached = self.extract_cursor_with_drawicon(cursor_info.hCursor)?;

        let state = CursorState {
            visible: true,
            screen_x: cursor_info.ptScreenPos.x,
            screen_y: cursor_info.ptScreenPos.y,
            hotspot_x: cached.hotspot_x,
            hotspot_y: cached.hotspot_y,
            width: cached.width,
            height: cached.height,
            bgra_data: Arc::clone(&cached.bgra_data), // Zero-cost clone via Arc
        };

        // Cache for future frames
        eprintln!(
            "[CURSOR] Caching cursor: handle={}, size={}x{}, hotspot=({},{})",
            cursor_handle, cached.width, cached.height, cached.hotspot_x, cached.hotspot_y
        );
        self.cache.insert(cursor_handle, cached);
        self.last_cursor_handle = cursor_handle;

        Ok(state)
    }

    /// Extract cursor bitmap using DrawIconEx.
    /// This method renders the cursor to a bitmap and extracts BGRA pixels.
    unsafe fn extract_cursor_with_drawicon(
        &self,
        hcursor: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    ) -> Result<CachedCursor, String> {
        // Get icon info for hotspot
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hcursor, &mut icon_info).is_err() {
            return Err("GetIconInfo failed".to_string());
        }

        let hotspot_x = icon_info.xHotspot as i32;
        let hotspot_y = icon_info.yHotspot as i32;

        // Get cursor size from the bitmap (if color bitmap exists, use it; otherwise use mask)
        let (width, height) = if !icon_info.hbmColor.is_invalid() {
            let mut bm = windows::Win32::Graphics::Gdi::BITMAP::default();
            windows::Win32::Graphics::Gdi::GetObjectW(
                icon_info.hbmColor,
                mem::size_of::<windows::Win32::Graphics::Gdi::BITMAP>() as i32,
                Some(&mut bm as *mut _ as *mut _),
            );
            (bm.bmWidth as u32, bm.bmHeight as u32)
        } else if !icon_info.hbmMask.is_invalid() {
            let mut bm = windows::Win32::Graphics::Gdi::BITMAP::default();
            windows::Win32::Graphics::Gdi::GetObjectW(
                icon_info.hbmMask,
                mem::size_of::<windows::Win32::Graphics::Gdi::BITMAP>() as i32,
                Some(&mut bm as *mut _ as *mut _),
            );
            // For monochrome cursor, mask height is 2x (AND mask + XOR mask)
            (bm.bmWidth as u32, (bm.bmHeight / 2) as u32)
        } else {
            // Default cursor size
            (32, 32)
        };

        eprintln!(
            "[CURSOR] Cursor size: {}x{}, hotspot: ({}, {})",
            width, height, hotspot_x, hotspot_y
        );

        // Clean up icon info bitmaps
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor);
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask);
        }

        if width == 0 || height == 0 {
            return Err("Invalid cursor dimensions".to_string());
        }

        // Create a compatible DC and bitmap to draw the cursor onto
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC failed".to_string());
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC failed".to_string());
        }

        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.is_invalid() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleBitmap failed".to_string());
        }

        let old_bitmap = SelectObject(mem_dc, bitmap);

        // Fill with transparent background (BGRA: 0,0,0,0)
        // We use a specific color that we'll treat as transparent
        let brush = windows::Win32::Graphics::Gdi::CreateSolidBrush(
            windows::Win32::Foundation::COLORREF(0x00000000),
        );
        let rect = windows::Win32::Foundation::RECT {
            left: 0,
            top: 0,
            right: width as i32,
            bottom: height as i32,
        };
        windows::Win32::Graphics::Gdi::FillRect(mem_dc, &rect, brush);
        let _ = DeleteObject(brush);

        // Draw the cursor onto the bitmap
        let draw_result = DrawIconEx(
            mem_dc,
            0,
            0,
            hcursor,
            width as i32,
            height as i32,
            0,
            None,
            DI_NORMAL,
        );

        if draw_result.is_err() {
            SelectObject(mem_dc, old_bitmap);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("DrawIconEx failed".to_string());
        }

        // Extract pixels from bitmap
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32), // Top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: width * height * 4,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };

        let mut bgra_data = vec![0u8; (width * height * 4) as usize];

        let lines = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height,
            Some(bgra_data.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old_bitmap);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        if lines == 0 {
            return Err("GetDIBits failed".to_string());
        }

        eprintln!("[CURSOR] GetDIBits returned {} lines", lines);

        // The background we drew is black (0,0,0). Pixels that are still black
        // with alpha 0 are transparent. But DrawIconEx doesn't preserve alpha
        // properly on all systems, so we need to handle this.
        //
        // Strategy: Check if any pixel has non-zero alpha. If not, we need to
        // use the color as a hint - black pixels are likely transparent.
        let has_alpha = bgra_data.chunks(4).any(|p| p[3] != 0);

        if !has_alpha {
            // No alpha info - treat pure black (0,0,0) as transparent
            eprintln!("[CURSOR] No alpha channel, using black as transparent");
            for chunk in bgra_data.chunks_mut(4) {
                if chunk[0] == 0 && chunk[1] == 0 && chunk[2] == 0 {
                    chunk[3] = 0; // Transparent
                } else {
                    chunk[3] = 255; // Opaque
                }
            }
        }

        // Count opaque pixels for debugging
        let opaque_count = bgra_data.chunks(4).filter(|p| p[3] > 0).count();
        eprintln!(
            "[CURSOR] Cursor has {} opaque pixels out of {}",
            opaque_count,
            width * height
        );

        Ok(CachedCursor {
            width,
            height,
            hotspot_x,
            hotspot_y,
            bgra_data: Arc::new(bgra_data),
        })
    }
}

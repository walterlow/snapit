//! Cursor recording actor.
//!
//! Spawns a background task that records cursor position and image changes
//! during video recording. Uses SHA256-based deduplication to minimize
//! storage of cursor images.
//!
//! Mirrors Cap's recording/src/cursor.rs implementation.

use super::{CursorCropBounds, PhysicalBounds, RawCursorPosition};
use crate::cursor::events::{CursorClickEvent, CursorEvents, CursorMoveEvent, XY};
use crate::cursor::info::CursorShape;
use device_query::{DeviceQuery, DeviceState};
use futures::future::Either;
use futures::FutureExt;
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tokio_util::sync::{CancellationToken, DropGuard};
use ts_rs::TS;

/// Interval for periodic cursor data flush to disk.
const CURSOR_FLUSH_INTERVAL_SECS: u64 = 5;

/// Polling interval for cursor position/state (60Hz).
const CURSOR_POLL_INTERVAL_MS: u64 = 16;

/// Information about a recorded cursor image.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/types/generated/")]
pub struct Cursor {
    /// PNG file name in the cursors directory.
    pub file_name: String,
    /// Cursor ID (sequential).
    pub id: u32,
    /// Hotspot position (normalized 0-1).
    pub hotspot: XY<f64>,
    /// Cursor shape if detected from system cursor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<CursorShape>,
}

/// Map of SHA256 hash (truncated to u64) -> Cursor metadata.
pub type Cursors = HashMap<u64, Cursor>;

/// Response from cursor recording actor when stopped.
#[derive(Clone)]
pub struct CursorActorResponse {
    /// All recorded cursor images, keyed by content hash.
    pub cursors: Cursors,
    /// Next ID to assign to new cursors.
    pub next_cursor_id: u32,
    /// All recorded move events.
    pub moves: Vec<CursorMoveEvent>,
    /// All recorded click events.
    pub clicks: Vec<CursorClickEvent>,
}

/// Handle to the cursor recording actor.
pub struct CursorActor {
    stop: Option<DropGuard>,
    /// Receiver for the final response when actor stops.
    pub rx: futures::future::Shared<oneshot::Receiver<CursorActorResponse>>,
}

impl CursorActor {
    /// Stop the cursor recording actor.
    pub fn stop(&mut self) {
        drop(self.stop.take());
    }
}

/// Flush cursor events to disk.
fn flush_cursor_data(output_path: &Path, moves: &[CursorMoveEvent], clicks: &[CursorClickEvent]) {
    let events = CursorEvents {
        clicks: clicks.to_vec(),
        moves: moves.to_vec(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&events) {
        if let Err(e) = std::fs::write(output_path, json) {
            log::error!(
                "Failed to write cursor data to {}: {}",
                output_path.display(),
                e
            );
        }
    }
}

/// Data captured from the system cursor.
#[derive(Debug)]
struct CursorData {
    /// PNG image data.
    image: Vec<u8>,
    /// Hotspot position (normalized 0-1).
    hotspot: XY<f64>,
    /// Detected cursor shape.
    shape: Option<CursorShape>,
}

/// Spawn a cursor recording actor.
///
/// # Arguments
/// * `crop_bounds` - Bounds for normalizing cursor position
/// * `display_bounds` - Physical display bounds for coordinate conversion
/// * `cursors_dir` - Directory to store cursor PNG files
/// * `prev_cursors` - Previously recorded cursors (for resuming)
/// * `next_cursor_id` - Next ID to assign to new cursors
/// * `start_time` - Recording start instant for timestamps
/// * `output_path` - Path to write cursor events JSON (optional)
#[allow(clippy::too_many_arguments)]
pub fn spawn_cursor_recorder(
    crop_bounds: CursorCropBounds,
    display_bounds: PhysicalBounds,
    cursors_dir: PathBuf,
    prev_cursors: Cursors,
    next_cursor_id: u32,
    start_time: Instant,
    output_path: Option<PathBuf>,
) -> CursorActor {
    let stop_token = CancellationToken::new();
    let (tx, rx) = oneshot::channel();

    let stop_token_child = stop_token.child_token();

    tokio::spawn(async move {
        let device_state = DeviceState::new();
        let mut last_mouse_state = device_state.get_mouse();
        let mut last_position = RawCursorPosition::get();

        // Create cursors directory
        if let Err(e) = std::fs::create_dir_all(&cursors_dir) {
            log::error!("Failed to create cursors directory: {}", e);
        }

        let mut response = CursorActorResponse {
            cursors: prev_cursors,
            next_cursor_id,
            moves: vec![],
            clicks: vec![],
        };

        let mut last_flush = Instant::now();
        let flush_interval = Duration::from_secs(CURSOR_FLUSH_INTERVAL_SECS);
        let mut last_cursor_id: Option<String> = None;

        loop {
            let sleep = tokio::time::sleep(Duration::from_millis(CURSOR_POLL_INTERVAL_MS));
            let Either::Right(_) =
                futures::future::select(pin!(stop_token_child.cancelled()), pin!(sleep)).await
            else {
                break;
            };

            let elapsed = start_time.elapsed().as_secs_f64() * 1000.0;
            let mouse_state = device_state.get_mouse();

            let position = RawCursorPosition::get();
            let position_changed = position != last_position;

            if position_changed {
                last_position = position;
            }

            // Get cursor image and hash it for deduplication
            let cursor_id = if let Some(data) = get_cursor_data() {
                let hash_bytes = Sha256::digest(&data.image);
                let id = u64::from_le_bytes(
                    hash_bytes[..8]
                        .try_into()
                        .expect("sha256 produces at least 8 bytes"),
                );

                let cursor_id = if let Some(existing) = response.cursors.get(&id) {
                    existing.id.to_string()
                } else {
                    let cursor_id = response.next_cursor_id.to_string();
                    let file_name = format!("cursor_{cursor_id}.png");
                    let cursor_path = cursors_dir.join(&file_name);

                    if let Ok(image) = image::load_from_memory(&data.image) {
                        let rgba_image = image.into_rgba8();

                        if let Err(e) = rgba_image.save(&cursor_path) {
                            log::error!("Failed to save cursor image: {}", e);
                        } else {
                            log::info!("Saved cursor {cursor_id} image to: {:?}", file_name);
                            response.cursors.insert(
                                id,
                                Cursor {
                                    file_name,
                                    id: response.next_cursor_id,
                                    hotspot: data.hotspot,
                                    shape: data.shape,
                                },
                            );
                            response.next_cursor_id += 1;
                        }
                    }

                    cursor_id
                };
                last_cursor_id = Some(cursor_id.clone());
                Some(cursor_id)
            } else {
                last_cursor_id.clone()
            };

            let Some(cursor_id) = cursor_id else {
                continue;
            };

            // Record position changes
            if position_changed {
                let cropped_norm_pos = position
                    .relative_to_display(display_bounds)
                    .and_then(|p| p.normalize())
                    .map(|p| p.with_crop(crop_bounds));

                if let Some(pos) = cropped_norm_pos {
                    let mouse_event = CursorMoveEvent {
                        active_modifiers: vec![],
                        cursor_id: cursor_id.clone(),
                        time_ms: elapsed,
                        x: pos.x(),
                        y: pos.y(),
                    };
                    response.moves.push(mouse_event);
                }
            }

            // Record click events
            for (num, &pressed) in mouse_state.button_pressed.iter().enumerate() {
                let Some(prev) = last_mouse_state.button_pressed.get(num) else {
                    continue;
                };

                if pressed == *prev {
                    continue;
                }

                let mouse_event = CursorClickEvent {
                    down: pressed,
                    active_modifiers: vec![],
                    cursor_num: num as u8,
                    cursor_id: cursor_id.clone(),
                    time_ms: elapsed,
                };
                response.clicks.push(mouse_event);
            }

            last_mouse_state = mouse_state;

            // Periodic flush
            if let Some(ref path) = output_path {
                if last_flush.elapsed() >= flush_interval {
                    flush_cursor_data(path, &response.moves, &response.clicks);
                    last_flush = Instant::now();
                }
            }
        }

        log::info!("Cursor recorder done");

        // Final flush
        if let Some(ref path) = output_path {
            flush_cursor_data(path, &response.moves, &response.clicks);
        }

        let _ = tx.send(response);
    });

    CursorActor {
        stop: Some(stop_token.drop_guard()),
        rx: rx.shared(),
    }
}

// Platform-specific cursor data capture
#[cfg(target_os = "windows")]
fn get_cursor_data() -> Option<CursorData> {
    use std::mem;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectA, ReleaseDC,
        SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSORINFO_FLAGS, DI_NORMAL, HICON,
        ICONINFO,
    };

    unsafe {
        // Get cursor info
        let mut cursor_info = CURSORINFO {
            cbSize: mem::size_of::<CURSORINFO>() as u32,
            flags: CURSORINFO_FLAGS(0),
            hCursor: Default::default(),
            ptScreenPos: POINT::default(),
        };

        if GetCursorInfo(&mut cursor_info).is_err() {
            return None;
        }

        if cursor_info.hCursor.is_invalid() {
            return None;
        }

        // Convert HCURSOR to HICON for GetIconInfo
        let hicon = HICON(cursor_info.hCursor.0);

        // Get icon info
        let mut icon_info: ICONINFO = mem::zeroed();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            return None;
        }

        // Get bitmap info for the cursor
        let mut bitmap: BITMAP = mem::zeroed();
        let bitmap_handle = if !icon_info.hbmColor.is_invalid() {
            icon_info.hbmColor
        } else {
            icon_info.hbmMask
        };

        if GetObjectA(
            bitmap_handle,
            mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        ) == 0
        {
            // Clean up handles
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        // Create DCs
        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(screen_dc);

        // Get cursor dimensions
        let width = bitmap.bmWidth;
        let height = if icon_info.hbmColor.is_invalid() && bitmap.bmHeight > 0 {
            // For mask cursors, the height is doubled (AND mask + XOR mask)
            bitmap.bmHeight / 2
        } else {
            bitmap.bmHeight
        };

        // Create bitmap info header for 32-bit RGBA
        let bi = BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // Negative for top-down DIB
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        let bitmap_info = BITMAPINFO {
            bmiHeader: bi,
            bmiColors: [Default::default()],
        };

        // Create DIB section
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem_dc, &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0);

        if dib.is_err() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        let dib = dib.unwrap();

        // Select DIB into DC
        let old_bitmap = SelectObject(mem_dc, dib);

        // Draw the cursor onto our bitmap with transparency
        if DrawIconEx(mem_dc, 0, 0, hicon, 0, 0, 0, None, DI_NORMAL).is_err() {
            SelectObject(mem_dc, old_bitmap);
            let _ = DeleteObject(dib);
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor);
            }
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask);
            }
            return None;
        }

        // Get image data
        let size = (width * height * 4) as usize;
        let mut image_data = vec![0u8; size];
        std::ptr::copy_nonoverlapping(bits, image_data.as_mut_ptr() as *mut _, size);

        // Calculate hotspot
        let mut hotspot_x = if !icon_info.fIcon.as_bool() {
            icon_info.xHotspot as f64 / width as f64
        } else {
            0.5
        };

        let mut hotspot_y = if !icon_info.fIcon.as_bool() {
            icon_info.yHotspot as f64 / height as f64
        } else {
            0.5
        };

        // Cleanup GDI objects
        SelectObject(mem_dc, old_bitmap);
        let _ = DeleteObject(dib);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor);
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask);
        }

        // Process the image data: BGRA -> RGBA
        for i in (0..size).step_by(4) {
            image_data.swap(i, i + 2);
        }

        // Convert to RGBA image
        let mut rgba_image = RgbaImage::from_raw(width as u32, height as u32, image_data)?;

        // Enhance I-beam cursor visibility
        let is_text_cursor = width <= 20 && height >= 20 && width <= height / 2;
        if is_text_cursor {
            add_ibeam_shadow(&mut rgba_image);
        }

        // Trim whitespace and adjust hotspot
        let (trimmed_image, new_hotspot_x, new_hotspot_y) =
            trim_cursor_image(rgba_image, hotspot_x, hotspot_y);

        hotspot_x = new_hotspot_x;
        hotspot_y = new_hotspot_y;

        // Convert to PNG
        let mut png_data = Vec::new();
        trimmed_image
            .write_to(
                &mut std::io::Cursor::new(&mut png_data),
                image::ImageFormat::Png,
            )
            .ok()?;

        Some(CursorData {
            image: png_data,
            hotspot: XY::new(hotspot_x, hotspot_y),
            shape: CursorShape::try_from(&cursor_info.hCursor).ok(),
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn get_cursor_data() -> Option<CursorData> {
    None
}

/// Add shadow/outline to I-beam cursor for visibility on white backgrounds.
#[cfg(target_os = "windows")]
fn add_ibeam_shadow(image: &mut RgbaImage) {
    let width = image.width() as i32;
    let height = image.height() as i32;

    // Collect pixels that need shadows first (to avoid borrow issues)
    let mut shadow_pixels: Vec<(u32, u32)> = Vec::new();

    for y in 0..height {
        for x in 0..width {
            let pixel = image.get_pixel(x as u32, y as u32);
            if pixel[3] > 200 {
                // If this is a solid pixel
                for dx in [-1, 0, 1].iter() {
                    for dy in [-1, 0, 1].iter() {
                        let nx = x + dx;
                        let ny = y + dy;

                        if nx < 0 || ny < 0 || nx >= width || ny >= height || (*dx == 0 && *dy == 0)
                        {
                            continue;
                        }

                        let shadow_pixel = image.get_pixel(nx as u32, ny as u32);
                        if shadow_pixel[3] < 100 {
                            shadow_pixels.push((nx as u32, ny as u32));
                        }
                    }
                }
            }
        }
    }

    // Apply shadow pixels
    for (x, y) in shadow_pixels {
        image.put_pixel(x, y, image::Rgba([0, 0, 0, 100]));
    }
}

/// Trim whitespace from cursor image and adjust hotspot.
#[cfg(target_os = "windows")]
fn trim_cursor_image(image: RgbaImage, hotspot_x: f64, hotspot_y: f64) -> (RgbaImage, f64, f64) {
    let width = image.width();
    let height = image.height();

    // Find bounds of non-transparent pixels
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut has_content = false;

    for y in 0..height {
        for x in 0..width {
            let pixel = image.get_pixel(x, y);
            if pixel[3] > 0 {
                has_content = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }

    // Only trim if there's whitespace to remove
    if has_content && (min_x > 0 || min_y > 0 || max_x < width - 1 || max_y < height - 1) {
        let padding = 2u32;
        let trim_min_x = min_x.saturating_sub(padding);
        let trim_min_y = min_y.saturating_sub(padding);
        let trim_max_x = (max_x + padding).min(width - 1);
        let trim_max_y = (max_y + padding).min(height - 1);

        let trim_width = trim_max_x - trim_min_x + 1;
        let trim_height = trim_max_y - trim_min_y + 1;

        let mut trimmed = RgbaImage::new(trim_width, trim_height);
        for y in 0..trim_height {
            for x in 0..trim_width {
                let src_x = trim_min_x + x;
                let src_y = trim_min_y + y;
                let pixel = image.get_pixel(src_x, src_y);
                trimmed.put_pixel(x, y, *pixel);
            }
        }

        // Adjust hotspot for trimmed image
        let new_hotspot_x = (hotspot_x * width as f64 - trim_min_x as f64) / trim_width as f64;
        let new_hotspot_y = (hotspot_y * height as f64 - trim_min_y as f64) / trim_height as f64;

        (trimmed, new_hotspot_x, new_hotspot_y)
    } else {
        (image, hotspot_x, hotspot_y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cursor_struct() {
        let cursor = Cursor {
            file_name: "cursor_0.png".to_string(),
            id: 0,
            hotspot: XY::new(0.5, 0.5),
            shape: None,
        };
        assert_eq!(cursor.id, 0);
        assert_eq!(cursor.hotspot.x, 0.5);
    }

    #[test]
    fn export_bindings_cursor() {
        Cursor::export_all().unwrap();
    }
}

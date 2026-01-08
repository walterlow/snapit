//! Cursor event capture for video editor auto-zoom feature.
//!
//! Records mouse positions at 100Hz and click events with timestamps.
//! This data is used for:
//! - Auto-zoom generation (zoom to click locations)
//! - Cursor smooth movement interpolation
//! - Click highlight animations
//! - Cursor rendering in video editor (cursor images stored separately)

// Allow unused helpers and Windows API return values
#![allow(dead_code)]
#![allow(unused_must_use)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use ts_rs::TS;

// ============================================================================
// Windows Cursor Shape Detection
// ============================================================================

/// Standard Windows cursor shapes.
/// These map to Windows IDC_* cursor constants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WindowsCursorShape {
    Arrow,
    IBeam,
    Wait,
    Cross,
    UpArrow,
    SizeNWSE,
    SizeNESW,
    SizeWE,
    SizeNS,
    SizeAll,
    No,
    Hand,
    AppStarting,
    Help,
    Pin,
    Person,
    Pen,
}

impl WindowsCursorShape {
    /// Convert to string for SVG lookup
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Arrow => "arrow",
            Self::IBeam => "ibeam",
            Self::Wait => "wait",
            Self::Cross => "cross",
            Self::UpArrow => "uparrow",
            Self::SizeNWSE => "sizeNWSE",
            Self::SizeNESW => "sizeNESW",
            Self::SizeWE => "sizeWE",
            Self::SizeNS => "sizeNS",
            Self::SizeAll => "sizeAll",
            Self::No => "no",
            Self::Hand => "hand",
            Self::AppStarting => "appStarting",
            Self::Help => "help",
            Self::Pin => "pin",
            Self::Person => "person",
            Self::Pen => "pen",
        }
    }
}

/// Cache of system cursor handles for shape detection.
/// Loaded once on first use.
#[cfg(target_os = "windows")]
static CURSOR_HANDLE_CACHE: OnceLock<HashMap<isize, WindowsCursorShape>> = OnceLock::new();

/// Initialize the cursor handle cache by loading all standard Windows cursors.
#[cfg(target_os = "windows")]
fn get_cursor_handle_cache() -> &'static HashMap<isize, WindowsCursorShape> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadCursorW, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO,
        IDC_PERSON, IDC_PIN, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE,
        IDC_UPARROW, IDC_WAIT,
    };

    CURSOR_HANDLE_CACHE.get_or_init(|| {
        let mut map = HashMap::new();

        // Helper to load cursor and insert into map
        let mut insert = |resource: PCWSTR, shape: WindowsCursorShape| {
            if let Ok(cursor) = unsafe { LoadCursorW(None, resource) } {
                map.insert(cursor.0 as isize, shape);
            }
        };

        insert(IDC_ARROW, WindowsCursorShape::Arrow);
        insert(IDC_IBEAM, WindowsCursorShape::IBeam);
        insert(IDC_WAIT, WindowsCursorShape::Wait);
        insert(IDC_CROSS, WindowsCursorShape::Cross);
        insert(IDC_UPARROW, WindowsCursorShape::UpArrow);
        insert(IDC_SIZENWSE, WindowsCursorShape::SizeNWSE);
        insert(IDC_SIZENESW, WindowsCursorShape::SizeNESW);
        insert(IDC_SIZEWE, WindowsCursorShape::SizeWE);
        insert(IDC_SIZENS, WindowsCursorShape::SizeNS);
        insert(IDC_SIZEALL, WindowsCursorShape::SizeAll);
        insert(IDC_NO, WindowsCursorShape::No);
        insert(IDC_HAND, WindowsCursorShape::Hand);
        insert(IDC_APPSTARTING, WindowsCursorShape::AppStarting);
        insert(IDC_HELP, WindowsCursorShape::Help);
        insert(IDC_PIN, WindowsCursorShape::Pin);
        insert(IDC_PERSON, WindowsCursorShape::Person);
        // Pen cursor uses MAKEINTRESOURCE(32631)
        insert(PCWSTR(32631u16 as *const u16), WindowsCursorShape::Pen);

        log::debug!("[CURSOR_EVENTS] Loaded {} system cursor handles", map.len());
        map
    })
}

/// Detect cursor shape from handle by comparing to known system cursors.
#[cfg(target_os = "windows")]
fn detect_cursor_shape(cursor_handle: isize) -> Option<WindowsCursorShape> {
    get_cursor_handle_cache().get(&cursor_handle).copied()
}

#[cfg(not(target_os = "windows"))]
fn detect_cursor_shape(_cursor_handle: isize) -> Option<WindowsCursorShape> {
    None
}

// ============================================================================
// Types (exported to TypeScript via ts-rs)
// ============================================================================

/// Type of cursor event.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum CursorEventType {
    /// Mouse moved (recorded at 100Hz intervals).
    Move,
    /// Left mouse button event.
    LeftClick {
        /// True = button pressed, False = button released.
        pressed: bool,
    },
    /// Right mouse button event.
    RightClick {
        /// True = button pressed, False = button released.
        pressed: bool,
    },
    /// Middle mouse button event.
    MiddleClick {
        /// True = button pressed, False = button released.
        pressed: bool,
    },
    /// Mouse wheel scroll event.
    Scroll {
        /// Horizontal scroll delta.
        delta_x: i32,
        /// Vertical scroll delta.
        delta_y: i32,
    },
}

/// A single cursor event with timestamp and normalized position.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorEvent {
    /// Timestamp in milliseconds from recording start.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    /// Normalized X position (0.0-1.0) relative to capture region.
    /// 0.0 = left edge of capture, 1.0 = right edge.
    /// Values outside 0-1 indicate cursor is outside the capture region.
    pub x: f64,
    /// Normalized Y position (0.0-1.0) relative to capture region.
    /// 0.0 = top edge of capture, 1.0 = bottom edge.
    pub y: f64,
    /// Type of event.
    pub event_type: CursorEventType,
    /// ID of the cursor image active at this event (references cursor_images map).
    /// Only set when cursor shape changes or on first event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_id: Option<String>,
}

/// Cursor image data (stored as base64 PNG for portability).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorImage {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Hotspot X offset (where the "click point" is).
    pub hotspot_x: i32,
    /// Hotspot Y offset.
    pub hotspot_y: i32,
    /// Base64-encoded PNG image data.
    pub data_base64: String,
    /// Detected cursor shape (if this is a standard Windows cursor).
    /// When set, the frontend can use SVG instead of the bitmap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_shape: Option<WindowsCursorShape>,
}

/// Complete cursor recording data for a video.
///
/// Cursor positions are stored as normalized coordinates (0.0-1.0) relative to
/// the capture region. This makes the data resolution-independent and simplifies
/// coordinate transformations during playback.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorRecording {
    /// Recording sample rate in Hz.
    pub sample_rate: u32,
    /// Capture region width in pixels (for reference/aspect ratio).
    pub width: u32,
    /// Capture region height in pixels (for reference/aspect ratio).
    pub height: u32,
    /// Capture region X offset in screen coordinates (for debugging).
    /// This is the left edge of the capture region in virtual screen space.
    #[serde(default)]
    pub region_x: i32,
    /// Capture region Y offset in screen coordinates (for debugging).
    /// This is the top edge of the capture region in virtual screen space.
    #[serde(default)]
    pub region_y: i32,
    /// Offset in milliseconds to sync cursor with video.
    /// This compensates for the delay between when recording starts and when
    /// the first video frame is actually captured. Cursor timestamps should be
    /// adjusted by subtracting this value during playback.
    #[serde(default)]
    #[ts(type = "number")]
    pub video_start_offset_ms: u64,
    /// All cursor events sorted by timestamp.
    /// Positions are normalized (0.0-1.0) relative to the capture region.
    pub events: Vec<CursorEvent>,
    /// Cursor images keyed by cursor_id.
    /// Events reference these via cursor_id field.
    #[serde(default)]
    pub cursor_images: HashMap<String, CursorImage>,
}

impl Default for CursorRecording {
    fn default() -> Self {
        Self {
            sample_rate: 100,
            width: 1920,
            height: 1080,
            region_x: 0,
            region_y: 0,
            video_start_offset_ms: 0,
            events: Vec::new(),
            cursor_images: HashMap::new(),
        }
    }
}

// ============================================================================
// Cursor Event Capture Manager
// ============================================================================

/// Shared cursor data for thread-safe access.
struct SharedCursorData {
    events: Vec<CursorEvent>,
    cursor_images: HashMap<String, CursorImage>,
    last_cursor_id: Option<String>,
}

/// Capture region for coordinate normalization.
#[derive(Clone, Copy, Debug)]
struct CaptureRegion {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl CaptureRegion {
    /// Normalize screen coordinates to 0.0-1.0 relative to this region.
    fn normalize(&self, screen_x: i32, screen_y: i32) -> (f64, f64) {
        let rel_x = screen_x - self.x;
        let rel_y = screen_y - self.y;
        (
            rel_x as f64 / self.width as f64,
            rel_y as f64 / self.height as f64,
        )
    }
}

/// Manages cursor event capture in a background thread.
///
/// Captures:
/// - Mouse position at 100Hz
/// - Click events (left, right, middle) immediately when they occur
/// - Scroll events
/// - Cursor images when cursor shape changes
///
/// All positions are normalized to 0.0-1.0 relative to the capture region.
pub struct CursorEventCapture {
    /// Collected events and cursor images (thread-safe).
    data: Arc<Mutex<SharedCursorData>>,
    /// Signal to stop capture thread.
    should_stop: Arc<AtomicBool>,
    /// Recording start time for timestamp calculation.
    start_time: Option<Instant>,
    /// Position capture thread handle.
    position_thread: Option<JoinHandle<()>>,
    /// Mouse hook thread handle.
    hook_thread: Option<JoinHandle<()>>,
    /// Capture region for coordinate normalization.
    capture_region: CaptureRegion,
    /// Video start offset in ms (time of first video frame relative to start_time).
    /// Used to sync cursor timestamps with video during playback.
    video_start_offset_ms: u64,
}

impl CursorEventCapture {
    /// Create a new cursor event capture manager.
    pub fn new() -> Self {
        Self {
            data: Arc::new(Mutex::new(SharedCursorData {
                events: Vec::with_capacity(18000), // Pre-allocate for ~3 min at 100Hz
                cursor_images: HashMap::new(),
                last_cursor_id: None,
            })),
            should_stop: Arc::new(AtomicBool::new(false)),
            start_time: None,
            position_thread: None,
            hook_thread: None,
            capture_region: CaptureRegion {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            video_start_offset_ms: 0,
        }
    }

    /// Set the video start offset.
    /// Call this with the timestamp of the first video frame to sync cursor with video.
    pub fn set_video_start_offset(&mut self, offset_ms: u64) {
        self.video_start_offset_ms = offset_ms;
        log::debug!("[CURSOR_EVENTS] Video start offset set to {}ms", offset_ms);
    }

    /// Start capturing cursor events.
    ///
    /// # Arguments
    /// * `region` - Optional capture region (x, y, width, height). If None, captures full screen.
    pub fn start(&mut self, region: Option<(i32, i32, u32, u32)>) -> Result<(), String> {
        self.start_with_time(region, Instant::now())
    }

    /// Start capturing cursor events with a specific start time.
    ///
    /// This allows synchronizing cursor timestamps with video timestamps by using
    /// the same start time reference for both.
    ///
    /// # Arguments
    /// * `region` - Optional capture region (x, y, width, height). If None, captures full screen.
    /// * `start_time` - The reference time to use for timestamp calculation.
    pub fn start_with_time(
        &mut self,
        region: Option<(i32, i32, u32, u32)>,
        start_time: Instant,
    ) -> Result<(), String> {
        if self.position_thread.is_some() || self.hook_thread.is_some() {
            return Err("Cursor event capture already running".to_string());
        }

        // Reset state
        self.should_stop.store(false, Ordering::SeqCst);
        self.start_time = Some(start_time);

        // Set capture region (use fullscreen if not specified)
        self.capture_region = if let Some((x, y, w, h)) = region {
            log::info!(
                "[CURSOR_EVENTS] Using provided region: origin=({}, {}) size={}x{} - cursor positions will be normalized relative to this",
                x,
                y,
                w,
                h
            );
            // Verify the region makes sense (x,y should be screen coordinates, not 0,0 for non-primary regions)
            if x == 0 && y == 0 {
                log::warn!("[CURSOR_EVENTS] Region starts at (0,0) - if recording on secondary monitor, this may cause cursor offset issues!");
            }
            CaptureRegion {
                x,
                y,
                width: w,
                height: h,
            }
        } else {
            let (w, h) = get_screen_dimensions();
            log::info!(
                "[CURSOR_EVENTS] No region provided, using fullscreen: {}x{}",
                w,
                h
            );
            CaptureRegion {
                x: 0,
                y: 0,
                width: w,
                height: h,
            }
        };

        // Clear previous data
        if let Ok(mut data) = self.data.lock() {
            data.events.clear();
            data.cursor_images.clear();
            data.last_cursor_id = None;
        }

        // Start position capture thread (100Hz polling) - also captures cursor images
        let data_clone = Arc::clone(&self.data);
        let should_stop_clone = Arc::clone(&self.should_stop);
        let capture_region = self.capture_region;
        let start_time = self.start_time.unwrap();

        self.position_thread = Some(
            thread::Builder::new()
                .name("cursor-position-capture".to_string())
                .spawn(move || {
                    run_position_capture_loop(
                        data_clone,
                        should_stop_clone,
                        start_time,
                        capture_region,
                    );
                })
                .map_err(|e| format!("Failed to spawn position capture thread: {}", e))?,
        );

        // Start mouse hook thread (for click events)
        let data_clone = Arc::clone(&self.data);
        let should_stop_clone = Arc::clone(&self.should_stop);
        let capture_region = self.capture_region;
        let start_time = self.start_time.unwrap();

        self.hook_thread = Some(
            thread::Builder::new()
                .name("cursor-hook-capture".to_string())
                .spawn(move || {
                    run_mouse_hook_loop(data_clone, should_stop_clone, start_time, capture_region);
                })
                .map_err(|e| format!("Failed to spawn mouse hook thread: {}", e))?,
        );

        log::info!(
            "[CURSOR_EVENTS] Started capture (region: {}x{} at ({}, {}))",
            self.capture_region.width,
            self.capture_region.height,
            self.capture_region.x,
            self.capture_region.y
        );

        Ok(())
    }

    /// Stop capturing and return the collected data.
    pub fn stop(&mut self) -> CursorRecording {
        self.should_stop.store(true, Ordering::SeqCst);

        // Wait for threads to finish
        if let Some(handle) = self.position_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.hook_thread.take() {
            let _ = handle.join();
        }

        // Collect data
        let (events, cursor_images) = self
            .data
            .lock()
            .map(|d| (d.events.clone(), d.cursor_images.clone()))
            .unwrap_or_default();

        log::info!(
            "[CURSOR_EVENTS] Stopped capture, collected {} events, {} cursor images, region=({}, {}) {}x{}",
            events.len(),
            cursor_images.len(),
            self.capture_region.x,
            self.capture_region.y,
            self.capture_region.width,
            self.capture_region.height
        );

        CursorRecording {
            sample_rate: 100,
            width: self.capture_region.width,
            height: self.capture_region.height,
            region_x: self.capture_region.x,
            region_y: self.capture_region.y,
            video_start_offset_ms: self.video_start_offset_ms,
            events,
            cursor_images,
        }
    }

    /// Check if capture is currently running.
    pub fn is_running(&self) -> bool {
        self.position_thread.is_some() && !self.should_stop.load(Ordering::SeqCst)
    }
}

impl Default for CursorEventCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CursorEventCapture {
    fn drop(&mut self) {
        self.should_stop.store(true, Ordering::SeqCst);
    }
}

// ============================================================================
// Platform-specific implementations
// ============================================================================

/// Get primary screen dimensions (fallback).
fn get_screen_dimensions() -> (u32, u32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
        unsafe {
            let width = GetSystemMetrics(SM_CXSCREEN) as u32;
            let height = GetSystemMetrics(SM_CYSCREEN) as u32;
            (width.max(1), height.max(1))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        (1920, 1080) // Default fallback
    }
}

/// Get current cursor position and handle.
/// Returns (x, y, cursor_handle, is_visible).
fn get_cursor_info() -> (i32, i32, isize, bool) {
    #[cfg(target_os = "windows")]
    {
        use std::mem;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetCursorInfo, CURSORINFO, CURSORINFO_FLAGS, CURSOR_SHOWING,
        };
        unsafe {
            let mut cursor_info = CURSORINFO {
                cbSize: mem::size_of::<CURSORINFO>() as u32,
                flags: CURSORINFO_FLAGS(0),
                hCursor: windows::Win32::UI::WindowsAndMessaging::HCURSOR::default(),
                ptScreenPos: windows::Win32::Foundation::POINT::default(),
            };

            if GetCursorInfo(&mut cursor_info).is_ok() {
                let visible = cursor_info.flags.0 & CURSOR_SHOWING.0 != 0;
                let handle = cursor_info.hCursor.0 as isize;
                (
                    cursor_info.ptScreenPos.x,
                    cursor_info.ptScreenPos.y,
                    handle,
                    visible,
                )
            } else {
                (0, 0, 0, false)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        (0, 0, 0, false)
    }
}

/// Capture cursor image as base64-encoded PNG.
#[cfg(target_os = "windows")]
fn capture_cursor_image(cursor_handle: isize) -> Option<CursorImage> {
    use std::mem;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DrawIconEx, GetIconInfo, DI_NORMAL, HCURSOR, ICONINFO,
    };

    unsafe {
        let hcursor = HCURSOR(cursor_handle as *mut std::ffi::c_void);

        // Get icon info for hotspot
        let mut icon_info: ICONINFO = mem::zeroed();
        if GetIconInfo(hcursor, &mut icon_info).is_err() {
            return None;
        }

        // Clean up masks
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask);
        }
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor);
        }

        // Standard cursor size (we render at a fixed size for consistency)
        let width: u32 = 32;
        let height: u32 = 32;

        // Create DC and bitmap for rendering
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return None;
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return None;
        }

        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.is_invalid() {
            DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return None;
        }

        let old_bitmap = SelectObject(mem_dc, bitmap);

        // Note: Windows bitmaps don't support alpha well, so we use a workaround
        let bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32), // Top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };

        // Draw cursor onto bitmap
        let _ = DrawIconEx(
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

        // Extract BGRA pixels
        let mut bgra_data = vec![0u8; (width * height * 4) as usize];
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            height,
            Some(bgra_data.as_mut_ptr() as *mut std::ffi::c_void),
            &bi as *const _ as *mut _,
            DIB_RGB_COLORS,
        );

        // Cleanup
        SelectObject(mem_dc, old_bitmap);
        DeleteObject(bitmap);
        DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        // Convert BGRA to RGBA for PNG encoding
        let mut rgba_data = vec![0u8; (width * height * 4) as usize];
        for i in 0..(width * height) as usize {
            let idx = i * 4;
            rgba_data[idx] = bgra_data[idx + 2]; // R
            rgba_data[idx + 1] = bgra_data[idx + 1]; // G
            rgba_data[idx + 2] = bgra_data[idx]; // B
            rgba_data[idx + 3] = bgra_data[idx + 3]; // A
        }

        // Create image buffer and encode as PNG
        use image::{ImageBuffer, Rgba};
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgba_data)?;

        let mut png_data = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut png_data);
        if img.write_to(&mut cursor, image::ImageFormat::Png).is_err() {
            return None;
        }

        // Base64 encode
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let data_base64 = STANDARD.encode(&png_data);

        // Detect cursor shape (for SVG fallback)
        let cursor_shape = detect_cursor_shape(cursor_handle);

        Some(CursorImage {
            width,
            height,
            hotspot_x: icon_info.xHotspot as i32,
            hotspot_y: icon_info.yHotspot as i32,
            data_base64,
            cursor_shape,
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_cursor_image(_cursor_handle: isize) -> Option<CursorImage> {
    None
}

/// Position capture loop - runs at 100Hz to record cursor positions and images.
/// Positions are normalized to 0.0-1.0 relative to the capture region.
fn run_position_capture_loop(
    data: Arc<Mutex<SharedCursorData>>,
    should_stop: Arc<AtomicBool>,
    start_time: Instant,
    region: CaptureRegion,
) {
    let interval = Duration::from_millis(10); // 100Hz

    // Capture initial cursor immediately so first event has a valid cursor_id
    let (init_x, init_y, init_cursor_handle, init_cursor_visible) = get_cursor_info();
    let mut last_x = init_x;
    let mut last_y = init_y;
    let mut last_cursor_handle: isize = 0;
    let mut initial_cursor_id: Option<String> = None;

    if init_cursor_visible && init_cursor_handle != 0 {
        last_cursor_handle = init_cursor_handle;
        let cursor_id = format!("cursor_{:x}", init_cursor_handle);

        if let Ok(mut data_guard) = data.lock() {
            // Only set cursor_id if image already exists OR we successfully capture it
            let image_available = if data_guard.cursor_images.contains_key(&cursor_id) {
                true
            } else if let Some(image) = capture_cursor_image(init_cursor_handle) {
                log::debug!(
                    "[CURSOR_EVENTS] Captured initial cursor image: {} ({}x{})",
                    cursor_id,
                    image.width,
                    image.height
                );
                data_guard.cursor_images.insert(cursor_id.clone(), image);
                true
            } else {
                log::warn!("[CURSOR_EVENTS] Failed to capture initial cursor image");
                false
            };

            if image_available {
                data_guard.last_cursor_id = Some(cursor_id.clone());
                initial_cursor_id = Some(cursor_id);
            }
        }
    }

    // Track the last known cursor_id to include on every event (like Cap does)
    let mut current_cursor_id: Option<String> = initial_cursor_id;

    // Record initial position with cursor_id (normalized)
    let (norm_x, norm_y) = region.normalize(init_x, init_y);

    // DEBUG: Log initial cursor capture details
    log::info!(
        "[CURSOR_EVENTS] INITIAL: screen_pos=({}, {}), region=({}, {}, {}x{}), normalized=({:.4}, {:.4})",
        init_x, init_y, region.x, region.y, region.width, region.height, norm_x, norm_y
    );

    if let Ok(mut data_guard) = data.lock() {
        data_guard.events.push(CursorEvent {
            timestamp_ms: 0,
            x: norm_x,
            y: norm_y,
            event_type: CursorEventType::Move,
            cursor_id: current_cursor_id.clone(),
        });
    }

    while !should_stop.load(Ordering::SeqCst) {
        let loop_start = Instant::now();

        // Get cursor position and handle
        let (x, y, cursor_handle, cursor_visible) = get_cursor_info();

        // Check if cursor shape changed - update current_cursor_id if new cursor captured
        if cursor_visible && cursor_handle != last_cursor_handle && cursor_handle != 0 {
            last_cursor_handle = cursor_handle;

            // Generate cursor ID from handle
            let cursor_id = format!("cursor_{:x}", cursor_handle);

            // Capture cursor image if we don't have it yet
            if let Ok(mut data_guard) = data.lock() {
                let image_available = if data_guard.cursor_images.contains_key(&cursor_id) {
                    true
                } else if let Some(image) = capture_cursor_image(cursor_handle) {
                    log::debug!(
                        "[CURSOR_EVENTS] Captured new cursor image: {} ({}x{})",
                        cursor_id,
                        image.width,
                        image.height
                    );
                    data_guard.cursor_images.insert(cursor_id.clone(), image);
                    true
                } else {
                    false
                };

                if image_available {
                    data_guard.last_cursor_id = Some(cursor_id.clone());
                    current_cursor_id = Some(cursor_id);
                }
            }
        }

        // If we still don't have a cursor_id (initial capture failed), keep retrying
        // This ensures we eventually get a cursor image even if the first attempts fail
        if current_cursor_id.is_none() && cursor_visible && cursor_handle != 0 {
            let cursor_id = format!("cursor_{:x}", cursor_handle);
            if let Ok(mut data_guard) = data.lock() {
                if !data_guard.cursor_images.contains_key(&cursor_id) {
                    if let Some(image) = capture_cursor_image(cursor_handle) {
                        log::debug!(
                            "[CURSOR_EVENTS] Retry captured cursor: {} ({}x{})",
                            cursor_id,
                            image.width,
                            image.height
                        );
                        data_guard.cursor_images.insert(cursor_id.clone(), image);
                        data_guard.last_cursor_id = Some(cursor_id.clone());
                        current_cursor_id = Some(cursor_id);
                    }
                } else {
                    // Image already exists from a previous recording, use it
                    data_guard.last_cursor_id = Some(cursor_id.clone());
                    current_cursor_id = Some(cursor_id);
                }
            }
        }

        // Only record if position changed (reduces data size significantly)
        if x != last_x || y != last_y {
            let timestamp_ms = start_time.elapsed().as_millis() as u64;

            // Normalize to 0.0-1.0 relative to capture region
            let (norm_x, norm_y) = region.normalize(x, y);

            // Debug: Log first few cursor events to verify normalization
            if let Ok(data_guard) = data.lock() {
                let event_count = data_guard.events.len();
                if event_count < 10 {
                    log::info!(
                        "[CURSOR_EVENTS] Move {}: screen=({}, {}), region=({}, {}, {}x{}), norm=({:.4}, {:.4})",
                        event_count, x, y, region.x, region.y, region.width, region.height, norm_x, norm_y
                    );
                }
            }

            // Always include current_cursor_id on every move event (like Cap)
            if let Ok(mut data_guard) = data.lock() {
                data_guard.events.push(CursorEvent {
                    timestamp_ms,
                    x: norm_x,
                    y: norm_y,
                    event_type: CursorEventType::Move,
                    cursor_id: current_cursor_id.clone(),
                });
            }

            last_x = x;
            last_y = y;
        }

        // Sleep to maintain 100Hz
        let elapsed = loop_start.elapsed();
        if elapsed < interval {
            thread::sleep(interval - elapsed);
        }
    }

    log::debug!("[CURSOR_EVENTS] Position capture loop ended");
}

/// Mouse hook loop - captures click events via Windows low-level hook.
/// Click positions are normalized to 0.0-1.0 relative to the capture region.
#[cfg(target_os = "windows")]
fn run_mouse_hook_loop(
    data: Arc<Mutex<SharedCursorData>>,
    should_stop: Arc<AtomicBool>,
    start_time: Instant,
    region: CaptureRegion,
) {
    use std::cell::RefCell;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, PM_REMOVE, WH_MOUSE_LL, WM_LBUTTONDOWN,
        WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    // Thread-local storage for hook callback data (includes region for normalization)
    thread_local! {
        static HOOK_DATA: RefCell<Option<(Arc<Mutex<SharedCursorData>>, Instant, CaptureRegion)>> = RefCell::new(None);
    }

    // Set up thread-local data
    HOOK_DATA.with(|hook_data| {
        *hook_data.borrow_mut() = Some((Arc::clone(&data), start_time, region));
    });

    // Low-level mouse hook callback
    unsafe extern "system" fn mouse_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let mouse_struct = &*(lparam.0 as *const MSLLHOOKSTRUCT);

            let event_type = match wparam.0 as u32 {
                x if x == WM_LBUTTONDOWN => Some(CursorEventType::LeftClick { pressed: true }),
                x if x == WM_LBUTTONUP => Some(CursorEventType::LeftClick { pressed: false }),
                x if x == WM_RBUTTONDOWN => Some(CursorEventType::RightClick { pressed: true }),
                x if x == WM_RBUTTONUP => Some(CursorEventType::RightClick { pressed: false }),
                x if x == WM_MBUTTONDOWN => Some(CursorEventType::MiddleClick { pressed: true }),
                x if x == WM_MBUTTONUP => Some(CursorEventType::MiddleClick { pressed: false }),
                x if x == WM_MOUSEWHEEL => {
                    // High-order word of mouseData contains wheel delta
                    let delta = (mouse_struct.mouseData >> 16) as i16 as i32;
                    Some(CursorEventType::Scroll {
                        delta_x: 0,
                        delta_y: delta,
                    })
                },
                _ => None,
            };

            if let Some(event_type) = event_type {
                HOOK_DATA.with(|hook_data| {
                    if let Some((data, start_time, region)) = hook_data.borrow().as_ref() {
                        let timestamp_ms = start_time.elapsed().as_millis() as u64;
                        // Normalize click position
                        let (norm_x, norm_y) =
                            region.normalize(mouse_struct.pt.x, mouse_struct.pt.y);
                        if let Ok(mut data_guard) = data.lock() {
                            data_guard.events.push(CursorEvent {
                                timestamp_ms,
                                x: norm_x,
                                y: norm_y,
                                event_type,
                                cursor_id: None, // Click events don't track cursor_id
                            });
                        }
                    }
                });
            }
        }

        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe {
        // Install the hook
        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0);

        if hook.is_err() {
            log::error!("[CURSOR_EVENTS] Failed to install mouse hook");
            return;
        }

        let hook = hook.unwrap();
        log::debug!("[CURSOR_EVENTS] Mouse hook installed");

        // Message loop (required for low-level hooks to work)
        // Use PeekMessageW (non-blocking) instead of GetMessageW (blocking)
        // to allow checking should_stop flag
        let mut msg = MSG::default();
        while !should_stop.load(Ordering::SeqCst) {
            // Non-blocking message peek
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Sleep briefly to avoid busy-waiting (low-level hooks still fire during sleep)
            thread::sleep(Duration::from_millis(10));
        }

        // Unhook
        let _ = UnhookWindowsHookEx(hook);
        log::debug!("[CURSOR_EVENTS] Mouse hook removed");
    }

    // Clean up thread-local data
    HOOK_DATA.with(|hook_data| {
        *hook_data.borrow_mut() = None;
    });
}

#[cfg(not(target_os = "windows"))]
fn run_mouse_hook_loop(
    _data: Arc<Mutex<SharedCursorData>>,
    should_stop: Arc<AtomicBool>,
    _start_time: Instant,
    _region: CaptureRegion,
) {
    // Non-Windows stub - just wait until stopped
    while !should_stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
    }
}

// ============================================================================
// Utility functions
// ============================================================================

/// Save cursor recording to a JSON file.
pub fn save_cursor_recording(
    recording: &CursorRecording,
    path: &std::path::Path,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(recording)
        .map_err(|e| format!("Failed to serialize cursor recording: {}", e))?;

    std::fs::write(path, json)
        .map_err(|e| format!("Failed to write cursor recording file: {}", e))?;

    log::info!(
        "[CURSOR_EVENTS] Saved {} events to {:?}",
        recording.events.len(),
        path
    );

    Ok(())
}

/// Load cursor recording from a JSON file.
pub fn load_cursor_recording(path: &std::path::Path) -> Result<CursorRecording, String> {
    let json = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read cursor recording file: {}", e))?;

    let recording: CursorRecording = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse cursor recording: {}", e))?;

    log::info!(
        "[CURSOR_EVENTS] Loaded {} events from {:?}",
        recording.events.len(),
        path
    );

    Ok(recording)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cursor_event_serialization() {
        let event = CursorEvent {
            timestamp_ms: 1000,
            x: 0.5, // Normalized coordinates
            y: 0.75,
            event_type: CursorEventType::LeftClick { pressed: true },
            cursor_id: Some("cursor_123".to_string()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("leftClick"));
        assert!(json.contains("pressed"));
        assert!(json.contains("cursor_123"));

        let deserialized: CursorEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.timestamp_ms, 1000);
        assert!((deserialized.x - 0.5).abs() < 0.001);
        assert!((deserialized.y - 0.75).abs() < 0.001);
        assert_eq!(deserialized.cursor_id, Some("cursor_123".to_string()));
    }

    #[test]
    fn test_cursor_recording_default() {
        let recording = CursorRecording::default();
        assert_eq!(recording.sample_rate, 100);
        assert!(recording.events.is_empty());
        assert!(recording.cursor_images.is_empty());
    }

    #[test]
    fn test_capture_region_normalize() {
        let region = CaptureRegion {
            x: 100,
            y: 50,
            width: 800,
            height: 600,
        };

        // Point at origin of region -> (0, 0)
        let (x, y) = region.normalize(100, 50);
        assert!((x - 0.0).abs() < 0.001);
        assert!((y - 0.0).abs() < 0.001);

        // Point at center of region -> (0.5, 0.5)
        let (x, y) = region.normalize(500, 350);
        assert!((x - 0.5).abs() < 0.001);
        assert!((y - 0.5).abs() < 0.001);

        // Point at bottom-right of region -> (1, 1)
        let (x, y) = region.normalize(900, 650);
        assert!((x - 1.0).abs() < 0.001);
        assert!((y - 1.0).abs() < 0.001);

        // Point outside region (left of) -> negative
        let (x, _) = region.normalize(50, 50);
        assert!(x < 0.0);
    }
}

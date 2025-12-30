//! Cursor event capture for video editor auto-zoom feature.
//!
//! Records mouse positions at 60fps and click events with timestamps.
//! This data is used for:
//! - Auto-zoom generation (zoom to click locations)
//! - Cursor smooth movement interpolation
//! - Click highlight animations

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use ts_rs::TS;

// ============================================================================
// Types (exported to TypeScript via ts-rs)
// ============================================================================

/// Type of cursor event.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum CursorEventType {
    /// Mouse moved (recorded at 60fps intervals).
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

/// A single cursor event with timestamp and position.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorEvent {
    /// Timestamp in milliseconds from recording start.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    /// Screen X position in pixels.
    pub x: i32,
    /// Screen Y position in pixels.
    pub y: i32,
    /// Type of event.
    pub event_type: CursorEventType,
}

/// Complete cursor recording data for a video.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorRecording {
    /// Recording sample rate for position data.
    pub fps: u32,
    /// Screen width during recording.
    pub screen_width: u32,
    /// Screen height during recording.
    pub screen_height: u32,
    /// Capture region offset (for region recordings).
    /// Events are stored in screen coordinates; subtract this to get region-relative coords.
    pub region_offset_x: i32,
    pub region_offset_y: i32,
    /// Capture region dimensions (for region recordings).
    pub region_width: u32,
    pub region_height: u32,
    /// All cursor events sorted by timestamp.
    pub events: Vec<CursorEvent>,
}

impl Default for CursorRecording {
    fn default() -> Self {
        Self {
            fps: 60,
            screen_width: 1920,
            screen_height: 1080,
            region_offset_x: 0,
            region_offset_y: 0,
            region_width: 1920,
            region_height: 1080,
            events: Vec::new(),
        }
    }
}

// ============================================================================
// Cursor Event Capture Manager
// ============================================================================

/// Manages cursor event capture in a background thread.
///
/// Captures:
/// - Mouse position at 60fps
/// - Click events (left, right, middle) immediately when they occur
/// - Scroll events
pub struct CursorEventCapture {
    /// Collected events (thread-safe).
    events: Arc<Mutex<Vec<CursorEvent>>>,
    /// Signal to stop capture thread.
    should_stop: Arc<AtomicBool>,
    /// Recording start time for timestamp calculation.
    start_time: Option<Instant>,
    /// Position capture thread handle.
    position_thread: Option<JoinHandle<()>>,
    /// Mouse hook thread handle.
    hook_thread: Option<JoinHandle<()>>,
    /// Screen dimensions.
    screen_width: u32,
    screen_height: u32,
    /// Capture region (if recording a region).
    region: Option<(i32, i32, u32, u32)>,
}

impl CursorEventCapture {
    /// Create a new cursor event capture manager.
    pub fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::with_capacity(10000))), // Pre-allocate for ~3 min at 60fps
            should_stop: Arc::new(AtomicBool::new(false)),
            start_time: None,
            position_thread: None,
            hook_thread: None,
            screen_width: 1920,
            screen_height: 1080,
            region: None,
        }
    }

    /// Start capturing cursor events.
    ///
    /// # Arguments
    /// * `region` - Optional capture region (x, y, width, height). If None, captures full screen.
    pub fn start(&mut self, region: Option<(i32, i32, u32, u32)>) -> Result<(), String> {
        if self.position_thread.is_some() || self.hook_thread.is_some() {
            return Err("Cursor event capture already running".to_string());
        }

        // Reset state
        self.should_stop.store(false, Ordering::SeqCst);
        self.start_time = Some(Instant::now());
        self.region = region;

        // Clear previous events
        if let Ok(mut events) = self.events.lock() {
            events.clear();
        }

        // Get screen dimensions
        let (screen_w, screen_h) = get_screen_dimensions();
        self.screen_width = screen_w;
        self.screen_height = screen_h;

        // Start position capture thread (60fps polling)
        let events_clone = Arc::clone(&self.events);
        let should_stop_clone = Arc::clone(&self.should_stop);
        let start_time = self.start_time.unwrap();

        self.position_thread = Some(
            thread::Builder::new()
                .name("cursor-position-capture".to_string())
                .spawn(move || {
                    run_position_capture_loop(events_clone, should_stop_clone, start_time);
                })
                .map_err(|e| format!("Failed to spawn position capture thread: {}", e))?,
        );

        // Start mouse hook thread (for click events)
        let events_clone = Arc::clone(&self.events);
        let should_stop_clone = Arc::clone(&self.should_stop);
        let start_time = self.start_time.unwrap();

        self.hook_thread = Some(
            thread::Builder::new()
                .name("cursor-hook-capture".to_string())
                .spawn(move || {
                    run_mouse_hook_loop(events_clone, should_stop_clone, start_time);
                })
                .map_err(|e| format!("Failed to spawn mouse hook thread: {}", e))?,
        );

        log::info!(
            "[CURSOR_EVENTS] Started capture (screen: {}x{}, region: {:?})",
            screen_w,
            screen_h,
            region
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

        // Collect events
        let events = self
            .events
            .lock()
            .map(|e| e.clone())
            .unwrap_or_default();

        let (region_x, region_y, region_w, region_h) = self
            .region
            .unwrap_or((0, 0, self.screen_width, self.screen_height));

        log::info!(
            "[CURSOR_EVENTS] Stopped capture, collected {} events",
            events.len()
        );

        CursorRecording {
            fps: 60,
            screen_width: self.screen_width,
            screen_height: self.screen_height,
            region_offset_x: region_x,
            region_offset_y: region_y,
            region_width: region_w,
            region_height: region_h,
            events,
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

/// Get current screen dimensions.
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

/// Get current cursor position.
fn get_cursor_position() -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        unsafe {
            let mut point = POINT::default();
            if GetCursorPos(&mut point).is_ok() {
                (point.x, point.y)
            } else {
                (0, 0)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        (0, 0)
    }
}

/// Position capture loop - runs at 60fps to record cursor positions.
fn run_position_capture_loop(
    events: Arc<Mutex<Vec<CursorEvent>>>,
    should_stop: Arc<AtomicBool>,
    start_time: Instant,
) {
    let interval = Duration::from_micros(16667); // ~60fps
    let mut last_x = i32::MIN;
    let mut last_y = i32::MIN;

    while !should_stop.load(Ordering::SeqCst) {
        let loop_start = Instant::now();

        let (x, y) = get_cursor_position();

        // Only record if position changed (reduces data size significantly)
        if x != last_x || y != last_y {
            let timestamp_ms = start_time.elapsed().as_millis() as u64;

            if let Ok(mut events_guard) = events.lock() {
                events_guard.push(CursorEvent {
                    timestamp_ms,
                    x,
                    y,
                    event_type: CursorEventType::Move,
                });
            }

            last_x = x;
            last_y = y;
        }

        // Sleep to maintain ~60fps
        let elapsed = loop_start.elapsed();
        if elapsed < interval {
            thread::sleep(interval - elapsed);
        }
    }

    log::debug!("[CURSOR_EVENTS] Position capture loop ended");
}

/// Mouse hook loop - captures click events via Windows low-level hook.
#[cfg(target_os = "windows")]
fn run_mouse_hook_loop(
    events: Arc<Mutex<Vec<CursorEvent>>>,
    should_stop: Arc<AtomicBool>,
    start_time: Instant,
) {
    use std::cell::RefCell;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, HHOOK, MSLLHOOKSTRUCT, MSG, PM_REMOVE, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
        WM_RBUTTONUP,
    };

    // Thread-local storage for hook callback data
    thread_local! {
        static HOOK_DATA: RefCell<Option<(Arc<Mutex<Vec<CursorEvent>>>, Instant)>> = RefCell::new(None);
    }

    // Set up thread-local data
    HOOK_DATA.with(|data| {
        *data.borrow_mut() = Some((Arc::clone(&events), start_time));
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
                }
                _ => None,
            };

            if let Some(event_type) = event_type {
                HOOK_DATA.with(|data| {
                    if let Some((events, start_time)) = data.borrow().as_ref() {
                        let timestamp_ms = start_time.elapsed().as_millis() as u64;
                        if let Ok(mut events_guard) = events.lock() {
                            events_guard.push(CursorEvent {
                                timestamp_ms,
                                x: mouse_struct.pt.x,
                                y: mouse_struct.pt.y,
                                event_type,
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
    HOOK_DATA.with(|data| {
        *data.borrow_mut() = None;
    });
}

#[cfg(not(target_os = "windows"))]
fn run_mouse_hook_loop(
    _events: Arc<Mutex<Vec<CursorEvent>>>,
    should_stop: Arc<AtomicBool>,
    _start_time: Instant,
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
            x: 100,
            y: 200,
            event_type: CursorEventType::LeftClick { pressed: true },
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("leftClick"));
        assert!(json.contains("pressed"));

        let deserialized: CursorEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.timestamp_ms, 1000);
        assert_eq!(deserialized.x, 100);
        assert_eq!(deserialized.y, 200);
    }

    #[test]
    fn test_cursor_recording_default() {
        let recording = CursorRecording::default();
        assert_eq!(recording.fps, 60);
        assert!(recording.events.is_empty());
    }
}

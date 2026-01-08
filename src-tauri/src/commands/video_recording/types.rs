//! Type definitions for video recording.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::ffmpeg_gif_encoder::GifQualityPreset;

// ============================================================================
// Monitor Info (Windows API)
// ============================================================================

/// Monitor information from Windows API.
/// Used to get monitor positions for coordinate conversion.
#[derive(Debug, Clone)]
pub struct MonitorBounds {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Get all monitors with their bounds using Windows API.
/// This replaces xcap for monitor enumeration in video recording.
#[cfg(target_os = "windows")]
pub fn get_monitor_bounds() -> Vec<MonitorBounds> {
    use std::mem;
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    };

    let mut monitors: Vec<MonitorBounds> = Vec::new();

    unsafe extern "system" fn enum_callback(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(lparam.0 as *mut Vec<MonitorBounds>);

        let mut info: MONITORINFOEXW = mem::zeroed();
        info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

        if GetMonitorInfoW(hmonitor, &mut info as *mut _ as *mut _).as_bool() {
            let rect = info.monitorInfo.rcMonitor;
            let name = String::from_utf16_lossy(
                &info.szDevice[..info.szDevice.iter().position(|&c| c == 0).unwrap_or(0)],
            );

            monitors.push(MonitorBounds {
                name,
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left) as u32,
                height: (rect.bottom - rect.top) as u32,
            });
        }

        BOOL(1) // Continue enumeration
    }

    unsafe {
        let _ = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(enum_callback),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }

    monitors
}

#[cfg(not(target_os = "windows"))]
pub fn get_monitor_bounds() -> Vec<MonitorBounds> {
    Vec::new()
}

/// Find which monitor contains the given point.
/// Returns (monitor_index, monitor_name, monitor_offset_x, monitor_offset_y).
pub fn find_monitor_for_point(x: i32, y: i32) -> Option<(usize, String, i32, i32)> {
    let monitors = get_monitor_bounds();

    for (idx, m) in monitors.into_iter().enumerate() {
        let mx = m.x;
        let my = m.y;
        let mw = m.width as i32;
        let mh = m.height as i32;

        if x >= mx && x < mx + mw && y >= my && y < my + mh {
            return Some((idx, m.name, mx, my));
        }
    }
    None
}

/// Get display bounds (x, y, width, height) using scap's display enumeration.
/// This ensures monitor_index refers to the same physical display that scap captures.
/// CRITICAL: Always use this for cursor regions in Monitor mode to avoid offset issues.
pub fn get_scap_display_bounds(monitor_index: usize) -> Option<(i32, i32, u32, u32)> {
    use scap::Target;

    // Get displays using scap's enumeration (same order as video capture)
    let targets = scap::get_all_targets();
    let displays: Vec<_> = targets
        .into_iter()
        .filter_map(|t| {
            if let Target::Display(d) = t {
                Some(d)
            } else {
                None
            }
        })
        .collect();

    let display = displays.get(monitor_index)?;

    // Use scap's function to get physical bounds from the display
    scap::get_display_physical_bounds(display)
}

/// Output format for recordings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum RecordingFormat {
    Mp4,
    Gif,
}

impl Default for RecordingFormat {
    fn default() -> Self {
        Self::Mp4
    }
}

/// What to capture.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum RecordingMode {
    /// Capture a specific screen region.
    Region {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
    /// Capture a specific window.
    Window {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
    /// Capture a specific monitor.
    Monitor {
        #[serde(rename = "monitorIndex")]
        monitor_index: usize,
    },
    /// Capture all monitors combined.
    AllMonitors,
}

/// Information about an available audio input device.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioInputDevice {
    /// Device index for selection (matches wasapi enumeration order).
    #[ts(type = "number")]
    pub index: usize,
    /// Human-readable device name (full friendly name from Windows, e.g., "Headset (WH-1000XM3 Hands-Free AG Audio)").
    pub name: String,
    /// Whether this is the system default input device.
    pub is_default: bool,
}

/// Audio capture settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioSettings {
    /// Capture system audio (what's playing on the computer).
    pub capture_system_audio: bool,
    /// Selected microphone device index. None = no microphone.
    #[ts(type = "number | null")]
    pub microphone_device_index: Option<usize>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            capture_system_audio: true,
            microphone_device_index: None,
        }
    }
}

/// Settings for a recording session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct RecordingSettings {
    /// Output format (MP4 or GIF).
    pub format: RecordingFormat,
    /// What to capture.
    pub mode: RecordingMode,
    /// Frames per second (10-60).
    pub fps: u32,
    /// Maximum recording duration in seconds. None = unlimited.
    pub max_duration_secs: Option<u32>,
    /// Whether to include the cursor in the recording.
    pub include_cursor: bool,
    /// Audio capture settings.
    pub audio: AudioSettings,
    /// Quality setting (1-100). Affects video bitrate.
    pub quality: u32,
    /// GIF encoding preset (Fast/Balanced/High).
    pub gif_quality_preset: GifQualityPreset,
    /// Countdown duration before recording starts (0-10 seconds).
    pub countdown_secs: u32,
    /// Quick capture mode - saves directly to file, skips video editor.
    /// When true, cursor is baked into video based on include_cursor setting.
    /// When false, cursor is captured separately for editor flexibility.
    pub quick_capture: bool,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            format: RecordingFormat::Mp4,
            mode: RecordingMode::Monitor { monitor_index: 0 },
            fps: 30,
            max_duration_secs: None,
            // Disable system cursor in video frames - we render our own cursor overlay
            // in the video editor with SVG cursors, smoothing, and effects
            include_cursor: false,
            audio: AudioSettings::default(),
            quality: 80,
            gif_quality_preset: GifQualityPreset::default(),
            countdown_secs: 3,
            quick_capture: false, // Default to editor flow
        }
    }
}

impl RecordingSettings {
    /// Validate and clamp settings to acceptable ranges.
    pub fn validate(&mut self) {
        // Clamp FPS to 10-60
        self.fps = self.fps.clamp(10, 60);

        // Clamp quality to 1-100
        self.quality = self.quality.clamp(1, 100);

        // Clamp countdown to 0-10
        self.countdown_secs = self.countdown_secs.clamp(0, 10);

        // GIF-specific limits
        if self.format == RecordingFormat::Gif {
            // Cap GIF FPS at 30 for reasonable file sizes
            self.fps = self.fps.min(30);

            // GIF doesn't support audio
            self.audio.capture_system_audio = false;
            self.audio.microphone_device_index = None;

            // Limit GIF duration to 60 seconds max
            if let Some(duration) = self.max_duration_secs {
                self.max_duration_secs = Some(duration.min(60));
            } else {
                self.max_duration_secs = Some(30); // Default 30s for GIF
            }
        }
    }

    /// Calculate video bitrate based on quality and resolution.
    pub fn calculate_bitrate(&self, width: u32, height: u32) -> u32 {
        let pixels = width * height;
        let base_bitrate = match pixels {
            0..=921600 => 5_000_000,         // Up to 720p: 5 Mbps base
            921601..=2073600 => 10_000_000,  // Up to 1080p: 10 Mbps base
            2073601..=3686400 => 15_000_000, // Up to 1440p: 15 Mbps base
            _ => 25_000_000,                 // 4K+: 25 Mbps base
        };

        // Scale by quality (50% at quality=1, 150% at quality=100)
        let quality_factor = 0.5 + (self.quality as f64 / 100.0);
        (base_bitrate as f64 * quality_factor) as u32
    }
}

/// Current state of a recording session.
///
/// NOTE: ts-rs generates TypeScript types from Rust - single source of truth.
/// The serde attributes ensure JSON serialization matches the generated TS types.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum RecordingState {
    /// No recording in progress.
    Idle,
    /// Countdown before recording starts.
    Countdown {
        #[serde(rename = "secondsRemaining")]
        seconds_remaining: u32,
    },
    /// Currently recording.
    Recording {
        #[serde(rename = "startedAt")]
        started_at: String,
        #[serde(rename = "elapsedSecs")]
        elapsed_secs: f64,
        #[serde(rename = "frameCount")]
        #[ts(type = "number")]
        frame_count: u64,
    },
    /// Paused (MP4 only).
    Paused {
        #[serde(rename = "elapsedSecs")]
        elapsed_secs: f64,
        #[serde(rename = "frameCount")]
        #[ts(type = "number")]
        frame_count: u64,
    },
    /// Processing/encoding (mainly for GIF).
    Processing { progress: f32 },
    /// Recording completed successfully.
    Completed {
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(rename = "durationSecs")]
        duration_secs: f64,
        #[serde(rename = "fileSizeBytes")]
        #[ts(type = "number")]
        file_size_bytes: u64,
    },
    /// Recording failed.
    Error { message: String },
}

impl Default for RecordingState {
    fn default() -> Self {
        Self::Idle
    }
}

/// Full status of the recording system.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct RecordingStatus {
    pub state: RecordingState,
    pub settings: Option<RecordingSettings>,
}

/// Result of starting a recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct StartRecordingResult {
    pub success: bool,
    pub message: String,
}

/// Result of stopping a recording.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
#[allow(dead_code)]
pub struct StopRecordingResult {
    pub output_path: String,
    pub duration_secs: f64,
    #[ts(type = "number")]
    pub file_size_bytes: u64,
    pub format: RecordingFormat,
}

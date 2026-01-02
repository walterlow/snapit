//! Video project types for the video editor.
//!
//! A VideoProject represents all the data needed to edit and export a video recording:
//! - Source files (screen video, webcam video, cursor data)
//! - Timeline state (trim points, playback speed)
//! - Zoom configuration (auto/manual zoom regions)
//! - Cursor configuration (size, highlighting, smoothing)
//! - Webcam configuration (position, size, visibility segments)
//! - Export settings

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

// ============================================================================
// Video Project
// ============================================================================

/// Complete video project with all editing metadata.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct VideoProject {
    /// Unique project identifier.
    pub id: String,
    /// Creation timestamp (ISO 8601).
    pub created_at: String,
    /// Last modified timestamp (ISO 8601).
    pub updated_at: String,
    /// Project name (usually derived from filename).
    pub name: String,
    /// Source files for this project.
    pub sources: VideoSources,
    /// Timeline editing state.
    pub timeline: TimelineState,
    /// Zoom configuration.
    pub zoom: ZoomConfig,
    /// Cursor configuration.
    pub cursor: CursorConfig,
    /// Webcam configuration.
    pub webcam: WebcamConfig,
    /// Audio track settings (volume, mixing).
    pub audio: AudioTrackSettings,
    /// Export settings.
    pub export: ExportConfig,
    /// Scene/camera mode configuration.
    pub scene: SceneConfig,
    /// Text overlay configuration.
    pub text: TextConfig,
}

/// Source files for a video project.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct VideoSources {
    /// Path to main screen recording.
    pub screen_video: String,
    /// Path to separate webcam recording (optional).
    pub webcam_video: Option<String>,
    /// Path to cursor events JSON file.
    pub cursor_data: Option<String>,
    /// Path to audio file if recorded separately (legacy, use system_audio/microphone_audio instead).
    pub audio_file: Option<String>,
    /// Path to system audio recording (desktop/app audio).
    pub system_audio: Option<String>,
    /// Path to microphone audio recording.
    pub microphone_audio: Option<String>,
    /// Path to background music file (user-added).
    pub background_music: Option<String>,
    /// Original recording dimensions.
    pub original_width: u32,
    pub original_height: u32,
    /// Recording duration in milliseconds.
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// Recording frame rate.
    pub fps: u32,
}

// ============================================================================
// Timeline
// ============================================================================

/// Timeline editing state.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct TimelineState {
    /// Total duration in milliseconds (from source).
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// Trim start point in ms.
    #[ts(type = "number")]
    pub in_point: u64,
    /// Trim end point in ms.
    #[ts(type = "number")]
    pub out_point: u64,
    /// Playback speed multiplier (1.0 = normal).
    pub speed: f32,
}

impl Default for TimelineState {
    fn default() -> Self {
        Self {
            duration_ms: 0,
            in_point: 0,
            out_point: 0,
            speed: 1.0,
        }
    }
}

// ============================================================================
// Audio Track Settings
// ============================================================================

/// Audio track mixing settings for the video.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioTrackSettings {
    /// System audio volume (0.0 - 1.0).
    pub system_volume: f32,
    /// Microphone audio volume (0.0 - 1.0).
    pub microphone_volume: f32,
    /// Background music volume (0.0 - 1.0).
    pub music_volume: f32,
    /// Fade in duration for background music (seconds).
    pub music_fade_in_secs: f32,
    /// Fade out duration for background music (seconds).
    pub music_fade_out_secs: f32,
    /// Normalize output audio to -16 LUFS.
    pub normalize_output: bool,
    /// Mute system audio track.
    pub system_muted: bool,
    /// Mute microphone track.
    pub microphone_muted: bool,
    /// Mute background music.
    pub music_muted: bool,
}

impl Default for AudioTrackSettings {
    fn default() -> Self {
        Self {
            system_volume: 1.0,
            microphone_volume: 0.9,
            music_volume: 0.25,
            music_fade_in_secs: 2.0,
            music_fade_out_secs: 3.0,
            normalize_output: true,
            system_muted: false,
            microphone_muted: false,
            music_muted: false,
        }
    }
}

// ============================================================================
// Zoom Configuration
// ============================================================================

/// Zoom configuration for the video.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ZoomConfig {
    /// Zoom mode.
    pub mode: ZoomMode,
    /// Default zoom scale for auto-generated zooms (e.g., 2.0 = 2x zoom).
    pub auto_zoom_scale: f32,
    /// All zoom regions (both auto and manual).
    pub regions: Vec<ZoomRegion>,
}

impl Default for ZoomConfig {
    fn default() -> Self {
        Self {
            mode: ZoomMode::Auto,
            auto_zoom_scale: 2.0,
            regions: Vec::new(),
        }
    }
}

/// Zoom mode - controls how zooms are applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ZoomMode {
    /// No zoom effects.
    Off,
    /// Automatically zoom to click locations.
    Auto,
    /// Only use manually placed zoom regions.
    Manual,
    /// Use both auto-generated and manual zooms.
    Both,
}

/// Per-region zoom mode - controls whether a region follows the cursor or uses a fixed position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ZoomRegionMode {
    /// Follow cursor position during playback (like Cap's Auto mode).
    /// The zoom center tracks the interpolated cursor position.
    Auto,
    /// Fixed position zoom (targetX/targetY determine the zoom center).
    Manual,
}

impl Default for ZoomRegionMode {
    fn default() -> Self {
        ZoomRegionMode::Manual
    }
}

/// A zoom region defining when and where to zoom.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ZoomRegion {
    /// Unique identifier for this region.
    pub id: String,
    /// Start time in milliseconds.
    #[ts(type = "number")]
    pub start_ms: u64,
    /// End time in milliseconds.
    #[ts(type = "number")]
    pub end_ms: u64,
    /// Zoom scale (1.0 = no zoom, 2.0 = 2x zoom).
    pub scale: f32,
    /// Target X position (normalized 0-1, where 0.5 = center).
    /// Used as fallback when mode is Auto and no cursor data available.
    pub target_x: f32,
    /// Target Y position (normalized 0-1, where 0.5 = center).
    /// Used as fallback when mode is Auto and no cursor data available.
    pub target_y: f32,
    /// Zoom region mode - Auto follows cursor, Manual uses fixed position.
    #[serde(default)]
    pub mode: ZoomRegionMode,
    /// Whether this was auto-generated from a click event.
    pub is_auto: bool,
    /// Transition settings.
    pub transition: ZoomTransition,
}

/// Zoom transition settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ZoomTransition {
    /// Duration of zoom-in transition in milliseconds.
    pub duration_in_ms: u32,
    /// Duration of zoom-out transition in milliseconds.
    pub duration_out_ms: u32,
    /// Easing function for transitions.
    pub easing: EasingFunction,
}

impl Default for ZoomTransition {
    fn default() -> Self {
        Self {
            duration_in_ms: 300,
            duration_out_ms: 300,
            easing: EasingFunction::EaseInOut,
        }
    }
}

/// Easing function for animations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum EasingFunction {
    /// Linear interpolation.
    Linear,
    /// Slow start.
    EaseIn,
    /// Slow end.
    EaseOut,
    /// Slow start and end.
    EaseInOut,
    /// Very smooth (smoothstep).
    Smooth,
    /// Quick start, gradual end.
    Snappy,
    /// Slight overshoot at end.
    Bouncy,
}

// ============================================================================
// Cursor Configuration
// ============================================================================

/// Cursor rendering configuration.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorConfig {
    /// Show cursor in output video.
    pub visible: bool,
    /// Scale factor (1.0 = native size, 2.0 = double size).
    pub scale: f32,
    /// Enable smooth movement interpolation.
    pub smooth_movement: bool,
    /// Smoothing factor (0.0-1.0, higher = smoother but more latency).
    pub smooth_factor: f32,
    /// Click highlight settings.
    pub click_highlight: ClickHighlightConfig,
    /// Hide cursor when idle.
    pub hide_when_idle: bool,
    /// Time before hiding idle cursor (milliseconds).
    pub idle_timeout_ms: u32,
}

impl Default for CursorConfig {
    fn default() -> Self {
        Self {
            visible: true,
            scale: 1.0,
            smooth_movement: true,
            smooth_factor: 0.3,
            click_highlight: ClickHighlightConfig::default(),
            hide_when_idle: false,
            idle_timeout_ms: 3000,
        }
    }
}

/// Click highlight animation settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ClickHighlightConfig {
    /// Enable click highlighting.
    pub enabled: bool,
    /// Highlight color (CSS color string, e.g., "#FF6B6B" or "rgba(255,107,107,0.5)").
    pub color: String,
    /// Highlight radius in pixels.
    pub radius: u32,
    /// Animation duration in milliseconds.
    pub duration_ms: u32,
    /// Highlight style.
    pub style: ClickHighlightStyle,
}

impl Default for ClickHighlightConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            color: "#FF6B6B".to_string(),
            radius: 30,
            duration_ms: 400,
            style: ClickHighlightStyle::Ripple,
        }
    }
}

/// Style of click highlight animation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ClickHighlightStyle {
    /// Expanding circle animation.
    Ripple,
    /// Static glow effect.
    Spotlight,
    /// Hollow ring animation.
    Ring,
}

// ============================================================================
// Webcam Configuration
// ============================================================================

/// Webcam overlay configuration.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebcamConfig {
    /// Show webcam in output video.
    pub enabled: bool,
    /// Position preset.
    pub position: WebcamOverlayPosition,
    /// Custom position (used when position is Custom).
    pub custom_x: f32,
    pub custom_y: f32,
    /// Size as percentage of video width (e.g., 0.2 = 20%).
    pub size: f32,
    /// Shape of webcam overlay.
    pub shape: WebcamOverlayShape,
    /// Corner rounding percentage (0-100). At 100%, a square becomes a circle/squircle.
    #[serde(default = "default_rounding")]
    pub rounding: f32,
    /// Corner style - Squircle (iOS-style) or Rounded (standard border-radius).
    #[serde(default)]
    pub corner_style: CornerStyle,
    /// Shadow strength (0-100). 0 = no shadow.
    #[serde(default = "default_shadow")]
    pub shadow: f32,
    /// Advanced shadow settings (size, opacity, blur).
    #[serde(default)]
    pub shadow_config: ShadowConfig,
    /// Mirror horizontally.
    pub mirror: bool,
    /// Border settings.
    pub border: WebcamBorder,
    /// Visibility segments (for toggling on/off during video).
    pub visibility_segments: Vec<VisibilitySegment>,
}

fn default_rounding() -> f32 {
    100.0
}

fn default_shadow() -> f32 {
    62.5
}

impl Default for WebcamConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            position: WebcamOverlayPosition::BottomRight,
            custom_x: 0.95,
            custom_y: 0.95,
            size: 0.2, // 20% of video width
            shape: WebcamOverlayShape::Circle,
            rounding: default_rounding(),
            corner_style: CornerStyle::default(),
            shadow: default_shadow(),
            shadow_config: ShadowConfig::default(),
            mirror: false,
            border: WebcamBorder::default(),
            visibility_segments: Vec::new(),
        }
    }
}

/// Shadow configuration for webcam overlay.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ShadowConfig {
    /// Shadow size as percentage (0-100).
    pub size: f32,
    /// Shadow opacity (0-100).
    pub opacity: f32,
    /// Shadow blur amount (0-100).
    pub blur: f32,
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            size: 33.9,
            opacity: 44.2,
            blur: 10.5,
        }
    }
}

/// Webcam overlay position preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamOverlayPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// Custom position using custom_x and custom_y.
    Custom,
}

/// Webcam overlay shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum WebcamOverlayShape {
    Circle,
    Rectangle,
    RoundedRectangle,
}

/// Corner style for rounded shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum CornerStyle {
    /// iOS-style superellipse corners.
    #[default]
    Squircle,
    /// Standard circular border-radius corners.
    Rounded,
}

/// Webcam border settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct WebcamBorder {
    /// Show border.
    pub enabled: bool,
    /// Border width in pixels.
    pub width: u32,
    /// Border color (CSS color string).
    pub color: String,
}

impl Default for WebcamBorder {
    fn default() -> Self {
        Self {
            enabled: false,
            width: 3,
            color: "#FFFFFF".to_string(),
        }
    }
}

/// A segment defining visibility state over time.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct VisibilitySegment {
    /// Start time in milliseconds.
    #[ts(type = "number")]
    pub start_ms: u64,
    /// End time in milliseconds.
    #[ts(type = "number")]
    pub end_ms: u64,
    /// Whether visible during this segment.
    pub visible: bool,
}

// ============================================================================
// Export Configuration
// ============================================================================

/// Export settings for the final video.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ExportConfig {
    /// Export preset for quick selection.
    pub preset: ExportPreset,
    /// Output format.
    pub format: ExportFormat,
    /// Output resolution.
    pub resolution: ExportResolution,
    /// Quality (1-100).
    pub quality: u32,
    /// Frames per second.
    pub fps: u32,
    /// Output aspect ratio (for letterboxing).
    pub aspect_ratio: AspectRatio,
    /// Background configuration for letterboxing/padding.
    pub background: BackgroundConfig,
}

impl Default for ExportConfig {
    fn default() -> Self {
        Self {
            preset: ExportPreset::Standard,
            format: ExportFormat::Mp4,
            resolution: ExportResolution::Original,
            quality: 80,
            fps: 30,
            aspect_ratio: AspectRatio::Auto,
            background: BackgroundConfig::default(),
        }
    }
}

/// Export format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ExportFormat {
    Mp4,
    Webm,
    Gif,
}

/// Export resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ExportResolution {
    /// Keep original recording resolution.
    Original,
    /// 1280x720.
    Hd720,
    /// 1920x1080.
    Hd1080,
    /// 2560x1440.
    Qhd1440,
    /// 3840x2160.
    Uhd4k,
}

/// Export preset for quick quality selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ExportPreset {
    /// Draft quality - fast encoding, lower quality (720p, 15fps).
    Draft,
    /// Standard quality - balanced (1080p, 30fps).
    Standard,
    /// High quality - for final output (1080p, 60fps).
    HighQuality,
    /// Maximum quality - uses source resolution and framerate.
    Maximum,
    /// Custom settings.
    Custom,
}

/// Aspect ratio for output video.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum AspectRatio {
    /// Use source aspect ratio (no letterboxing).
    Auto,
    /// 16:9 widescreen landscape.
    Landscape16x9,
    /// 9:16 portrait (social media vertical).
    Portrait9x16,
    /// 1:1 square.
    Square1x1,
    /// 4:3 standard/classic.
    Standard4x3,
}

/// Background type for letterboxing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum BackgroundType {
    /// Solid color background.
    Solid,
    /// Gradient background.
    Gradient,
}

/// Background configuration for letterboxing/padding.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct BackgroundConfig {
    /// Type of background.
    pub bg_type: BackgroundType,
    /// Solid color (hex format, e.g., "#000000").
    pub solid_color: String,
    /// Gradient start color (hex format).
    pub gradient_start: String,
    /// Gradient end color (hex format).
    pub gradient_end: String,
    /// Gradient angle in degrees (0-360).
    pub gradient_angle: f32,
}

impl Default for BackgroundConfig {
    fn default() -> Self {
        Self {
            bg_type: BackgroundType::Solid,
            solid_color: "#000000".to_string(),
            gradient_start: "#1a1a2e".to_string(),
            gradient_end: "#16213e".to_string(),
            gradient_angle: 135.0,
        }
    }
}

/// Audio waveform data for visualization.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AudioWaveform {
    /// Downsampled audio samples (normalized -1.0 to 1.0).
    pub samples: Vec<f32>,
    /// Duration of the audio in milliseconds.
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// Number of samples per second in this waveform data.
    pub samples_per_second: u32,
}

/// Scene mode for different camera/screen configurations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum SceneMode {
    /// Default mode - screen with webcam overlay.
    Default,
    /// Camera-only mode - fullscreen webcam.
    CameraOnly,
    /// Screen-only mode - hide webcam.
    ScreenOnly,
}

/// A scene segment defining the mode for a time range.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct SceneSegment {
    /// Unique identifier for this segment.
    pub id: String,
    /// Start time in milliseconds.
    #[ts(type = "number")]
    pub start_ms: u64,
    /// End time in milliseconds.
    #[ts(type = "number")]
    pub end_ms: u64,
    /// Scene mode for this segment.
    pub mode: SceneMode,
}

/// Scene configuration for the video.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct SceneConfig {
    /// Scene segments defining modes over time.
    pub segments: Vec<SceneSegment>,
    /// Default scene mode when no segment applies.
    pub default_mode: SceneMode,
}

impl Default for SceneConfig {
    fn default() -> Self {
        Self {
            segments: Vec::new(),
            default_mode: SceneMode::Default,
        }
    }
}

/// Text animation style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum TextAnimation {
    /// No animation.
    None,
    /// Fade in at start.
    FadeIn,
    /// Fade out at end.
    FadeOut,
    /// Fade in and out.
    FadeInOut,
}

/// A text overlay segment.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct TextSegment {
    /// Unique identifier.
    pub id: String,
    /// Start time in milliseconds.
    #[ts(type = "number")]
    pub start_ms: u64,
    /// End time in milliseconds.
    #[ts(type = "number")]
    pub end_ms: u64,
    /// Text content.
    pub text: String,
    /// X position (0-1, normalized).
    pub x: f32,
    /// Y position (0-1, normalized).
    pub y: f32,
    /// Font family.
    pub font_family: String,
    /// Font size in pixels.
    pub font_size: u32,
    /// Text color (hex format).
    pub color: String,
    /// Text animation style.
    pub animation: TextAnimation,
}

/// Text overlay configuration.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct TextConfig {
    /// Text overlay segments.
    pub segments: Vec<TextSegment>,
}

impl Default for TextConfig {
    fn default() -> Self {
        Self {
            segments: Vec::new(),
        }
    }
}

// ============================================================================
// Helper functions
// ============================================================================

impl VideoProject {
    /// Create a new video project from a recording.
    pub fn new(
        screen_video_path: &str,
        width: u32,
        height: u32,
        duration_ms: u64,
        fps: u32,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        // Generate a simple unique ID using timestamp + random number
        let id = format!(
            "proj_{}_{:08x}",
            chrono::Utc::now().timestamp_millis(),
            rand::random::<u32>()
        );

        Self {
            id,
            created_at: now.clone(),
            updated_at: now,
            name: PathBuf::from(screen_video_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Untitled".to_string()),
            sources: VideoSources {
                screen_video: screen_video_path.to_string(),
                webcam_video: None,
                cursor_data: None,
                audio_file: None,
                system_audio: None,
                microphone_audio: None,
                background_music: None,
                original_width: width,
                original_height: height,
                duration_ms,
                fps,
            },
            timeline: TimelineState {
                duration_ms,
                in_point: 0,
                out_point: duration_ms,
                speed: 1.0,
            },
            zoom: ZoomConfig::default(),
            cursor: CursorConfig::default(),
            webcam: WebcamConfig::default(),
            audio: AudioTrackSettings::default(),
            export: ExportConfig::default(),
            scene: SceneConfig::default(),
            text: TextConfig::default(),
        }
    }

    /// Add webcam video source.
    pub fn with_webcam(mut self, webcam_video_path: &str) -> Self {
        self.sources.webcam_video = Some(webcam_video_path.to_string());
        self
    }

    /// Add cursor data source.
    pub fn with_cursor_data(mut self, cursor_data_path: &str) -> Self {
        self.sources.cursor_data = Some(cursor_data_path.to_string());
        self
    }

    /// Add system audio source.
    pub fn with_system_audio(mut self, system_audio_path: &str) -> Self {
        self.sources.system_audio = Some(system_audio_path.to_string());
        self
    }

    /// Add microphone audio source.
    pub fn with_microphone_audio(mut self, microphone_audio_path: &str) -> Self {
        self.sources.microphone_audio = Some(microphone_audio_path.to_string());
        self
    }

    /// Add background music source.
    pub fn with_background_music(mut self, music_path: &str) -> Self {
        self.sources.background_music = Some(music_path.to_string());
        self
    }

    /// Save project to JSON file.
    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize project: {}", e))?;

        std::fs::write(path, json).map_err(|e| format!("Failed to write project file: {}", e))?;

        Ok(())
    }

    /// Load project from JSON file.
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let json = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read project file: {}", e))?;

        let project: VideoProject =
            serde_json::from_str(&json).map_err(|e| format!("Failed to parse project: {}", e))?;

        Ok(project)
    }
}

// ============================================================================
// Video Metadata Extraction (FFmpeg)
// ============================================================================

/// Video metadata extracted from ffprobe.
#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub fps: u32,
}

impl VideoMetadata {
    /// Extract metadata from a video file using ffprobe.
    pub fn from_file(video_path: &std::path::Path) -> Result<Self, String> {
        let ffprobe_path = find_ffprobe()
            .ok_or_else(|| "ffprobe not found. Ensure FFmpeg is installed.".to_string())?;

        let output = std::process::Command::new(&ffprobe_path)
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-select_streams",
                "v:0",
            ])
            .arg(video_path)
            .output()
            .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffprobe failed: {}", stderr));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        let json: serde_json::Value = serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

        // Extract video stream info
        let stream = json["streams"]
            .as_array()
            .and_then(|s| s.first())
            .ok_or_else(|| "No video stream found".to_string())?;

        let width = stream["width"]
            .as_u64()
            .ok_or_else(|| "Missing width".to_string())? as u32;
        let height = stream["height"]
            .as_u64()
            .ok_or_else(|| "Missing height".to_string())? as u32;

        // Parse frame rate (can be "30/1" or "29.97")
        let fps = parse_frame_rate(
            stream["r_frame_rate"]
                .as_str()
                .or_else(|| stream["avg_frame_rate"].as_str())
                .unwrap_or("30/1"),
        );

        // Get duration from format (more reliable) or stream
        let duration_secs = json["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| {
                stream["duration"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
            })
            .unwrap_or(0.0);

        let duration_ms = (duration_secs * 1000.0) as u64;

        Ok(VideoMetadata {
            width,
            height,
            duration_ms,
            fps,
        })
    }
}

/// Find ffprobe binary (next to ffmpeg).
fn find_ffprobe() -> Option<PathBuf> {
    let binary_name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };

    // Check bundled location (next to executable)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled = exe_dir.join(binary_name);
            if bundled.exists() {
                return Some(bundled);
            }
            let resources = exe_dir.join("resources").join(binary_name);
            if resources.exists() {
                return Some(resources);
            }
        }
    }

    // Check ffmpeg-sidecar cache
    if let Ok(sidecar_dir) = ffmpeg_sidecar::paths::sidecar_dir() {
        let cached = sidecar_dir.join(binary_name);
        if cached.exists() {
            return Some(cached);
        }
    }

    // Check system PATH
    if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(binary_name)
        .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let first_line = path_str.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                let path = PathBuf::from(first_line);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    None
}

/// Parse frame rate string like "30/1" or "29.97" to integer FPS.
fn parse_frame_rate(rate: &str) -> u32 {
    if let Some((num, den)) = rate.split_once('/') {
        let num: f64 = num.parse().unwrap_or(30.0);
        let den: f64 = den.parse().unwrap_or(1.0);
        if den > 0.0 {
            return (num / den).round() as u32;
        }
    }
    rate.parse::<f64>().unwrap_or(30.0).round() as u32
}

/// Load a VideoProject from a screen recording file.
///
/// This function:
/// 1. Extracts video metadata (dimensions, duration, fps) using ffprobe
/// 2. Detects associated files (webcam: `_webcam.mp4`, cursor: `_cursor.json`)
/// 3. Loads cursor events if available for auto-zoom
/// 4. Creates a VideoProject with default configurations
pub fn load_video_project_from_file(video_path: &std::path::Path) -> Result<VideoProject, String> {
    // Get video metadata
    let metadata = VideoMetadata::from_file(video_path)?;

    // Create base project
    let video_path_str = video_path.to_string_lossy().to_string();
    let mut project = VideoProject::new(
        &video_path_str,
        metadata.width,
        metadata.height,
        metadata.duration_ms,
        metadata.fps,
    );

    // Check for associated files
    let base_path = video_path.with_extension("");
    let base_str = base_path.to_string_lossy();

    // Check for webcam video (e.g., recording_123456_webcam.mp4)
    let webcam_path = PathBuf::from(format!("{}_webcam.mp4", base_str));
    if webcam_path.exists() {
        project.sources.webcam_video = Some(webcam_path.to_string_lossy().to_string());
        // Enable webcam by default if we have a webcam video
        project.webcam.enabled = true;
        // Default to full visibility
        project.webcam.visibility_segments.push(VisibilitySegment {
            start_ms: 0,
            end_ms: metadata.duration_ms,
            visible: true,
        });
    }

    // Check for cursor data (e.g., recording_123456_cursor.json)
    let cursor_path = PathBuf::from(format!("{}_cursor.json", base_str));
    if cursor_path.exists() {
        project.sources.cursor_data = Some(cursor_path.to_string_lossy().to_string());
    }

    // Check for system audio (e.g., recording_123456_system.wav)
    let system_audio_path = PathBuf::from(format!("{}_system.wav", base_str));
    if system_audio_path.exists() {
        project.sources.system_audio = Some(system_audio_path.to_string_lossy().to_string());
    }

    // Check for microphone audio (e.g., recording_123456_mic.wav)
    let mic_audio_path = PathBuf::from(format!("{}_mic.wav", base_str));
    if mic_audio_path.exists() {
        project.sources.microphone_audio = Some(mic_audio_path.to_string_lossy().to_string());
    }

    Ok(project)
}

// ============================================================================
// Video Frame Extraction (FFmpeg)
// ============================================================================

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

/// Extract a single frame from a video at the specified timestamp.
///
/// Returns the frame as a base64-encoded JPEG string suitable for display in img tags.
///
/// # Arguments
/// * `video_path` - Path to the video file
/// * `timestamp_ms` - Timestamp in milliseconds to extract the frame from
/// * `max_width` - Optional maximum width to scale down to (maintains aspect ratio)
///
/// # Returns
/// Base64-encoded JPEG image data (without data URI prefix)
pub fn extract_video_frame(
    video_path: &std::path::Path,
    timestamp_ms: u64,
    max_width: Option<u32>,
) -> Result<String, String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or_else(|| "FFmpeg not found. Ensure FFmpeg is installed.".to_string())?;

    // Convert milliseconds to FFmpeg time format (HH:MM:SS.mmm)
    let total_secs = timestamp_ms as f64 / 1000.0;
    let hours = (total_secs / 3600.0).floor() as u32;
    let minutes = ((total_secs % 3600.0) / 60.0).floor() as u32;
    let seconds = total_secs % 60.0;
    let timestamp = format!("{:02}:{:02}:{:06.3}", hours, minutes, seconds);

    // Build FFmpeg command
    let mut args = vec![
        "-ss".to_string(),
        timestamp, // Seek to timestamp (before input for speed)
        "-i".to_string(),
        video_path.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(), // Extract only 1 frame
        "-f".to_string(),
        "image2pipe".to_string(), // Output to pipe
        "-c:v".to_string(),
        "mjpeg".to_string(), // JPEG codec
        "-q:v".to_string(),
        "5".to_string(), // Quality (2-31, lower is better)
    ];

    // Add scale filter if max_width specified
    if let Some(width) = max_width {
        args.extend([
            "-vf".to_string(),
            format!("scale='min({},iw)':-1", width), // Scale down if wider than max
        ]);
    }

    args.push("-".to_string()); // Output to stdout

    let output = std::process::Command::new(&ffmpeg_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run FFmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg frame extraction failed: {}", stderr));
    }

    if output.stdout.is_empty() {
        return Err("FFmpeg produced no output".to_string());
    }

    // Encode as base64
    let base64_data = BASE64.encode(&output.stdout);
    Ok(base64_data)
}

use lazy_static::lazy_static;
/// Frame cache for efficient scrubbing.
/// Stores extracted frames in memory to avoid repeated FFmpeg calls.
use std::collections::HashMap;
use std::sync::Mutex;

/// Cache entry for a video frame
#[derive(Clone)]
struct FrameCacheEntry {
    data: String, // Base64 JPEG data
    timestamp_ms: u64,
}

lazy_static! {
    /// Global frame cache - maps video_path -> (timestamp -> frame_data)
    static ref FRAME_CACHE: Mutex<HashMap<String, Vec<FrameCacheEntry>>> = Mutex::new(HashMap::new());
}

/// Maximum frames to cache per video
const MAX_FRAMES_PER_VIDEO: usize = 60;

/// Get a frame from cache or extract it
pub fn get_video_frame_cached(
    video_path: &std::path::Path,
    timestamp_ms: u64,
    max_width: Option<u32>,
    tolerance_ms: u64,
) -> Result<String, String> {
    let path_str = video_path.to_string_lossy().to_string();

    // Check cache first
    {
        let cache = FRAME_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(frames) = cache.get(&path_str) {
            // Find frame within tolerance
            for entry in frames {
                let diff = if entry.timestamp_ms > timestamp_ms {
                    entry.timestamp_ms - timestamp_ms
                } else {
                    timestamp_ms - entry.timestamp_ms
                };
                if diff <= tolerance_ms {
                    return Ok(entry.data.clone());
                }
            }
        }
    }

    // Extract new frame
    let frame_data = extract_video_frame(video_path, timestamp_ms, max_width)?;

    // Add to cache
    {
        let mut cache = FRAME_CACHE.lock().map_err(|e| e.to_string())?;
        let frames = cache.entry(path_str).or_insert_with(Vec::new);

        // Remove oldest frame if at capacity
        if frames.len() >= MAX_FRAMES_PER_VIDEO {
            frames.remove(0);
        }

        frames.push(FrameCacheEntry {
            data: frame_data.clone(),
            timestamp_ms,
        });
    }

    Ok(frame_data)
}

/// Clear frame cache for a specific video or all videos
pub fn clear_frame_cache(video_path: Option<&std::path::Path>) {
    if let Ok(mut cache) = FRAME_CACHE.lock() {
        if let Some(path) = video_path {
            cache.remove(&path.to_string_lossy().to_string());
        } else {
            cache.clear();
        }
    }
}

// ============================================================================
// Auto-Zoom Generation
// ============================================================================

use crate::commands::video_recording::cursor::{
    load_cursor_recording, CursorEventType, CursorRecording,
};

/// Configuration for auto-zoom generation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct AutoZoomConfig {
    /// Zoom scale factor (e.g., 2.0 = 2x zoom).
    pub scale: f32,
    /// How long to hold the zoom at the click location (ms).
    pub hold_duration_ms: u32,
    /// Minimum gap between zoom regions (ms). Clicks closer than this are merged.
    pub min_gap_ms: u32,
    /// Transition in duration (ms).
    pub transition_in_ms: u32,
    /// Transition out duration (ms).
    pub transition_out_ms: u32,
    /// Easing function for transitions.
    pub easing: EasingFunction,
    /// Only include left clicks (ignore right/middle clicks).
    pub left_clicks_only: bool,
}

impl Default for AutoZoomConfig {
    fn default() -> Self {
        Self {
            scale: 2.0,
            hold_duration_ms: 1500,
            min_gap_ms: 500,
            transition_in_ms: 300,
            transition_out_ms: 300,
            easing: EasingFunction::EaseInOut,
            left_clicks_only: true,
        }
    }
}

/// Generate auto-zoom regions from cursor recording data.
///
/// This function:
/// 1. Loads the cursor recording from the JSON file
/// 2. Filters for click events (left clicks by default)
/// 3. Creates ZoomRegion entries for each click
/// 4. Merges clicks that are too close together
/// 5. Normalizes coordinates to 0-1 range
///
/// # Arguments
/// * `cursor_data_path` - Path to the cursor recording JSON file
/// * `config` - Auto-zoom configuration settings
/// * `video_width` - Video width in pixels (for coordinate normalization)
/// * `video_height` - Video height in pixels (for coordinate normalization)
///
/// # Returns
/// Vector of ZoomRegion entries sorted by start time
pub fn generate_auto_zoom_regions(
    cursor_data_path: &std::path::Path,
    config: &AutoZoomConfig,
    video_width: u32,
    video_height: u32,
) -> Result<Vec<ZoomRegion>, String> {
    // Load cursor recording
    let recording = load_cursor_recording(cursor_data_path)?;

    // Filter for click events
    let clicks: Vec<_> = recording
        .events
        .iter()
        .filter(|e| match &e.event_type {
            CursorEventType::LeftClick { pressed: true } => true,
            CursorEventType::RightClick { pressed: true } if !config.left_clicks_only => true,
            CursorEventType::MiddleClick { pressed: true } if !config.left_clicks_only => true,
            _ => false,
        })
        .collect();

    if clicks.is_empty() {
        log::info!("[AUTO_ZOOM] No click events found in cursor recording");
        return Ok(Vec::new());
    }

    log::info!("[AUTO_ZOOM] Found {} click events", clicks.len());

    // Generate zoom regions
    let mut regions: Vec<ZoomRegion> = Vec::new();

    for click in clicks {
        // Calculate region-relative coordinates
        let relative_x = click.x - recording.region_offset_x;
        let relative_y = click.y - recording.region_offset_y;

        // Normalize to 0-1 range based on video dimensions
        let target_x = (relative_x as f32 / video_width as f32).clamp(0.0, 1.0);
        let target_y = (relative_y as f32 / video_height as f32).clamp(0.0, 1.0);

        // Check if this click is too close to the previous one
        if let Some(last_region) = regions.last_mut() {
            let gap = click.timestamp_ms.saturating_sub(last_region.end_ms);

            if gap < config.min_gap_ms as u64 {
                // Extend the previous region instead of creating a new one
                last_region.end_ms = click.timestamp_ms + config.hold_duration_ms as u64;
                log::debug!(
                    "[AUTO_ZOOM] Extended region {} to {}ms (merged close click)",
                    last_region.id,
                    last_region.end_ms
                );
                continue;
            }
        }

        // Create new zoom region
        let region_id = format!(
            "auto_zoom_{}_{:08x}",
            click.timestamp_ms,
            rand::random::<u32>()
        );

        let region = ZoomRegion {
            id: region_id,
            start_ms: click.timestamp_ms,
            end_ms: click.timestamp_ms + config.hold_duration_ms as u64,
            scale: config.scale,
            target_x,
            target_y,
            mode: ZoomRegionMode::Auto, // Auto-generated zooms follow cursor
            is_auto: true,
            transition: ZoomTransition {
                duration_in_ms: config.transition_in_ms,
                duration_out_ms: config.transition_out_ms,
                easing: config.easing,
            },
        };

        log::debug!(
            "[AUTO_ZOOM] Created region at {}ms, target ({:.2}, {:.2})",
            region.start_ms,
            target_x,
            target_y
        );

        regions.push(region);
    }

    log::info!("[AUTO_ZOOM] Generated {} zoom regions", regions.len());

    Ok(regions)
}

/// Apply auto-zoom to a video project.
///
/// Generates zoom regions from cursor data and adds them to the project.
/// Existing auto-generated regions are removed; manual regions are preserved.
///
/// # Arguments
/// * `project` - The video project to modify
/// * `config` - Auto-zoom configuration settings
///
/// # Returns
/// Updated project with new auto-zoom regions
pub fn apply_auto_zoom_to_project(
    mut project: VideoProject,
    config: &AutoZoomConfig,
) -> Result<VideoProject, String> {
    // Check if cursor data exists
    let cursor_path = match &project.sources.cursor_data {
        Some(path) => std::path::Path::new(path),
        None => return Err("No cursor data available for this project".to_string()),
    };

    if !cursor_path.exists() {
        return Err(format!("Cursor data file not found: {:?}", cursor_path));
    }

    // Generate new auto-zoom regions
    let new_regions = generate_auto_zoom_regions(
        cursor_path,
        config,
        project.sources.original_width,
        project.sources.original_height,
    )?;

    // Remove existing auto-generated regions, keep manual ones
    project.zoom.regions.retain(|r| !r.is_auto);

    // Add new auto-generated regions
    project.zoom.regions.extend(new_regions);

    // Sort all regions by start time
    project.zoom.regions.sort_by_key(|r| r.start_ms);

    // Update timestamp
    project.updated_at = chrono::Utc::now().to_rfc3339();

    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_video_project_serialization() {
        let project = VideoProject::new("test.mp4", 1920, 1080, 60000, 30);

        let json = serde_json::to_string(&project).unwrap();
        let deserialized: VideoProject = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.sources.original_width, 1920);
        assert_eq!(deserialized.timeline.duration_ms, 60000);
    }

    #[test]
    fn test_zoom_region_serialization() {
        let region = ZoomRegion {
            id: "test-id".to_string(),
            start_ms: 1000,
            end_ms: 3000,
            scale: 2.0,
            target_x: 0.5,
            target_y: 0.5,
            mode: ZoomRegionMode::Manual,
            is_auto: true,
            transition: ZoomTransition::default(),
        };

        let json = serde_json::to_string(&region).unwrap();
        assert!(json.contains("startMs"));
        assert!(json.contains("targetX"));
    }

    #[test]
    fn test_auto_zoom_config_serialization() {
        let config = AutoZoomConfig::default();

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("scale"));
        assert!(json.contains("holdDurationMs"));
        assert!(json.contains("minGapMs"));

        let deserialized: AutoZoomConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.scale, 2.0);
        assert_eq!(deserialized.hold_duration_ms, 1500);
    }
}

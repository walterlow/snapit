//! Type definitions for video projects.
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
    /// Mask/blur region configuration.
    #[serde(default)]
    pub mask: MaskConfig,
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
            mode: ZoomMode::Off,
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
        ZoomRegionMode::Auto
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

/// Type of cursor to display in output video.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum CursorType {
    /// Use the actual recorded cursor appearance.
    #[default]
    Auto,
    /// Display a simple circle indicator instead of actual cursor.
    Circle,
}

/// Animation style preset for cursor movement smoothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum CursorAnimationStyle {
    /// Slower, more deliberate movement (tension: 65, mass: 1.8, friction: 16).
    Slow,
    /// Balanced, natural movement (tension: 120, mass: 1.1, friction: 18).
    #[default]
    Mellow,
    /// Quick, responsive movement (tension: 200, mass: 0.8, friction: 20).
    Fast,
    /// User-defined tension/mass/friction values.
    Custom,
}

impl CursorAnimationStyle {
    /// Get the preset physics values for this animation style.
    /// Returns (tension, mass, friction) or None for Custom.
    pub fn preset_values(&self) -> Option<(f32, f32, f32)> {
        match self {
            Self::Slow => Some((65.0, 1.8, 16.0)),
            Self::Mellow => Some((120.0, 1.1, 18.0)),
            Self::Fast => Some((200.0, 0.8, 20.0)),
            Self::Custom => None,
        }
    }
}

/// Cursor rendering configuration.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CursorConfig {
    /// Show cursor in output video.
    pub visible: bool,
    /// Type of cursor to display (actual cursor or circle indicator).
    #[serde(default)]
    pub cursor_type: CursorType,
    /// Scale factor (1.0 = native size, 2.0 = double size).
    pub scale: f32,
    /// Enable smooth movement interpolation.
    pub smooth_movement: bool,
    /// Animation style preset (determines physics values).
    #[serde(default)]
    pub animation_style: CursorAnimationStyle,
    /// Spring tension for physics-based smoothing (higher = snappier).
    #[serde(default = "CursorConfig::default_tension")]
    pub tension: f32,
    /// Mass for physics-based smoothing (higher = more momentum).
    #[serde(default = "CursorConfig::default_mass")]
    pub mass: f32,
    /// Friction for physics-based smoothing (higher = more damping).
    #[serde(default = "CursorConfig::default_friction")]
    pub friction: f32,
    /// Motion blur amount (0.0 = none, 1.0 = maximum).
    #[serde(default)]
    pub motion_blur: f32,
    /// Click highlight settings.
    pub click_highlight: ClickHighlightConfig,
    /// Hide cursor when idle.
    pub hide_when_idle: bool,
    /// Time before hiding idle cursor (milliseconds).
    pub idle_timeout_ms: u32,
}

impl CursorConfig {
    fn default_tension() -> f32 {
        120.0
    }
    fn default_mass() -> f32 {
        1.1
    }
    fn default_friction() -> f32 {
        18.0
    }
}

impl Default for CursorConfig {
    fn default() -> Self {
        let style = CursorAnimationStyle::default();
        let (tension, mass, friction) = style.preset_values().unwrap_or((120.0, 1.1, 18.0));
        Self {
            visible: true,
            cursor_type: CursorType::default(),
            scale: 1.0,
            smooth_movement: true,
            animation_style: style,
            tension,
            mass,
            friction,
            motion_blur: 0.0,
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
    /// Crop configuration for video output.
    #[serde(default)]
    pub crop: CropConfig,
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
            crop: CropConfig::default(),
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
/// Matches Cap's BackgroundSource enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum BackgroundType {
    /// Solid color background.
    Solid,
    /// Gradient background.
    Gradient,
    /// Built-in wallpaper preset.
    Wallpaper,
    /// Custom image background.
    Image,
}

/// Shadow configuration for video frame background.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct BackgroundShadowConfig {
    /// Shadow enabled.
    pub enabled: bool,
    /// Master shadow strength (0-100). Multiplies all other shadow parameters.
    /// This matches Cap's shadow model where strength modulates size/opacity/blur.
    #[serde(default = "default_shadow_strength")]
    pub strength: f32,
    /// Shadow size/spread (0-100).
    pub size: f32,
    /// Shadow opacity (0-100).
    pub opacity: f32,
    /// Shadow blur amount (0-100).
    pub blur: f32,
}

fn default_shadow_strength() -> f32 {
    73.6 // Cap's default
}

impl Default for BackgroundShadowConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            strength: default_shadow_strength(),
            size: 14.4,
            opacity: 68.1,
            blur: 3.8,
        }
    }
}

/// Border configuration for video frame.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct BorderConfig {
    /// Border enabled.
    pub enabled: bool,
    /// Border width in pixels (1-20).
    pub width: f32,
    /// Border color (hex format).
    pub color: String,
    /// Border opacity (0-100).
    pub opacity: f32,
}

impl Default for BorderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            width: 5.0, // Cap's default
            color: "#ffffff".to_string(),
            opacity: 80.0,
        }
    }
}

/// Background configuration for letterboxing/padding.
/// Matches Cap's BackgroundConfiguration struct.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct BackgroundConfig {
    /// Type of background (Solid, Gradient, Wallpaper, Image).
    pub bg_type: BackgroundType,
    /// Solid color (hex format, e.g., "#000000").
    pub solid_color: String,
    /// Gradient start color (hex format).
    pub gradient_start: String,
    /// Gradient end color (hex format).
    pub gradient_end: String,
    /// Gradient angle in degrees (0-360).
    pub gradient_angle: f32,
    /// Wallpaper preset name (e.g., "macOS/sequoia-dark").
    #[serde(default)]
    pub wallpaper: Option<String>,
    /// Custom image path.
    #[serde(default)]
    pub image_path: Option<String>,
    /// Background blur amount (0-100%).
    #[serde(default)]
    pub blur: f32,
    /// Padding around video frame (0-200 pixels).
    #[serde(default)]
    pub padding: f32,
    /// Inset value (pixels).
    #[serde(default)]
    pub inset: u32,
    /// Corner rounding radius (0-100 pixels).
    #[serde(default)]
    pub rounding: f32,
    /// Corner rounding style (squircle or rounded).
    #[serde(default)]
    pub rounding_type: CornerStyle,
    /// Shadow configuration.
    #[serde(default)]
    pub shadow: BackgroundShadowConfig,
    /// Border configuration.
    #[serde(default)]
    pub border: BorderConfig,
}

impl Default for BackgroundConfig {
    fn default() -> Self {
        Self {
            bg_type: BackgroundType::Solid,
            solid_color: "#ffffff".to_string(), // Cap's default: white
            gradient_start: "#4785ff".to_string(), // Cap's default: blue [71, 133, 255]
            gradient_end: "#ff4766".to_string(), // Cap's default: red/pink [255, 71, 102]
            gradient_angle: 135.0,
            wallpaper: None,
            image_path: None,
            blur: 0.0,
            padding: 0.0,
            inset: 0,
            rounding: 0.0,
            rounding_type: CornerStyle::default(),
            shadow: BackgroundShadowConfig::default(),
            border: BorderConfig::default(),
        }
    }
}

/// Crop configuration for video output.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CropConfig {
    /// Enable cropping.
    pub enabled: bool,
    /// Crop X position (pixels from left).
    pub x: u32,
    /// Crop Y position (pixels from top).
    pub y: u32,
    /// Crop width (pixels).
    pub width: u32,
    /// Crop height (pixels).
    pub height: u32,
    /// Lock aspect ratio.
    pub lock_aspect_ratio: bool,
    /// Locked aspect ratio (width/height), e.g., 1.7778 for 16:9.
    pub aspect_ratio: Option<f32>,
}

impl Default for CropConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            lock_aspect_ratio: false,
            aspect_ratio: None,
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

// ============================================================================
// Scene Configuration
// ============================================================================

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

// ============================================================================
// Mask Configuration
// ============================================================================

/// Type of mask effect for hiding sensitive content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum MaskType {
    /// Gaussian blur effect.
    Blur,
    /// Mosaic/pixelation effect.
    Pixelate,
    /// Solid color overlay.
    Solid,
}

impl Default for MaskType {
    fn default() -> Self {
        MaskType::Blur
    }
}

/// A mask segment for hiding sensitive content.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MaskSegment {
    /// Unique identifier.
    pub id: String,
    /// Start time in milliseconds.
    #[ts(type = "number")]
    pub start_ms: u64,
    /// End time in milliseconds.
    #[ts(type = "number")]
    pub end_ms: u64,
    /// X position (0-1, normalized from left).
    pub x: f32,
    /// Y position (0-1, normalized from top).
    pub y: f32,
    /// Width (0-1, normalized).
    pub width: f32,
    /// Height (0-1, normalized).
    pub height: f32,
    /// Type of mask effect.
    #[serde(default)]
    pub mask_type: MaskType,
    /// Blur/pixelate intensity (0-100).
    #[serde(default = "MaskSegment::default_intensity")]
    pub intensity: f32,
    /// Edge feather/softness (0-100).
    #[serde(default)]
    pub feather: f32,
    /// Color for Solid type (hex format).
    #[serde(default = "MaskSegment::default_color")]
    pub color: String,
}

impl MaskSegment {
    fn default_intensity() -> f32 {
        50.0
    }

    fn default_color() -> String {
        "#000000".to_string()
    }
}

/// Mask configuration for the video.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MaskConfig {
    /// Mask segments.
    pub segments: Vec<MaskSegment>,
}

impl Default for MaskConfig {
    fn default() -> Self {
        Self {
            segments: Vec::new(),
        }
    }
}

// ============================================================================
// Text Configuration
// ============================================================================

/// Text alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// Text shadow settings.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct TextShadow {
    /// Horizontal offset in pixels.
    pub offset_x: f32,
    /// Vertical offset in pixels.
    pub offset_y: f32,
    /// Blur radius in pixels.
    pub blur: f32,
    /// Shadow color (hex format).
    pub color: String,
}

impl Default for TextShadow {
    fn default() -> Self {
        Self {
            offset_x: 2.0,
            offset_y: 2.0,
            blur: 4.0,
            color: "rgba(0,0,0,0.5)".to_string(),
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
    /// Font weight (100-900).
    #[serde(default = "TextSegment::default_font_weight")]
    pub font_weight: u32,
    /// Italic style.
    #[serde(default)]
    pub italic: bool,
    /// Text alignment.
    #[serde(default)]
    pub text_align: TextAlign,
    /// Text color (hex format).
    pub color: String,
    /// Background color (optional, hex format).
    #[serde(default)]
    pub background_color: Option<String>,
    /// Background padding in pixels.
    #[serde(default)]
    pub background_padding: f32,
    /// Background border radius in pixels.
    #[serde(default)]
    pub background_radius: f32,
    /// Text shadow settings (optional).
    #[serde(default)]
    pub shadow: Option<TextShadow>,
    /// Text animation style.
    pub animation: TextAnimation,
}

impl TextSegment {
    fn default_font_weight() -> u32 {
        400
    }
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
// VideoProject Implementation
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
            mask: MaskConfig::default(),
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

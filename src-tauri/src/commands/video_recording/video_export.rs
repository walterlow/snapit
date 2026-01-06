//! Video export module for the video editor.
//!
//! Exports edited video projects with:
//! - Zoom/pan effects based on ZoomRegions
//! - Webcam overlay compositing with shape masks
//! - Smooth easing transitions
//! - Multiple output formats (MP4, WebM, GIF)
//! - Progress reporting via Tauri events
//!
//! **NOTE**: VideoExporter struct is deprecated (replaced by GPU-based export).
//! Types (ExportProgress, ExportStage, ExportResult) are still used.

// Allow deprecated VideoExporter code
#![allow(dead_code)]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use ts_rs::TS;

use super::video_project::{
    EasingFunction, ExportFormat, VideoProject, WebcamOverlayPosition, ZoomRegion,
};

// ============================================================================
// Export Types
// ============================================================================

/// Progress event sent during export.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ExportProgress {
    /// Current progress (0.0 - 1.0).
    pub progress: f32,
    /// Current stage of export.
    pub stage: ExportStage,
    /// Human-readable status message.
    pub message: String,
}

/// Stages of the export process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ExportStage {
    /// Preparing export (building filter graph).
    Preparing,
    /// Encoding video.
    Encoding,
    /// Finalizing output file.
    Finalizing,
    /// Export complete.
    Complete,
    /// Export failed.
    Failed,
}

/// Result of a successful export.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct ExportResult {
    /// Path to the exported file.
    pub output_path: String,
    /// Duration in seconds.
    pub duration_secs: f64,
    /// File size in bytes.
    #[ts(type = "number")]
    pub file_size_bytes: u64,
    /// Output format.
    pub format: ExportFormat,
}

// ============================================================================
// Video Exporter (DEPRECATED)
// ============================================================================

/// FFmpeg-based video exporter for edited projects.
///
/// **DEPRECATED**: This CPU-based exporter is replaced by GPU-based
/// `rendering::exporter::export_video_gpu()`. Kept for reference.
#[allow(dead_code)]
pub struct VideoExporter {
    ffmpeg_path: PathBuf,
    project: VideoProject,
    output_path: PathBuf,
}

impl VideoExporter {
    /// Create a new video exporter.
    pub fn new(project: VideoProject, output_path: PathBuf) -> Result<Self, String> {
        let ffmpeg_path = crate::commands::storage::find_ffmpeg()
            .ok_or_else(|| "FFmpeg not found. Ensure FFmpeg is installed.".to_string())?;

        Ok(Self {
            ffmpeg_path,
            project,
            output_path,
        })
    }

    /// Export the video with zoom effects applied.
    ///
    /// Emits `export-progress` events to the frontend during export.
    pub fn export(&self, app: &AppHandle) -> Result<ExportResult, String> {
        self.emit_progress(app, 0.0, ExportStage::Preparing, "Building filter graph...");

        // Build the FFmpeg command
        let args = self.build_ffmpeg_args()?;

        // Log full command for debugging
        let cmd_str = format!("ffmpeg {}", args.join(" "));
        log::info!("[EXPORT] FFmpeg command:\n{}", cmd_str);

        // Also emit as progress message so frontend can see it
        self.emit_progress(
            app,
            0.05,
            ExportStage::Preparing,
            &format!("Starting FFmpeg..."),
        );

        // Run FFmpeg with progress parsing
        let mut child = crate::commands::storage::ffmpeg::create_hidden_command(&self.ffmpeg_path)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        // Parse progress from stderr (FFmpeg outputs progress info there)
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture FFmpeg stderr".to_string())?;

        let duration_ms = self.project.timeline.out_point - self.project.timeline.in_point;
        let duration_secs = duration_ms as f64 / 1000.0;

        // Collect stderr lines for error reporting
        let mut stderr_lines: Vec<String> = Vec::new();

        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                // Store all lines for potential error reporting
                stderr_lines.push(line.clone());

                // Parse FFmpeg progress output
                if let Some(progress) = self.parse_ffmpeg_progress(&line, duration_secs) {
                    let stage_progress = 0.1 + progress * 0.85; // 10%-95% for encoding
                    self.emit_progress(
                        app,
                        stage_progress,
                        ExportStage::Encoding,
                        &format!("Encoding... {:.0}%", progress * 100.0),
                    );
                }
            }
        }

        // Wait for FFmpeg to complete
        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;

        if !status.success() {
            self.emit_progress(app, 1.0, ExportStage::Failed, "Export failed");

            // Extract the last few lines that likely contain the error
            let error_context: Vec<&str> = stderr_lines
                .iter()
                .rev()
                .take(30)
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();

            let error_msg = error_context.join("\n");
            log::error!("[EXPORT] FFmpeg failed:\n{}", error_msg);
            log::error!("[EXPORT] Command was: ffmpeg {}", args.join(" "));

            return Err(format!(
                "FFmpeg failed ({})\n\nFFmpeg output:\n{}",
                status, error_msg
            ));
        }

        self.emit_progress(app, 0.95, ExportStage::Finalizing, "Finalizing...");

        // Get output file info
        let metadata = std::fs::metadata(&self.output_path)
            .map_err(|e| format!("Failed to read output file: {}", e))?;

        let result = ExportResult {
            output_path: self.output_path.to_string_lossy().to_string(),
            duration_secs,
            file_size_bytes: metadata.len(),
            format: self.project.export.format,
        };

        self.emit_progress(app, 1.0, ExportStage::Complete, "Export complete!");

        Ok(result)
    }

    /// Build FFmpeg command arguments.
    fn build_ffmpeg_args(&self) -> Result<Vec<String>, String> {
        let mut args = Vec::new();

        // Overwrite output
        args.push("-y".to_string());

        // Trim based on in/out points
        let in_secs = self.project.timeline.in_point as f64 / 1000.0;
        let out_secs = self.project.timeline.out_point as f64 / 1000.0;
        let duration = out_secs - in_secs;

        // Track input indices for audio mapping
        let mut input_index = 0;
        let screen_video_index = input_index;

        // Input 0: Screen video
        if in_secs > 0.0 {
            args.push("-ss".to_string());
            args.push(format!("{:.3}", in_secs));
        }
        args.push("-t".to_string());
        args.push(format!("{:.3}", duration));
        args.push("-i".to_string());
        args.push(self.project.sources.screen_video.clone());
        input_index += 1;

        // Check if we have webcam video to overlay
        let has_webcam = self.project.webcam.enabled
            && self.project.sources.webcam_video.is_some()
            && std::path::Path::new(self.project.sources.webcam_video.as_ref().unwrap()).exists();

        // Input: Webcam video (if available)
        if has_webcam {
            if in_secs > 0.0 {
                args.push("-ss".to_string());
                args.push(format!("{:.3}", in_secs));
            }
            args.push("-t".to_string());
            args.push(format!("{:.3}", duration));
            args.push("-i".to_string());
            args.push(self.project.sources.webcam_video.as_ref().unwrap().clone());
            input_index += 1;
        }

        // Check for separate audio tracks
        let has_system_audio = self.project.sources.system_audio.is_some()
            && !self.project.audio.system_muted
            && std::path::Path::new(self.project.sources.system_audio.as_ref().unwrap()).exists();

        let has_mic_audio = self.project.sources.microphone_audio.is_some()
            && !self.project.audio.microphone_muted
            && std::path::Path::new(self.project.sources.microphone_audio.as_ref().unwrap())
                .exists();

        let has_background_music = self.project.sources.background_music.is_some()
            && !self.project.audio.music_muted
            && std::path::Path::new(self.project.sources.background_music.as_ref().unwrap())
                .exists();

        // Input: System audio (if available)
        let system_audio_index = if has_system_audio {
            let idx = input_index;
            if in_secs > 0.0 {
                args.push("-ss".to_string());
                args.push(format!("{:.3}", in_secs));
            }
            args.push("-t".to_string());
            args.push(format!("{:.3}", duration));
            args.push("-i".to_string());
            args.push(self.project.sources.system_audio.as_ref().unwrap().clone());
            input_index += 1;
            Some(idx)
        } else {
            None
        };

        // Input: Microphone audio (if available)
        let mic_audio_index = if has_mic_audio {
            let idx = input_index;
            if in_secs > 0.0 {
                args.push("-ss".to_string());
                args.push(format!("{:.3}", in_secs));
            }
            args.push("-t".to_string());
            args.push(format!("{:.3}", duration));
            args.push("-i".to_string());
            args.push(
                self.project
                    .sources
                    .microphone_audio
                    .as_ref()
                    .unwrap()
                    .clone(),
            );
            input_index += 1;
            Some(idx)
        } else {
            None
        };

        // Input: Background music (if available)
        let music_index = if has_background_music {
            let idx = input_index;
            // Don't seek for music, let it play from start
            args.push("-t".to_string());
            args.push(format!("{:.3}", duration));
            args.push("-i".to_string());
            args.push(
                self.project
                    .sources
                    .background_music
                    .as_ref()
                    .unwrap()
                    .clone(),
            );
            Some(idx)
        } else {
            None
        };

        let has_separate_audio = has_system_audio || has_mic_audio || has_background_music;

        // Build video filter graph
        let video_filter = self.build_complete_filter(has_webcam)?;

        // Build audio filter graph (if separate audio tracks exist)
        let audio_filter = if has_separate_audio {
            self.build_audio_filter(system_audio_index, mic_audio_index, music_index, duration)?
        } else {
            String::new()
        };

        // Combine filters
        let combined_filter = if !video_filter.is_empty() && !audio_filter.is_empty() {
            format!("{};{}", video_filter, audio_filter)
        } else if !video_filter.is_empty() {
            video_filter
        } else if !audio_filter.is_empty() {
            audio_filter
        } else {
            String::new()
        };

        if !combined_filter.is_empty() {
            args.push("-filter_complex".to_string());
            args.push(combined_filter);
            args.push("-map".to_string());
            args.push("[vout]".to_string());

            // Map audio
            if has_separate_audio {
                args.push("-map".to_string());
                args.push("[aout]".to_string());
            } else {
                // Map audio from screen video (fallback)
                args.push("-map".to_string());
                args.push(format!("{}:a?", screen_video_index));
            }
        }

        // Output codec settings based on format
        match self.project.export.format {
            ExportFormat::Mp4 => {
                args.push("-c:v".to_string());
                args.push("libx264".to_string());
                args.push("-preset".to_string());
                args.push("medium".to_string());
                args.push("-crf".to_string());
                let crf = 51 - (self.project.export.quality as f32 * 0.51) as i32;
                args.push(crf.to_string());
                args.push("-pix_fmt".to_string());
                args.push("yuv420p".to_string());
                args.push("-c:a".to_string());
                args.push("aac".to_string());
                args.push("-b:a".to_string());
                args.push("128k".to_string());
            },
            ExportFormat::Webm => {
                args.push("-c:v".to_string());
                args.push("libvpx-vp9".to_string());
                args.push("-crf".to_string());
                let crf = 63 - (self.project.export.quality as f32 * 0.63) as i32;
                args.push(crf.to_string());
                args.push("-b:v".to_string());
                args.push("0".to_string());
                args.push("-c:a".to_string());
                args.push("libopus".to_string());
            },
            ExportFormat::Gif => {
                // GIF handled in filter graph with palette generation
                args.push("-loop".to_string());
                args.push("0".to_string());
            },
        }

        // FPS
        args.push("-r".to_string());
        args.push(self.project.export.fps.to_string());

        // Progress reporting
        args.push("-progress".to_string());
        args.push("pipe:1".to_string());

        // Output path
        args.push(self.output_path.to_string_lossy().to_string());

        Ok(args)
    }

    /// Build audio filter for mixing multiple audio tracks.
    ///
    /// Applies volume control, fade effects, and optional loudnorm normalization.
    fn build_audio_filter(
        &self,
        system_audio_index: Option<usize>,
        mic_audio_index: Option<usize>,
        music_index: Option<usize>,
        duration: f64,
    ) -> Result<String, String> {
        let audio_settings = &self.project.audio;
        let mut filters = Vec::new();
        let mut mix_inputs = Vec::new();
        let mut input_count = 0;

        // Process system audio
        if let Some(idx) = system_audio_index {
            let label = format!("sys{}", input_count);
            filters.push(format!(
                "[{}:a]volume={:.2}[{}]",
                idx, audio_settings.system_volume, label
            ));
            mix_inputs.push(format!("[{}]", label));
            input_count += 1;
        }

        // Process microphone audio
        if let Some(idx) = mic_audio_index {
            let label = format!("mic{}", input_count);
            filters.push(format!(
                "[{}:a]volume={:.2}[{}]",
                idx, audio_settings.microphone_volume, label
            ));
            mix_inputs.push(format!("[{}]", label));
            input_count += 1;
        }

        // Process background music with fade in/out
        if let Some(idx) = music_index {
            let label = format!("mus{}", input_count);
            let fade_in = audio_settings.music_fade_in_secs;
            let fade_out = audio_settings.music_fade_out_secs;
            let fade_out_start = (duration - fade_out as f64).max(0.0);

            // Apply volume and fades
            let music_filter = format!(
                "[{}:a]volume={:.2},afade=t=in:st=0:d={:.2},afade=t=out:st={:.2}:d={:.2}[{}]",
                idx, audio_settings.music_volume, fade_in, fade_out_start, fade_out, label
            );
            filters.push(music_filter);
            mix_inputs.push(format!("[{}]", label));
            input_count += 1;
        }

        // No audio to mix
        if input_count == 0 {
            return Ok(String::new());
        }

        // Mix all audio tracks
        let mix_filter = if input_count == 1 {
            // Single track - just pass through with optional normalization
            let input_label = &mix_inputs[0];
            if audio_settings.normalize_output {
                format!("{}loudnorm=I=-16:TP=-1.5:LRA=11[aout]", input_label)
            } else {
                format!("{}anull[aout]", input_label)
            }
        } else {
            // Multiple tracks - mix them together
            let inputs_str = mix_inputs.join("");
            if audio_settings.normalize_output {
                format!(
                    "{}amix=inputs={}:duration=longest:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11[aout]",
                    inputs_str, input_count
                )
            } else {
                format!(
                    "{}amix=inputs={}:duration=longest:dropout_transition=2[aout]",
                    inputs_str, input_count
                )
            }
        };
        filters.push(mix_filter);

        Ok(filters.join(";"))
    }

    /// Build complete filter graph including zoom and webcam overlay.
    fn build_complete_filter(&self, has_webcam: bool) -> Result<String, String> {
        let width = self.project.sources.original_width;
        let height = self.project.sources.original_height;
        let mut filters = Vec::new();

        // Step 1: Process screen video
        // NOTE: Zoom effects via zoompan are disabled due to FFmpeg expression parsing issues
        // on Windows. The expressions with nested if() and between() get mangled by the
        // command-line parser. Future improvement: render zoom on GPU like Cap does.
        // For now, just pass through the video without zoom effects.
        filters.push("[0:v]null[screen]".to_string());

        // Step 2: Process and overlay webcam if available
        if has_webcam {
            let webcam_filter = self.build_webcam_filter(width, height)?;
            filters.push(webcam_filter);
            filters.push(
                "[screen][webcam]overlay=x=overlay_x:y=overlay_y[composited]"
                    .to_string()
                    .replace("overlay_x", &self.get_webcam_x(width).to_string())
                    .replace("overlay_y", &self.get_webcam_y(height).to_string()),
            );

            // Final output - ensure even dimensions for libx264 compatibility
            // scale=trunc(iw/2)*2:trunc(ih/2)*2 rounds dimensions down to even numbers
            if self.project.export.format == ExportFormat::Gif {
                filters.push("[composited]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[vout]".to_string());
            } else {
                filters.push("[composited]scale=trunc(iw/2)*2:trunc(ih/2)*2[vout]".to_string());
            }
        } else {
            // No webcam, just pass through
            // Ensure even dimensions for libx264 compatibility
            if self.project.export.format == ExportFormat::Gif {
                filters.push("[screen]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[vout]".to_string());
            } else {
                filters.push("[screen]scale=trunc(iw/2)*2:trunc(ih/2)*2[vout]".to_string());
            }
        }

        Ok(filters.join(";"))
    }

    /// Build webcam processing filter (scale, crop to circle if needed).
    fn build_webcam_filter(
        &self,
        screen_width: u32,
        _screen_height: u32,
    ) -> Result<String, String> {
        let webcam_cfg = &self.project.webcam;

        // Calculate webcam size based on percentage of screen width
        let webcam_size = (screen_width as f32 * webcam_cfg.size) as u32;

        let mut filter_parts = Vec::new();

        // Scale webcam to target size
        filter_parts.push(format!("[1:v]scale={}:{}", webcam_size, webcam_size));

        // NOTE: Circle mask via geq filter is disabled due to FFmpeg expression parsing
        // issues on Windows. The single quotes around geq expressions get mangled.
        // Future improvement: render webcam overlay on GPU with proper masking.
        // For now, webcam overlay is always square.

        // Mirror if enabled
        if webcam_cfg.mirror {
            filter_parts.push("hflip".to_string());
        }

        Ok(format!("{}[webcam]", filter_parts.join(",")))
    }

    /// Calculate webcam X position based on settings.
    fn get_webcam_x(&self, screen_width: u32) -> i32 {
        let webcam_cfg = &self.project.webcam;
        let webcam_size = (screen_width as f32 * webcam_cfg.size) as i32;
        let margin = 20;

        match webcam_cfg.position {
            WebcamOverlayPosition::TopLeft | WebcamOverlayPosition::BottomLeft => margin,
            WebcamOverlayPosition::TopRight | WebcamOverlayPosition::BottomRight => {
                screen_width as i32 - webcam_size - margin
            },
            WebcamOverlayPosition::Custom => {
                (screen_width as f32 * webcam_cfg.custom_x) as i32 - webcam_size / 2
            },
        }
    }

    /// Calculate webcam Y position based on settings.
    fn get_webcam_y(&self, screen_height: u32) -> i32 {
        let webcam_cfg = &self.project.webcam;
        let screen_width = self.project.sources.original_width;
        let webcam_size = (screen_width as f32 * webcam_cfg.size) as i32;
        let margin = 20;

        match webcam_cfg.position {
            WebcamOverlayPosition::TopLeft | WebcamOverlayPosition::TopRight => margin,
            WebcamOverlayPosition::BottomLeft | WebcamOverlayPosition::BottomRight => {
                screen_height as i32 - webcam_size - margin
            },
            WebcamOverlayPosition::Custom => {
                (screen_height as f32 * webcam_cfg.custom_y) as i32 - webcam_size / 2
            },
        }
    }

    /// Build the zoom/pan filter for FFmpeg.
    ///
    /// Uses the zoompan filter with expressions that evaluate zoom state at each frame.
    fn build_zoom_filter(&self) -> Result<String, String> {
        let regions = &self.project.zoom.regions;

        if regions.is_empty() {
            return Ok(String::new());
        }

        let width = self.project.sources.original_width;
        let height = self.project.sources.original_height;
        let fps = self.project.export.fps;
        let in_point_ms = self.project.timeline.in_point;

        // Build zoom expression that evaluates at each frame
        // Format: if(condition, value, else_value)
        // We chain conditions for each zoom region

        let zoom_expr = self.build_zoom_expression(regions, fps, in_point_ms);
        let x_expr = self.build_x_expression(regions, fps, in_point_ms, width);
        let y_expr = self.build_y_expression(regions, fps, in_point_ms, height);

        // zoompan filter: zoom in/out and pan
        // z = zoom level (1 = no zoom, 2 = 2x zoom)
        // x, y = top-left corner of the visible area
        // d = number of frames for zoompan (we use 1 to control per-frame)
        // s = output size
        // NOTE: Don't use quotes around expressions - Rust's Command handles escaping
        let filter = format!(
            "zoompan=z={}:x={}:y={}:d=1:s={}x{}:fps={}",
            zoom_expr, x_expr, y_expr, width, height, fps
        );

        Ok(filter)
    }

    /// Build the zoom level expression for FFmpeg.
    ///
    /// Creates a simple chain of if(between()) expressions.
    /// Transitions are not implemented in the FFmpeg expression to keep it simple and reliable.
    fn build_zoom_expression(&self, regions: &[ZoomRegion], fps: u32, in_point_ms: u64) -> String {
        if regions.is_empty() {
            return "1".to_string();
        }

        // Build simple chain: if(in_r1, z1, if(in_r2, z2, 1))
        let mut result = "1".to_string();

        for region in regions.iter().rev() {
            let start_ms = region.start_ms.saturating_sub(in_point_ms);
            let end_ms = region.end_ms.saturating_sub(in_point_ms);

            let start_frame = (start_ms as f64 * fps as f64 / 1000.0) as i64;
            let end_frame = (end_ms as f64 * fps as f64 / 1000.0) as i64;

            // Simple: if in region, use zoom level; otherwise fall through
            result = format!(
                "if(between(n,{},{}),{},{})",
                start_frame, end_frame, region.scale, result
            );
        }

        result
    }

    /// Build the X position expression for FFmpeg.
    ///
    /// For each zoom region, calculates the X offset to center the view on target_x.
    fn build_x_expression(
        &self,
        regions: &[ZoomRegion],
        fps: u32,
        in_point_ms: u64,
        width: u32,
    ) -> String {
        if regions.is_empty() {
            return "0".to_string();
        }

        // Build chain: if(in_region1, x1, if(in_region2, x2, 0))
        let mut result = "0".to_string();

        for region in regions.iter().rev() {
            let start_ms = region.start_ms.saturating_sub(in_point_ms);
            let end_ms = region.end_ms.saturating_sub(in_point_ms);

            let start_frame = (start_ms as f64 * fps as f64 / 1000.0) as i64;
            let end_frame = (end_ms as f64 * fps as f64 / 1000.0) as i64;

            // Target X in pixels (target_x is normalized 0-1)
            // When zoomed, we need to offset so the target is centered
            // visible_width = width / zoom
            // x_offset = target_x * width - visible_width / 2
            let target_x = region.target_x;
            let zoom = region.scale;

            let x_offset = (width as f32 * (target_x - 0.5 / zoom)).max(0.0);
            let max_x = width as f32 - (width as f32 / zoom);
            let x_clamped = x_offset.clamp(0.0, max_x) as i64;

            result = format!(
                "if(between(n,{},{}),{},{})",
                start_frame, end_frame, x_clamped, result
            );
        }

        result
    }

    /// Build the Y position expression for FFmpeg.
    ///
    /// For each zoom region, calculates the Y offset to center the view on target_y.
    fn build_y_expression(
        &self,
        regions: &[ZoomRegion],
        fps: u32,
        in_point_ms: u64,
        height: u32,
    ) -> String {
        if regions.is_empty() {
            return "0".to_string();
        }

        // Build chain: if(in_region1, y1, if(in_region2, y2, 0))
        let mut result = "0".to_string();

        for region in regions.iter().rev() {
            let start_ms = region.start_ms.saturating_sub(in_point_ms);
            let end_ms = region.end_ms.saturating_sub(in_point_ms);

            let start_frame = (start_ms as f64 * fps as f64 / 1000.0) as i64;
            let end_frame = (end_ms as f64 * fps as f64 / 1000.0) as i64;

            let target_y = region.target_y;
            let zoom = region.scale;

            let y_offset = (height as f32 * (target_y - 0.5 / zoom)).max(0.0);
            let max_y = height as f32 - (height as f32 / zoom);
            let y_clamped = y_offset.clamp(0.0, max_y) as i64;

            result = format!(
                "if(between(n,{},{}),{},{})",
                start_frame, end_frame, y_clamped, result
            );
        }

        result
    }

    /// Parse FFmpeg progress output.
    fn parse_ffmpeg_progress(&self, line: &str, total_duration: f64) -> Option<f32> {
        // FFmpeg progress output format:
        // out_time_ms=123456
        // Or time= format in stderr
        if line.starts_with("out_time_ms=") {
            let ms_str = line.trim_start_matches("out_time_ms=");
            if let Ok(ms) = ms_str.parse::<i64>() {
                let current_secs = ms as f64 / 1_000_000.0;
                return Some((current_secs / total_duration).min(1.0) as f32);
            }
        } else if line.contains("time=") {
            // Parse time=HH:MM:SS.ms format
            if let Some(time_pos) = line.find("time=") {
                let time_str = &line[time_pos + 5..];
                if let Some(space_pos) = time_str.find(' ') {
                    let time_val = &time_str[..space_pos];
                    if let Some(secs) = self.parse_time_str(time_val) {
                        return Some((secs / total_duration).min(1.0) as f32);
                    }
                }
            }
        }
        None
    }

    /// Parse time string like "00:01:23.45" to seconds.
    fn parse_time_str(&self, time_str: &str) -> Option<f64> {
        let parts: Vec<&str> = time_str.split(':').collect();
        if parts.len() == 3 {
            let hours: f64 = parts[0].parse().ok()?;
            let minutes: f64 = parts[1].parse().ok()?;
            let seconds: f64 = parts[2].parse().ok()?;
            return Some(hours * 3600.0 + minutes * 60.0 + seconds);
        }
        None
    }

    /// Emit progress event to frontend.
    fn emit_progress(&self, app: &AppHandle, progress: f32, stage: ExportStage, message: &str) {
        let event = ExportProgress {
            progress,
            stage,
            message: message.to_string(),
        };
        let _ = app.emit("export-progress", &event);
        log::debug!("[EXPORT] Progress: {:.0}% - {}", progress * 100.0, message);
    }
}

/// Apply easing function to a linear progress value (0-1).
#[allow(dead_code)]
fn apply_easing(t: f64, easing: EasingFunction) -> f64 {
    match easing {
        EasingFunction::Linear => t,
        EasingFunction::EaseIn => t * t,
        EasingFunction::EaseOut => 1.0 - (1.0 - t).powi(2),
        EasingFunction::EaseInOut => {
            if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
            }
        },
        EasingFunction::Smooth => {
            // Smoothstep
            t * t * (3.0 - 2.0 * t)
        },
        EasingFunction::Snappy => {
            // Quick start, gradual end
            1.0 - (1.0 - t).powi(3)
        },
        EasingFunction::Bouncy => {
            // Slight overshoot
            let c1 = 1.70158;
            let c3 = c1 + 1.0;
            1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
        },
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_easing_linear() {
        assert!((apply_easing(0.0, EasingFunction::Linear) - 0.0).abs() < 0.001);
        assert!((apply_easing(0.5, EasingFunction::Linear) - 0.5).abs() < 0.001);
        assert!((apply_easing(1.0, EasingFunction::Linear) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_easing_ease_in() {
        assert!((apply_easing(0.0, EasingFunction::EaseIn) - 0.0).abs() < 0.001);
        assert!(apply_easing(0.5, EasingFunction::EaseIn) < 0.5); // Slower at start
        assert!((apply_easing(1.0, EasingFunction::EaseIn) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_easing_ease_out() {
        assert!((apply_easing(0.0, EasingFunction::EaseOut) - 0.0).abs() < 0.001);
        assert!(apply_easing(0.5, EasingFunction::EaseOut) > 0.5); // Faster at start
        assert!((apply_easing(1.0, EasingFunction::EaseOut) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_time_str() {
        let exporter = VideoExporter {
            ffmpeg_path: PathBuf::new(),
            project: VideoProject::new("test.mp4", 1920, 1080, 60000, 30),
            output_path: PathBuf::new(),
        };

        assert_eq!(exporter.parse_time_str("00:00:00.00"), Some(0.0));
        assert_eq!(exporter.parse_time_str("00:01:00.00"), Some(60.0));
        assert_eq!(exporter.parse_time_str("01:00:00.00"), Some(3600.0));
        assert!((exporter.parse_time_str("00:00:30.50").unwrap() - 30.5).abs() < 0.001);
    }
}

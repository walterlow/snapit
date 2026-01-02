//! GPU-based video export pipeline.
//!
//! Like Cap, we:
//! 1. Decode frames with FFmpeg (streaming - ONE process, not per-frame)
//! 2. Render on GPU with zoom/webcam effects
//! 3. Pipe rendered RGBA frames to FFmpeg for encoding only

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio, Child};
use tauri::{AppHandle, Emitter};

use crate::commands::video_recording::video_project::{
    VideoProject, ExportFormat, WebcamOverlayPosition, WebcamOverlayShape, CornerStyle, ShadowConfig,
    ZoomMode, AutoZoomConfig, apply_auto_zoom_to_project, SceneMode,
};
use crate::commands::video_recording::video_export::{ExportProgress, ExportStage, ExportResult};
use super::zoom::ZoomInterpolator;
use super::stream_decoder::StreamDecoder;
use super::renderer::Renderer;
use super::compositor::Compositor;
use super::types::{RenderOptions, DecodedFrame, WebcamOverlay, WebcamShape};

/// Export a video project using GPU rendering.
/// 
/// Uses streaming decoders (1 FFmpeg process each) instead of per-frame spawning.
pub async fn export_video_gpu(
    app: AppHandle,
    project: VideoProject,
    output_path: String,
) -> Result<ExportResult, String> {
    let start_time = std::time::Instant::now();
    let output_path = PathBuf::from(&output_path);
    
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    emit_progress(&app, 0.0, ExportStage::Preparing, "Initializing GPU...");

    // Initialize GPU
    let renderer = Renderer::new().await?;
    let compositor = Compositor::new(&renderer);

    emit_progress(&app, 0.02, ExportStage::Preparing, "Loading video...");

    // Calculate export parameters
    let fps = project.export.fps;
    let width = project.sources.original_width;
    let height = project.sources.original_height;
    let in_point_ms = project.timeline.in_point;
    let out_point_ms = project.timeline.out_point;
    let duration_ms = out_point_ms - in_point_ms;
    let duration_secs = duration_ms as f64 / 1000.0;
    let total_frames = ((duration_ms as f64 / 1000.0) * fps as f64).ceil() as u32;

    // Ensure even dimensions
    let out_w = (width / 2) * 2;
    let out_h = (height / 2) * 2;

    // Initialize streaming decoders (ONE FFmpeg process each!)
    let screen_path = Path::new(&project.sources.screen_video);
    let mut screen_decoder = StreamDecoder::new(screen_path, in_point_ms, out_point_ms)?;
    screen_decoder.start(screen_path)?;

    // Webcam decoder if enabled
    let mut webcam_decoder = if project.webcam.enabled {
        if let Some(ref path) = project.sources.webcam_video {
            let webcam_path = Path::new(path);
            if webcam_path.exists() {
                let mut decoder = StreamDecoder::new(webcam_path, in_point_ms, out_point_ms)?;
                decoder.start(webcam_path)?;
                Some(decoder)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let has_webcam = webcam_decoder.is_some();

    log::info!(
        "[EXPORT] GPU export (streaming): {}x{} @ {}fps, {} frames, webcam={}",
        out_w, out_h, fps, total_frames, has_webcam
    );
    
    // Log scene configuration for debugging
    log::info!(
        "[EXPORT] Scene config: default_mode={:?}, {} segments, webcam.enabled={}, webcam.visibility_segments={}",
        project.scene.default_mode,
        project.scene.segments.len(),
        project.webcam.enabled,
        project.webcam.visibility_segments.len()
    );
    for seg in &project.scene.segments {
        log::info!(
            "[EXPORT]   Scene segment: {}ms-{}ms mode={:?}",
            seg.start_ms, seg.end_ms, seg.mode
        );
    }
    
    // Log zoom configuration
    log::info!(
        "[EXPORT] Zoom config: mode={:?}, {} regions",
        project.zoom.mode,
        project.zoom.regions.len()
    );

    emit_progress(&app, 0.05, ExportStage::Encoding, "Starting encoder...");

    // Start FFmpeg encoder (takes raw RGBA from stdin)
    let mut ffmpeg = start_ffmpeg_encoder(&project, &output_path, out_w, out_h, fps)?;
    let mut stdin = ffmpeg.stdin.take().ok_or("Failed to get FFmpeg stdin")?;

    // Generate auto zoom regions if mode is Auto/Both but regions are empty
    let project = if matches!(project.zoom.mode, ZoomMode::Auto | ZoomMode::Both) 
        && project.zoom.regions.is_empty() 
        && project.sources.cursor_data.is_some() 
    {
        log::info!("[EXPORT] Auto zoom mode enabled but no regions - generating...");
        match apply_auto_zoom_to_project(project.clone(), &AutoZoomConfig::default()) {
            Ok(updated) => {
                log::info!("[EXPORT] Generated {} auto zoom regions", updated.zoom.regions.len());
                updated
            }
            Err(e) => {
                log::warn!("[EXPORT] Failed to generate auto zoom: {}", e);
                project
            }
        }
    } else {
        project
    };

    // Create zoom interpolator
    let zoom_interpolator = ZoomInterpolator::new(&project.zoom);

    emit_progress(&app, 0.08, ExportStage::Encoding, "Rendering frames...");

    // Render each frame sequentially from streaming decoders
    let mut frame_idx = 0u32;
    let mut last_webcam_frame: Option<DecodedFrame> = None; // Cache last webcam frame
    
    loop {
        // Read next screen frame from stream (async)
        let screen_frame = match screen_decoder.next_frame().await? {
            Some(frame) => frame,
            None => break, // End of stream
        };

        // Calculate relative timestamp (position in trimmed video = what timeline shows)
        // Scene segments, zoom regions, and visibility all use timeline-relative time
        let relative_time_ms = ((frame_idx as f64 / fps as f64) * 1000.0) as u64;
        
        // Scene segments and zoom regions use RELATIVE time (timeline position)
        let zoom_state = zoom_interpolator.get_zoom_at(relative_time_ms);
        let scene_mode = get_scene_mode_at(&project, relative_time_ms);
        let webcam_visible = is_webcam_visible_at(&project, relative_time_ms);
        
        // Log first few frames for debugging
        if frame_idx < 3 || (relative_time_ms >= 6000 && relative_time_ms <= 6200) {
            log::debug!(
                "[EXPORT] Frame {}: relative={}ms, scene_mode={:?}",
                frame_idx, relative_time_ms, scene_mode
            );
        }
        
        // Read webcam frame if we have a decoder (always consume to stay in sync)
        let current_webcam_frame = if let Some(ref mut decoder) = webcam_decoder {
            match decoder.next_frame().await {
                Ok(Some(webcam_frame)) => {
                    last_webcam_frame = Some(webcam_frame.clone());
                    Some(webcam_frame)
                }
                _ => last_webcam_frame.clone(),
            }
        } else {
            None
        };

        // Determine what to render based on scene mode
        let (frame_to_render, webcam_overlay) = match scene_mode {
            SceneMode::CameraOnly => {
                // Fullscreen webcam - use webcam frame as main content, no overlay
                if let Some(ref webcam_frame) = current_webcam_frame {
                    if frame_idx % 30 == 0 {
                        log::info!(
                            "[EXPORT] CameraOnly mode at {}ms - rendering webcam {}x{} fullscreen",
                            relative_time_ms, webcam_frame.width, webcam_frame.height
                        );
                    }
                    // Scale webcam frame to output size
                    let scaled_frame = scale_frame_to_fill(webcam_frame, out_w, out_h);
                    (scaled_frame, None)
                } else {
                    log::warn!("[EXPORT] CameraOnly mode but no webcam frame available!");
                    // No webcam available, fallback to screen
                    (screen_frame.clone(), None)
                }
            }
            SceneMode::ScreenOnly => {
                // Screen only - no webcam overlay
                (screen_frame.clone(), None)
            }
            SceneMode::Default => {
                // Default - screen with webcam overlay (if visible)
                let overlay = if webcam_visible {
                    current_webcam_frame.as_ref().map(|frame| {
                        build_webcam_overlay(&project, frame.clone(), out_w, out_h)
                    })
                } else {
                    None
                };
                (screen_frame.clone(), overlay)
            }
        };

        let render_options = RenderOptions {
            output_width: out_w,
            output_height: out_h,
            zoom: zoom_state,
            webcam: webcam_overlay,
            cursor: None,
            background: Default::default(),
        };

        // Render frame on GPU
        let output_texture = compositor.composite(
            &renderer,
            &frame_to_render,
            &render_options,
            relative_time_ms as f32,
        );

        // Read rendered frame back to CPU
        let rgba_data = renderer.read_texture(&output_texture, out_w, out_h).await;

        // Write to FFmpeg encoder
        if let Err(e) = stdin.write_all(&rgba_data) {
            log::error!("[EXPORT] Failed to write frame {}: {}", frame_idx, e);
            break;
        }

        // Progress update (every 10 frames)
        if frame_idx % 10 == 0 {
            let progress = (frame_idx + 1) as f32 / total_frames as f32;
            let stage_progress = 0.08 + progress * 0.87;
            emit_progress(
                &app,
                stage_progress,
                ExportStage::Encoding,
                &format!("Rendering: {:.0}%", progress * 100.0),
            );
        }

        frame_idx += 1;
        if frame_idx >= total_frames {
            break;
        }
    }

    // Close stdin to signal EOF
    drop(stdin);

    emit_progress(&app, 0.95, ExportStage::Finalizing, "Finalizing...");

    // Wait for FFmpeg encoder to finish
    let status = ffmpeg.wait().map_err(|e| format!("FFmpeg wait failed: {}", e))?;
    if !status.success() {
        return Err(format!("FFmpeg encoding failed with status: {:?}", status.code()));
    }

    // Decoders are stopped automatically via Drop

    // Get output file info
    let metadata = std::fs::metadata(&output_path)
        .map_err(|e| format!("Failed to read output file: {}", e))?;

    emit_progress(&app, 1.0, ExportStage::Complete, "Export complete!");

    log::info!(
        "[EXPORT] Complete in {:.1}s: {} bytes",
        start_time.elapsed().as_secs_f32(),
        metadata.len()
    );

    Ok(ExportResult {
        output_path: output_path.to_string_lossy().to_string(),
        duration_secs,
        file_size_bytes: metadata.len(),
        format: project.export.format,
    })
}

/// Build webcam overlay from frame and project settings.
/// Positioning logic matches WebcamOverlay.tsx exactly for WYSIWYG export.
fn build_webcam_overlay(
    project: &VideoProject,
    frame: DecodedFrame,
    out_w: u32,
    out_h: u32,
) -> WebcamOverlay {
    // Match preview exactly: 16px margin, square pixels
    const MARGIN_PX: f32 = 16.0;
    
    // Webcam overlay is square in PIXELS (same as preview)
    let webcam_size_px = out_w as f32 * project.webcam.size as f32;
    
    // Calculate position in PIXELS first (matching WebcamOverlay.tsx getPositionStyle)
    let (left_px, top_px) = match project.webcam.position {
        WebcamOverlayPosition::TopLeft => {
            (MARGIN_PX, MARGIN_PX)
        }
        WebcamOverlayPosition::TopRight => {
            (out_w as f32 - webcam_size_px - MARGIN_PX, MARGIN_PX)
        }
        WebcamOverlayPosition::BottomLeft => {
            (MARGIN_PX, out_h as f32 - webcam_size_px - MARGIN_PX)
        }
        WebcamOverlayPosition::BottomRight => {
            (out_w as f32 - webcam_size_px - MARGIN_PX, out_h as f32 - webcam_size_px - MARGIN_PX)
        }
        WebcamOverlayPosition::Custom => {
            // Custom positioning matches preview logic
            let custom_x = project.webcam.custom_x as f32;
            let custom_y = project.webcam.custom_y as f32;
            
            let left = if custom_x <= 0.1 {
                MARGIN_PX
            } else if custom_x >= 0.9 {
                out_w as f32 - webcam_size_px - MARGIN_PX
            } else {
                custom_x * out_w as f32 - webcam_size_px / 2.0
            };
            
            let top = if custom_y <= 0.1 {
                MARGIN_PX
            } else if custom_y >= 0.9 {
                out_h as f32 - webcam_size_px - MARGIN_PX
            } else {
                custom_y * out_h as f32 - webcam_size_px / 2.0
            };
            
            (left, top)
        }
    };
    
    // Convert to normalized coordinates (0-1)
    let x_norm = left_px / out_w as f32;
    let y_norm = top_px / out_h as f32;
    
    // Log for debugging
    eprintln!(
        "[EXPORT] Webcam: {}x{} aspect={:.3}, overlay={}px, pos=({:.0},{:.0})px norm=({:.3},{:.3})",
        frame.width, frame.height,
        frame.width as f32 / frame.height as f32,
        webcam_size_px, left_px, top_px, x_norm, y_norm
    );

    let shape = match project.webcam.shape {
        WebcamOverlayShape::Circle => WebcamShape::Circle,
        WebcamOverlayShape::Rectangle => WebcamShape::Rectangle,
        // Use Squircle for RoundedRectangle (iOS-style)
        WebcamOverlayShape::RoundedRectangle => WebcamShape::Squircle,
    };

    // Default shadow settings (subtle drop shadow like Cap)
    // TODO: Add shadow settings to WebcamConfig for user control
    let shadow = 0.5;           // 50% shadow strength
    let shadow_size = 0.15;     // 15% of webcam size
    let shadow_opacity = 0.25;  // 25% opacity
    let shadow_blur = 0.3;      // 30% blur

    WebcamOverlay {
        frame,
        x: x_norm,
        y: y_norm,
        size: project.webcam.size as f32,
        shape,
        mirror: project.webcam.mirror,
        shadow,
        shadow_size,
        shadow_opacity,
        shadow_blur,
    }
}

/// Start FFmpeg process for encoding raw RGBA input.
fn start_ffmpeg_encoder(
    project: &VideoProject,
    output_path: &Path,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<Child, String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg()
        .ok_or("FFmpeg not found")?;

    let mut args = vec![
        "-y".to_string(),
        // Raw RGBA input from stdin
        "-f".to_string(), "rawvideo".to_string(),
        "-pix_fmt".to_string(), "rgba".to_string(),
        "-s".to_string(), format!("{}x{}", width, height),
        "-r".to_string(), fps.to_string(),
        "-i".to_string(), "-".to_string(),
    ];

    // Add audio if available
    if let Some(ref audio_path) = project.sources.system_audio {
        if Path::new(audio_path).exists() && !project.audio.system_muted {
            args.extend(["-i".to_string(), audio_path.clone()]);
        }
    }

    // Output encoding based on format
    match project.export.format {
        ExportFormat::Mp4 => {
            let crf = quality_to_crf(project.export.quality);
            args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-preset".to_string(), "fast".to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
            ]);
            if has_audio(project) {
                args.extend([
                    "-c:a".to_string(), "aac".to_string(),
                    "-b:a".to_string(), "192k".to_string(),
                    "-shortest".to_string(),
                ]);
            }
        }
        ExportFormat::Webm => {
            let crf = quality_to_crf(project.export.quality);
            args.extend([
                "-c:v".to_string(), "libvpx-vp9".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-b:v".to_string(), "0".to_string(),
                "-deadline".to_string(), "realtime".to_string(),
                "-cpu-used".to_string(), "4".to_string(),
            ]);
            if has_audio(project) {
                args.extend([
                    "-c:a".to_string(), "libopus".to_string(),
                    "-b:a".to_string(), "128k".to_string(),
                ]);
            }
        }
        ExportFormat::Gif => {
            args.extend([
                "-vf".to_string(),
                format!("fps={},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", fps.min(15)),
            ]);
        }
    }

    args.push(output_path.to_string_lossy().to_string());

    log::info!("[EXPORT] FFmpeg encoder: ffmpeg {}", args.join(" "));

    Command::new(&ffmpeg_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))
}

fn has_audio(project: &VideoProject) -> bool {
    (project.sources.system_audio.is_some() && !project.audio.system_muted) ||
    (project.sources.microphone_audio.is_some() && !project.audio.microphone_muted)
}

fn quality_to_crf(quality: u32) -> u8 {
    (35 - ((quality as f32 / 100.0) * 20.0) as u8).clamp(15, 35)
}

fn emit_progress(app: &AppHandle, progress: f32, stage: ExportStage, message: &str) {
    let _ = app.emit("export-progress", ExportProgress {
        progress,
        stage,
        message: message.to_string(),
    });
}

/// Scale a frame to fit within target dimensions (letterbox/pillarbox to maintain aspect ratio).
/// Used for CameraOnly mode to show webcam fullscreen without cropping.
fn scale_frame_to_fill(frame: &DecodedFrame, target_w: u32, target_h: u32) -> DecodedFrame {
    let src_w = frame.width;
    let src_h = frame.height;
    
    // Calculate scaling to FIT (contain) within the target - no cropping
    let scale_x = target_w as f32 / src_w as f32;
    let scale_y = target_h as f32 / src_h as f32;
    let scale = scale_x.min(scale_y); // Use smaller scale to fit entirely
    
    let scaled_w = (src_w as f32 * scale) as u32;
    let scaled_h = (src_h as f32 * scale) as u32;
    
    // Calculate offsets to center the scaled image
    let offset_x = (target_w - scaled_w) / 2;
    let offset_y = (target_h - scaled_h) / 2;
    
    // Create output buffer (black background)
    let mut output = vec![0u8; (target_w * target_h * 4) as usize];
    
    // Simple nearest-neighbor scaling, centered
    for y in 0..scaled_h {
        for x in 0..scaled_w {
            // Map scaled pixel to source pixel
            let src_x = (x as f32 / scale) as u32;
            let src_y = (y as f32 / scale) as u32;
            
            if src_x < src_w && src_y < src_h {
                let src_idx = ((src_y * src_w + src_x) * 4) as usize;
                let dst_x = x + offset_x;
                let dst_y = y + offset_y;
                let dst_idx = ((dst_y * target_w + dst_x) * 4) as usize;
                
                if src_idx + 3 < frame.data.len() && dst_idx + 3 < output.len() {
                    output[dst_idx] = frame.data[src_idx];
                    output[dst_idx + 1] = frame.data[src_idx + 1];
                    output[dst_idx + 2] = frame.data[src_idx + 2];
                    output[dst_idx + 3] = frame.data[src_idx + 3];
                }
            }
        }
    }
    
    DecodedFrame {
        frame_number: frame.frame_number,
        timestamp_ms: frame.timestamp_ms,
        data: output,
        width: target_w,
        height: target_h,
    }
}

/// Get the scene mode at a specific timestamp.
fn get_scene_mode_at(project: &VideoProject, timestamp_ms: u64) -> SceneMode {
    // Check scene segments for a matching time range
    for segment in &project.scene.segments {
        if timestamp_ms >= segment.start_ms && timestamp_ms < segment.end_ms {
            return segment.mode;
        }
    }
    // Return default mode if no segment matches
    project.scene.default_mode
}

/// Copy of SceneMode for matching (since we can't import from video_project in match)
impl std::fmt::Display for SceneMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SceneMode::Default => write!(f, "Default"),
            SceneMode::CameraOnly => write!(f, "CameraOnly"),
            SceneMode::ScreenOnly => write!(f, "ScreenOnly"),
        }
    }
}

/// Check if webcam should be visible at a specific timestamp.
fn is_webcam_visible_at(project: &VideoProject, timestamp_ms: u64) -> bool {
    // If webcam is disabled globally, it's not visible
    if !project.webcam.enabled {
        return false;
    }
    
    // If no visibility segments defined, webcam is always visible
    if project.webcam.visibility_segments.is_empty() {
        return true;
    }
    
    // Check visibility segments - find the last segment that starts before this timestamp
    let mut is_visible = true; // Default to visible
    for segment in &project.webcam.visibility_segments {
        if timestamp_ms >= segment.start_ms && timestamp_ms < segment.end_ms {
            is_visible = segment.visible;
        }
    }
    
    is_visible
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::video_recording::video_project::{
        WebcamConfig, WebcamBorder, VideoSources, ZoomConfig, CursorConfig,
        AudioTrackSettings, ExportConfig, SceneConfig, TextConfig, TimelineState,
    };

    /// Create a minimal VideoProject for testing webcam positioning
    fn make_test_project(
        position: WebcamOverlayPosition,
        size: f32,
        custom_x: f32,
        custom_y: f32,
    ) -> VideoProject {
        VideoProject {
            id: "test".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            name: "test".to_string(),
            sources: VideoSources {
                screen_video: "/tmp/test.mp4".to_string(),
                webcam_video: Some("/tmp/webcam.mp4".to_string()),
                cursor_data: None,
                audio_file: None,
                system_audio: None,
                microphone_audio: None,
                background_music: None,
                original_width: 1920,
                original_height: 1080,
                duration_ms: 10000,
                fps: 30,
            },
            timeline: TimelineState::default(),
            zoom: ZoomConfig::default(),
            cursor: CursorConfig::default(),
            webcam: WebcamConfig {
                enabled: true,
                position,
                custom_x,
                custom_y,
                size,
                shape: WebcamOverlayShape::Circle,
                rounding: 100.0,
                corner_style: CornerStyle::Squircle,
                shadow: 62.5,
                shadow_config: ShadowConfig::default(),
                mirror: false,
                border: WebcamBorder {
                    enabled: false,
                    width: 0,
                    color: "#ffffff".to_string(),
                },
                visibility_segments: vec![],
            },
            audio: AudioTrackSettings::default(),
            export: ExportConfig::default(),
            scene: SceneConfig::default(),
            text: TextConfig::default(),
        }
    }

    fn make_test_frame() -> DecodedFrame {
        DecodedFrame {
            frame_number: 0,
            timestamp_ms: 0,
            data: vec![0u8; 1280 * 720 * 4],
            width: 1280,
            height: 720,
        }
    }

    /// Helper to calculate expected position matching WebcamOverlay.tsx exactly
    fn expected_position_px(
        position: WebcamOverlayPosition,
        custom_x: f32,
        custom_y: f32,
        out_w: u32,
        out_h: u32,
        size: f32,
    ) -> (f32, f32) {
        const MARGIN: f32 = 16.0;
        let webcam_size_px = out_w as f32 * size;

        match position {
            WebcamOverlayPosition::TopLeft => (MARGIN, MARGIN),
            WebcamOverlayPosition::TopRight => (out_w as f32 - webcam_size_px - MARGIN, MARGIN),
            WebcamOverlayPosition::BottomLeft => (MARGIN, out_h as f32 - webcam_size_px - MARGIN),
            WebcamOverlayPosition::BottomRight => (
                out_w as f32 - webcam_size_px - MARGIN,
                out_h as f32 - webcam_size_px - MARGIN,
            ),
            WebcamOverlayPosition::Custom => {
                let left = if custom_x <= 0.1 {
                    MARGIN
                } else if custom_x >= 0.9 {
                    out_w as f32 - webcam_size_px - MARGIN
                } else {
                    custom_x * out_w as f32 - webcam_size_px / 2.0
                };
                let top = if custom_y <= 0.1 {
                    MARGIN
                } else if custom_y >= 0.9 {
                    out_h as f32 - webcam_size_px - MARGIN
                } else {
                    custom_y * out_h as f32 - webcam_size_px / 2.0
                };
                (left, top)
            }
        }
    }

    #[test]
    fn test_webcam_position_bottom_right() {
        let project = make_test_project(WebcamOverlayPosition::BottomRight, 0.20, 0.0, 0.0);
        let frame = make_test_frame();
        let (out_w, out_h) = (2262, 1228);

        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);
        let (expected_x, expected_y) = expected_position_px(
            WebcamOverlayPosition::BottomRight, 0.0, 0.0, out_w, out_h, 0.20
        );

        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;

        assert!(
            (actual_x_px - expected_x).abs() < 1.0,
            "BottomRight X mismatch: expected {:.1}, got {:.1} (diff: {:.2})",
            expected_x, actual_x_px, (actual_x_px - expected_x).abs()
        );
        assert!(
            (actual_y_px - expected_y).abs() < 1.0,
            "BottomRight Y mismatch: expected {:.1}, got {:.1} (diff: {:.2})",
            expected_y, actual_y_px, (actual_y_px - expected_y).abs()
        );
    }

    #[test]
    fn test_webcam_position_top_left() {
        let project = make_test_project(WebcamOverlayPosition::TopLeft, 0.20, 0.0, 0.0);
        let frame = make_test_frame();
        let (out_w, out_h) = (1920, 1080);

        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;

        assert!((actual_x_px - 16.0).abs() < 1.0, "TopLeft X should be 16px margin, got {:.1}", actual_x_px);
        assert!((actual_y_px - 16.0).abs() < 1.0, "TopLeft Y should be 16px margin, got {:.1}", actual_y_px);
    }

    #[test]
    fn test_webcam_position_all_corners() {
        let positions = [
            (WebcamOverlayPosition::TopLeft, "TopLeft"),
            (WebcamOverlayPosition::TopRight, "TopRight"),
            (WebcamOverlayPosition::BottomLeft, "BottomLeft"),
            (WebcamOverlayPosition::BottomRight, "BottomRight"),
        ];
        let (out_w, out_h) = (1920, 1080);
        let size = 0.20;

        for (position, name) in positions {
            let project = make_test_project(position, size, 0.0, 0.0);
            let frame = make_test_frame();
            let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

            let (expected_x, expected_y) = expected_position_px(position, 0.0, 0.0, out_w, out_h, size);
            let actual_x_px = overlay.x * out_w as f32;
            let actual_y_px = overlay.y * out_h as f32;

            assert!(
                (actual_x_px - expected_x).abs() < 1.0,
                "{} X mismatch: expected {:.1}, got {:.1}",
                name, expected_x, actual_x_px
            );
            assert!(
                (actual_y_px - expected_y).abs() < 1.0,
                "{} Y mismatch: expected {:.1}, got {:.1}",
                name, expected_y, actual_y_px
            );
        }
    }

    #[test]
    fn test_webcam_custom_position_center() {
        let project = make_test_project(WebcamOverlayPosition::Custom, 0.20, 0.5, 0.5);
        let frame = make_test_frame();
        let (out_w, out_h) = (1920, 1080);

        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);
        let webcam_size_px = out_w as f32 * 0.20;

        // Center position: webcam centered at 50% of screen
        let expected_x = 0.5 * out_w as f32 - webcam_size_px / 2.0;
        let expected_y = 0.5 * out_h as f32 - webcam_size_px / 2.0;

        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;

        assert!(
            (actual_x_px - expected_x).abs() < 1.0,
            "Custom center X mismatch: expected {:.1}, got {:.1}",
            expected_x, actual_x_px
        );
        assert!(
            (actual_y_px - expected_y).abs() < 1.0,
            "Custom center Y mismatch: expected {:.1}, got {:.1}",
            expected_y, actual_y_px
        );
    }

    #[test]
    fn test_webcam_custom_position_edge_snapping() {
        // Test that custom positions near edges (<=0.1 or >=0.9) snap to margin
        let (out_w, out_h) = (1920, 1080);
        let size = 0.20;
        let webcam_size_px = out_w as f32 * size;

        // Test top-left edge snapping (custom_x=0.05, custom_y=0.05)
        let project = make_test_project(WebcamOverlayPosition::Custom, size, 0.05, 0.05);
        let overlay = build_webcam_overlay(&project, make_test_frame(), out_w, out_h);
        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;
        assert!((actual_x_px - 16.0).abs() < 1.0, "Edge snap X should be 16px, got {:.1}", actual_x_px);
        assert!((actual_y_px - 16.0).abs() < 1.0, "Edge snap Y should be 16px, got {:.1}", actual_y_px);

        // Test bottom-right edge snapping (custom_x=0.95, custom_y=0.95)
        let project = make_test_project(WebcamOverlayPosition::Custom, size, 0.95, 0.95);
        let overlay = build_webcam_overlay(&project, make_test_frame(), out_w, out_h);
        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;
        let expected_x = out_w as f32 - webcam_size_px - 16.0;
        let expected_y = out_h as f32 - webcam_size_px - 16.0;
        assert!((actual_x_px - expected_x).abs() < 1.0, "Edge snap X should be {:.1}, got {:.1}", expected_x, actual_x_px);
        assert!((actual_y_px - expected_y).abs() < 1.0, "Edge snap Y should be {:.1}, got {:.1}", expected_y, actual_y_px);
    }

    #[test]
    fn test_webcam_size_consistency() {
        // The webcam overlay size should be stored as a fraction of width
        let project = make_test_project(WebcamOverlayPosition::BottomRight, 0.20, 0.0, 0.0);
        let frame = make_test_frame();
        let (out_w, out_h) = (2262, 1228);

        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

        // Size should match what we passed in
        assert!((overlay.size - 0.20).abs() < 0.001, "Size should be 0.20, got {}", overlay.size);
        
        // Size in pixels should be 20% of width
        let expected_size_px = out_w as f32 * 0.20;
        let actual_size_px = overlay.size * out_w as f32;
        assert!((actual_size_px - expected_size_px).abs() < 1.0, 
            "Pixel size should be {:.1}, got {:.1}", expected_size_px, actual_size_px);
    }

    #[test]
    fn test_webcam_position_various_dimensions() {
        // Test positioning works correctly for various output dimensions
        let test_cases: [(u32, u32, &str); 5] = [
            (1920, 1080, "1080p 16:9"),
            (2560, 1440, "1440p 16:9"),
            (1280, 720, "720p 16:9"),
            (2262, 1228, "Custom aspect"),
            (1080, 1920, "Portrait 9:16"),
        ];

        for (out_w, out_h, desc) in test_cases {
            let project = make_test_project(WebcamOverlayPosition::BottomRight, 0.20, 0.0, 0.0);
            let frame = make_test_frame();
            let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

            let webcam_size_px = out_w as f32 * 0.20;
            let expected_x = out_w as f32 - webcam_size_px - 16.0;
            let expected_y = out_h as f32 - webcam_size_px - 16.0;

            let actual_x_px = overlay.x * out_w as f32;
            let actual_y_px = overlay.y * out_h as f32;

            assert!(
                (actual_x_px - expected_x).abs() < 1.0,
                "{} ({out_w}x{out_h}) X mismatch: expected {:.1}, got {:.1}",
                desc, expected_x, actual_x_px
            );
            assert!(
                (actual_y_px - expected_y).abs() < 1.0,
                "{} ({out_w}x{out_h}) Y mismatch: expected {:.1}, got {:.1}",
                desc, expected_y, actual_y_px
            );
        }
    }

    #[test]
    fn test_webcam_position_different_sizes() {
        // Test different webcam sizes
        let sizes = [0.10, 0.15, 0.20, 0.25, 0.30];
        let (out_w, out_h) = (1920, 1080);

        for size in sizes {
            let project = make_test_project(WebcamOverlayPosition::BottomRight, size, 0.0, 0.0);
            let frame = make_test_frame();
            let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

            let webcam_size_px = out_w as f32 * size;
            let expected_x = out_w as f32 - webcam_size_px - 16.0;
            let expected_y = out_h as f32 - webcam_size_px - 16.0;

            let actual_x_px = overlay.x * out_w as f32;
            let actual_y_px = overlay.y * out_h as f32;

            assert!(
                (actual_x_px - expected_x).abs() < 1.0,
                "Size {:.0}% X mismatch: expected {:.1}, got {:.1}",
                size * 100.0, expected_x, actual_x_px
            );
            assert!(
                (actual_y_px - expected_y).abs() < 1.0,
                "Size {:.0}% Y mismatch: expected {:.1}, got {:.1}",
                size * 100.0, expected_y, actual_y_px
            );
        }
    }

    // ============================================================================
    // GPU PIXEL TESTS - Verify actual rendered output matches expected positions
    // ============================================================================
    // 
    // These tests render frames through the GPU compositor and verify that
    // the webcam overlay appears at the correct pixel coordinates.
    // 
    // Requires GPU - will be skipped in CI without GPU support.
    // 
    // Outputs test images to: dev/test-output/

    /// Save RGBA pixels to a PNG file for visual verification.
    fn save_test_image(pixels: &[u8], width: u32, height: u32, filename: &str) {
        use std::path::Path;
        
        // Create dev/test-output directory
        let output_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev/test-output");
        if let Err(e) = std::fs::create_dir_all(&output_dir) {
            eprintln!("[WARN] Failed to create output dir: {}", e);
            return;
        }
        
        let output_path = output_dir.join(filename);
        
        // Use image crate to save PNG
        match image::RgbaImage::from_raw(width, height, pixels.to_vec()) {
            Some(img) => {
                if let Err(e) = img.save(&output_path) {
                    eprintln!("[WARN] Failed to save image: {}", e);
                } else {
                    eprintln!("[GPU TEST] Saved: {}", output_path.display());
                }
            }
            None => {
                eprintln!("[WARN] Failed to create image from pixels");
            }
        }
    }

    /// Create a solid color frame for testing.
    fn make_solid_frame(width: u32, height: u32, r: u8, g: u8, b: u8) -> DecodedFrame {
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..(width * height) {
            data.extend_from_slice(&[r, g, b, 255]);
        }
        DecodedFrame {
            frame_number: 0,
            timestamp_ms: 0,
            data,
            width,
            height,
        }
    }

    /// Scan rendered pixels to find the bounding box of webcam content.
    /// Looks for pixels that are significantly different from the background.
    /// Returns (min_x, min_y, max_x, max_y) in pixels.
    fn find_webcam_bounds(
        pixels: &[u8],
        width: u32,
        height: u32,
        bg_r: u8,
        bg_g: u8,
        bg_b: u8,
    ) -> Option<(u32, u32, u32, u32)> {
        let mut min_x = width;
        let mut min_y = height;
        let mut max_x = 0u32;
        let mut max_y = 0u32;
        let mut found = false;

        // Threshold for detecting non-background pixels
        let threshold = 30;

        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                let r = pixels[idx];
                let g = pixels[idx + 1];
                let b = pixels[idx + 2];

                // Check if pixel is significantly different from background
                let dr = (r as i32 - bg_r as i32).abs();
                let dg = (g as i32 - bg_g as i32).abs();
                let db = (b as i32 - bg_b as i32).abs();

                if dr > threshold || dg > threshold || db > threshold {
                    found = true;
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                }
            }
        }

        if found {
            Some((min_x, min_y, max_x, max_y))
        } else {
            None
        }
    }

    /// GPU pixel test: Render a frame with webcam overlay and verify position.
    /// This test actually renders through wgpu and reads back pixels.
    #[test]
    fn test_gpu_webcam_pixel_position_bottom_right() {
        // Skip if no GPU available (CI environments)
        let renderer = match pollster::block_on(super::super::renderer::Renderer::new()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[SKIP] GPU not available: {}", e);
                return;
            }
        };

        let compositor = super::super::compositor::Compositor::new(&renderer);

        // Test parameters
        let out_w = 800u32;
        let out_h = 600u32;
        let webcam_size = 0.20f32; // 20% of width = 160px
        let webcam_size_px = out_w as f32 * webcam_size;

        // Create solid blue background frame (screen)
        let screen_frame = make_solid_frame(out_w, out_h, 0, 0, 128); // Dark blue

        // Create solid red webcam frame
        let webcam_frame = make_solid_frame(160, 160, 255, 0, 0); // Bright red

        // Build webcam overlay for BottomRight position
        let project = make_test_project(WebcamOverlayPosition::BottomRight, webcam_size, 0.0, 0.0);
        let overlay = build_webcam_overlay(&project, webcam_frame, out_w, out_h);

        // Create render options
        let render_options = super::super::types::RenderOptions {
            output_width: out_w,
            output_height: out_h,
            zoom: super::super::types::ZoomState::identity(),
            webcam: Some(overlay),
            cursor: None,
            background: Default::default(),
        };

        // Render frame through GPU
        let output_texture = compositor.composite(&renderer, &screen_frame, &render_options, 0.0);

        // Read back pixels
        let pixels = pollster::block_on(renderer.read_texture(&output_texture, out_w, out_h));

        // Save to dev folder for visual verification
        save_test_image(&pixels, out_w, out_h, "webcam_bottom_right.png");

        // Find webcam bounds by detecting red pixels (different from blue background)
        let bounds = find_webcam_bounds(&pixels, out_w, out_h, 0, 0, 128);

        assert!(bounds.is_some(), "Webcam should be visible in rendered output");
        let (min_x, min_y, max_x, max_y) = bounds.unwrap();

        // Calculate expected position (BottomRight with 16px margin)
        let expected_left = out_w as f32 - webcam_size_px - 16.0;
        let expected_top = out_h as f32 - webcam_size_px - 16.0;
        let expected_right = out_w as f32 - 16.0;
        let expected_bottom = out_h as f32 - 16.0;

        // Allow some tolerance for anti-aliasing and circle shape
        let tolerance = 5.0;

        eprintln!("[GPU TEST] Webcam bounds: ({}, {}) - ({}, {})", min_x, min_y, max_x, max_y);
        eprintln!("[GPU TEST] Expected bounds: ({:.0}, {:.0}) - ({:.0}, {:.0})", 
            expected_left, expected_top, expected_right, expected_bottom);

        // Verify left edge (min_x should be close to expected_left)
        assert!(
            (min_x as f32 - expected_left).abs() < tolerance,
            "Left edge mismatch: expected {:.0}, got {} (diff: {:.1})",
            expected_left, min_x, (min_x as f32 - expected_left).abs()
        );

        // Verify top edge (min_y should be close to expected_top)
        assert!(
            (min_y as f32 - expected_top).abs() < tolerance,
            "Top edge mismatch: expected {:.0}, got {} (diff: {:.1})",
            expected_top, min_y, (min_y as f32 - expected_top).abs()
        );

        // Verify right edge (max_x should be close to expected_right)
        assert!(
            (max_x as f32 - expected_right).abs() < tolerance,
            "Right edge mismatch: expected {:.0}, got {} (diff: {:.1})",
            expected_right, max_x, (max_x as f32 - expected_right).abs()
        );

        // Verify bottom edge (max_y should be close to expected_bottom)
        assert!(
            (max_y as f32 - expected_bottom).abs() < tolerance,
            "Bottom edge mismatch: expected {:.0}, got {} (diff: {:.1})",
            expected_bottom, max_y, (max_y as f32 - expected_bottom).abs()
        );

        eprintln!("[GPU TEST] PASSED: Webcam position verified at pixel level!");
    }

    /// GPU pixel test: Verify webcam is circular (not oval).
    /// Checks that width and height of detected bounds are approximately equal.
    #[test]
    fn test_gpu_webcam_circle_not_oval() {
        // Skip if no GPU available
        let renderer = match pollster::block_on(super::super::renderer::Renderer::new()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[SKIP] GPU not available: {}", e);
                return;
            }
        };

        let compositor = super::super::compositor::Compositor::new(&renderer);

        // Non-square output to test aspect ratio handling
        let out_w = 1920u32;
        let out_h = 1080u32; // 16:9 aspect ratio
        let webcam_size = 0.15f32;

        let screen_frame = make_solid_frame(out_w, out_h, 0, 0, 64);
        let webcam_frame = make_solid_frame(200, 200, 200, 50, 50); // Reddish

        let project = make_test_project(WebcamOverlayPosition::BottomRight, webcam_size, 0.0, 0.0);
        let overlay = build_webcam_overlay(&project, webcam_frame, out_w, out_h);

        let render_options = super::super::types::RenderOptions {
            output_width: out_w,
            output_height: out_h,
            zoom: super::super::types::ZoomState::identity(),
            webcam: Some(overlay),
            cursor: None,
            background: Default::default(),
        };

        let output_texture = compositor.composite(&renderer, &screen_frame, &render_options, 0.0);
        let pixels = pollster::block_on(renderer.read_texture(&output_texture, out_w, out_h));

        // Save to dev folder for visual verification
        save_test_image(&pixels, out_w, out_h, "webcam_circle_16x9.png");

        let bounds = find_webcam_bounds(&pixels, out_w, out_h, 0, 0, 64);
        assert!(bounds.is_some(), "Webcam should be visible");

        let (min_x, min_y, max_x, max_y) = bounds.unwrap();
        let detected_width = max_x - min_x;
        let detected_height = max_y - min_y;

        eprintln!("[GPU TEST] Detected webcam: {}x{} pixels", detected_width, detected_height);

        // For a circle, width and height should be approximately equal
        let aspect_ratio = detected_width as f32 / detected_height as f32;
        
        // Allow 5% tolerance (0.95 - 1.05)
        assert!(
            aspect_ratio > 0.95 && aspect_ratio < 1.05,
            "Webcam should be circular (square bounds), but aspect ratio is {:.3}. Size: {}x{}",
            aspect_ratio, detected_width, detected_height
        );

        eprintln!("[GPU TEST] PASSED: Webcam is circular (aspect ratio: {:.3})!", aspect_ratio);
    }

    /// GPU pixel test: Verify all corner positions.
    #[test]
    fn test_gpu_webcam_all_corners() {
        // Skip if no GPU available
        let renderer = match pollster::block_on(super::super::renderer::Renderer::new()) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[SKIP] GPU not available: {}", e);
                return;
            }
        };

        let compositor = super::super::compositor::Compositor::new(&renderer);

        let out_w = 640u32;
        let out_h = 480u32;
        let webcam_size = 0.20f32;
        let webcam_size_px = out_w as f32 * webcam_size;
        const MARGIN: f32 = 16.0;
        let tolerance = 5.0;

        let positions = [
            (WebcamOverlayPosition::TopLeft, MARGIN, MARGIN, "TopLeft"),
            (WebcamOverlayPosition::TopRight, out_w as f32 - webcam_size_px - MARGIN, MARGIN, "TopRight"),
            (WebcamOverlayPosition::BottomLeft, MARGIN, out_h as f32 - webcam_size_px - MARGIN, "BottomLeft"),
            (WebcamOverlayPosition::BottomRight, out_w as f32 - webcam_size_px - MARGIN, out_h as f32 - webcam_size_px - MARGIN, "BottomRight"),
        ];

        for (position, expected_x, expected_y, name) in positions {
            let screen_frame = make_solid_frame(out_w, out_h, 30, 30, 30);
            let webcam_frame = make_solid_frame(128, 128, 255, 100, 100);

            let project = make_test_project(position, webcam_size, 0.0, 0.0);
            let overlay = build_webcam_overlay(&project, webcam_frame, out_w, out_h);

            let render_options = super::super::types::RenderOptions {
                output_width: out_w,
                output_height: out_h,
                zoom: super::super::types::ZoomState::identity(),
                webcam: Some(overlay),
                cursor: None,
                background: Default::default(),
            };

            let output_texture = compositor.composite(&renderer, &screen_frame, &render_options, 0.0);
            let pixels = pollster::block_on(renderer.read_texture(&output_texture, out_w, out_h));

            // Save to dev folder for visual verification
            save_test_image(&pixels, out_w, out_h, &format!("webcam_{}.png", name.to_lowercase()));

            let bounds = find_webcam_bounds(&pixels, out_w, out_h, 30, 30, 30);
            assert!(bounds.is_some(), "{}: Webcam should be visible", name);

            let (min_x, min_y, _max_x, _max_y) = bounds.unwrap();

            eprintln!("[GPU TEST] {}: found at ({}, {}), expected ({:.0}, {:.0})", 
                name, min_x, min_y, expected_x, expected_y);

            assert!(
                (min_x as f32 - expected_x).abs() < tolerance,
                "{} X mismatch: expected {:.0}, got {} (diff: {:.1})",
                name, expected_x, min_x, (min_x as f32 - expected_x).abs()
            );

            assert!(
                (min_y as f32 - expected_y).abs() < tolerance,
                "{} Y mismatch: expected {:.0}, got {} (diff: {:.1})",
                name, expected_y, min_y, (min_y as f32 - expected_y).abs()
            );
        }

        eprintln!("[GPU TEST] PASSED: All corner positions verified!");
    }
}

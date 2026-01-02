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
    VideoProject, ExportFormat, WebcamOverlayPosition, WebcamOverlayShape,
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
        WebcamOverlayShape::RoundedRectangle => WebcamShape::RoundedRect { radius: 16 },
    };

    // Parse border color
    let border_color = parse_color(&project.webcam.border.color);

    WebcamOverlay {
        frame,
        x: x_norm,
        y: y_norm,
        size: project.webcam.size as f32,
        shape,
        border_width: if project.webcam.border.enabled { project.webcam.border.width as f32 } else { 0.0 },
        border_color,
        mirror: project.webcam.mirror,
    }
}

/// Parse CSS color to RGBA array.
fn parse_color(color: &str) -> [f32; 4] {
    if color.starts_with('#') && color.len() == 7 {
        let r = u8::from_str_radix(&color[1..3], 16).unwrap_or(255) as f32 / 255.0;
        let g = u8::from_str_radix(&color[3..5], 16).unwrap_or(255) as f32 / 255.0;
        let b = u8::from_str_radix(&color[5..7], 16).unwrap_or(255) as f32 / 255.0;
        [r, g, b, 1.0]
    } else {
        [1.0, 1.0, 1.0, 1.0] // Default white
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

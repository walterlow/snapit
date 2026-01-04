//! GPU-based video export pipeline.
//!
//! Like Cap, we:
//! 1. Decode frames with FFmpeg (streaming - ONE process, not per-frame)
//! 2. Render on GPU with zoom/webcam effects
//! 3. Pipe rendered RGBA frames to FFmpeg for encoding only

mod ffmpeg;
mod frame_ops;
mod webcam;

#[cfg(test)]
mod tests;

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::compositor::Compositor;
use super::cursor::{composite_cursor, CursorInterpolator};
use super::renderer::Renderer;
use super::scene::SceneInterpolator;
use super::stream_decoder::StreamDecoder;
use super::types::RenderOptions;
use super::zoom::ZoomInterpolator;
use crate::commands::video_recording::cursor::events::load_cursor_recording;
use crate::commands::video_recording::video_export::{ExportResult, ExportStage};
use crate::commands::video_recording::video_project::{
    apply_auto_zoom_to_project, AutoZoomConfig, CursorType, SceneMode, VideoProject, ZoomMode,
};

// Re-export submodule functions used externally
pub use ffmpeg::emit_progress;
pub use frame_ops::draw_cursor_circle;
pub use webcam::build_webcam_overlay;

use ffmpeg::start_ffmpeg_encoder;
use frame_ops::{blend_frames_alpha, scale_frame_to_fill};
use webcam::is_webcam_visible_at;

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
        out_w,
        out_h,
        fps,
        total_frames,
        has_webcam
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
            seg.start_ms,
            seg.end_ms,
            seg.mode
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
                log::info!(
                    "[EXPORT] Generated {} auto zoom regions",
                    updated.zoom.regions.len()
                );
                updated
            },
            Err(e) => {
                log::warn!("[EXPORT] Failed to generate auto zoom: {}", e);
                project
            },
        }
    } else {
        project
    };

    // Create zoom interpolator
    let zoom_interpolator = ZoomInterpolator::new(&project.zoom);

    // Create scene interpolator for smooth scene transitions
    let scene_interpolator = SceneInterpolator::new(project.scene.segments.clone());

    // Load cursor recording and create interpolator if cursor is visible
    let cursor_interpolator = if project.cursor.visible {
        if let Some(ref cursor_data_path) = project.sources.cursor_data {
            let cursor_path = std::path::Path::new(cursor_data_path);
            if cursor_path.exists() {
                match load_cursor_recording(cursor_path) {
                    Ok(recording) => {
                        log::info!(
                            "[EXPORT] Loaded cursor recording with {} events, {} images",
                            recording.events.len(),
                            recording.cursor_images.len()
                        );
                        Some(CursorInterpolator::new(&recording))
                    },
                    Err(e) => {
                        log::warn!("[EXPORT] Failed to load cursor recording: {}", e);
                        None
                    },
                }
            } else {
                log::debug!("[EXPORT] Cursor data file not found: {}", cursor_data_path);
                None
            }
        } else {
            None
        }
    } else {
        log::debug!("[EXPORT] Cursor rendering disabled in project settings");
        None
    };

    emit_progress(&app, 0.08, ExportStage::Encoding, "Rendering frames...");

    // Render each frame sequentially from streaming decoders
    let mut frame_idx = 0u32;
    let mut last_webcam_frame: Option<super::types::DecodedFrame> = None; // Cache last webcam frame

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
        let interpolated_scene = scene_interpolator.get_scene_at(relative_time_ms);
        let webcam_visible = is_webcam_visible_at(&project, relative_time_ms);

        // Log first few frames for debugging
        if frame_idx < 3 || (relative_time_ms >= 6000 && relative_time_ms <= 6200) {
            log::debug!(
                "[EXPORT] Frame {}: relative={}ms, scene_mode={:?}, transition_progress={:.2}",
                frame_idx,
                relative_time_ms,
                interpolated_scene.scene_mode,
                interpolated_scene.transition_progress
            );
        }

        // Read webcam frame if we have a decoder (always consume to stay in sync)
        let current_webcam_frame = if let Some(ref mut decoder) = webcam_decoder {
            match decoder.next_frame().await {
                Ok(Some(webcam_frame)) => {
                    last_webcam_frame = Some(webcam_frame.clone());
                    Some(webcam_frame)
                },
                _ => last_webcam_frame.clone(),
            }
        } else {
            None
        };

        // Determine what to render based on interpolated scene values
        // This handles smooth transitions between scene modes
        let camera_only_opacity = interpolated_scene.camera_only_transition_opacity();
        let regular_camera_opacity = interpolated_scene.regular_camera_transition_opacity();
        let is_in_camera_only_transition = interpolated_scene.is_transitioning_camera_only();

        // Log transition state for debugging
        if is_in_camera_only_transition && frame_idx % 10 == 0 {
            log::debug!(
                "[EXPORT] Frame {}: cameraOnly transition - camera_only_opacity={:.2}, regular_camera_opacity={:.2}, screen_blur={:.2}",
                frame_idx, camera_only_opacity, regular_camera_opacity, interpolated_scene.screen_blur
            );
        }

        // Build the frame to render with proper blending
        let (frame_to_render, webcam_overlay) = if camera_only_opacity > 0.99 {
            // Fully in cameraOnly mode - just show fullscreen webcam
            if let Some(ref webcam_frame) = current_webcam_frame {
                let scaled_frame = scale_frame_to_fill(webcam_frame, out_w, out_h);
                (scaled_frame, None)
            } else {
                (screen_frame.clone(), None)
            }
        } else if camera_only_opacity > 0.01 {
            // In cameraOnly transition - blend screen and fullscreen webcam
            if let Some(ref webcam_frame) = current_webcam_frame {
                // Start with screen frame (apply blur if needed)
                let mut blended_frame = if interpolated_scene.screen_blur > 0.01 {
                    // Note: GPU blur would be better, but for now we skip CPU blur
                    // The screen will still fade out via opacity blending
                    screen_frame.clone()
                } else {
                    screen_frame.clone()
                };

                // Scale webcam to fill output
                let fullscreen_webcam = scale_frame_to_fill(webcam_frame, out_w, out_h);

                // Blend fullscreen webcam over screen with camera_only_opacity
                blend_frames_alpha(
                    &mut blended_frame,
                    &fullscreen_webcam,
                    camera_only_opacity as f32,
                );

                // Regular webcam overlay during transition (fades at 1.5x speed)
                let overlay = if regular_camera_opacity > 0.01 && webcam_visible {
                    let mut overlay =
                        build_webcam_overlay(&project, webcam_frame.clone(), out_w, out_h);
                    // Apply the transition opacity to the overlay
                    overlay.shadow_opacity *= regular_camera_opacity as f32;
                    Some(overlay)
                } else {
                    None
                };

                (blended_frame, overlay)
            } else {
                // No webcam available
                (screen_frame.clone(), None)
            }
        } else {
            // Not in cameraOnly transition - normal rendering
            match interpolated_scene.scene_mode {
                SceneMode::ScreenOnly => {
                    // Screen only - no webcam overlay
                    (screen_frame.clone(), None)
                },
                _ => {
                    // Default mode - screen with webcam overlay (if visible)
                    let overlay = if webcam_visible && regular_camera_opacity > 0.01 {
                        current_webcam_frame.as_ref().map(|frame| {
                            build_webcam_overlay(&project, frame.clone(), out_w, out_h)
                        })
                    } else {
                        None
                    };
                    (screen_frame.clone(), overlay)
                },
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
        let mut rgba_data = renderer.read_texture(&output_texture, out_w, out_h).await;

        // Composite cursor onto frame (CPU-based) if cursor is visible and not in cameraOnly mode
        if let Some(ref cursor_interp) = cursor_interpolator {
            // Only show cursor when screen is visible (not in cameraOnly mode)
            if camera_only_opacity < 0.99 {
                let cursor = cursor_interp.get_cursor_at(relative_time_ms);

                // Get cursor image based on cursor type
                if project.cursor.cursor_type == CursorType::Circle {
                    // Draw circle indicator instead of actual cursor
                    draw_cursor_circle(
                        &mut rgba_data,
                        out_w,
                        out_h,
                        cursor.x,
                        cursor.y,
                        project.cursor.scale,
                    );
                } else if let Some(ref cursor_id) = cursor.cursor_id {
                    // Draw actual cursor image
                    if let Some(cursor_image) = cursor_interp.get_cursor_image(cursor_id) {
                        composite_cursor(
                            &mut rgba_data,
                            out_w,
                            out_h,
                            &cursor,
                            cursor_image,
                            project.cursor.scale,
                        );
                    }
                }
            }
        }

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
    let status = ffmpeg
        .wait()
        .map_err(|e| format!("FFmpeg wait failed: {}", e))?;
    if !status.success() {
        return Err(format!(
            "FFmpeg encoding failed with status: {:?}",
            status.code()
        ));
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

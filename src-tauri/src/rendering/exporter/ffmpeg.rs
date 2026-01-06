//! FFmpeg encoder setup and helpers.

use std::path::Path;
use std::process::{Child, Stdio};

use tauri::{AppHandle, Emitter};

use crate::commands::video_recording::video_export::{ExportProgress, ExportStage};
use crate::commands::video_recording::video_project::{ExportFormat, VideoProject};

/// Start FFmpeg process for encoding raw RGBA input.
pub fn start_ffmpeg_encoder(
    project: &VideoProject,
    output_path: &Path,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<Child, String> {
    let ffmpeg_path = crate::commands::storage::find_ffmpeg().ok_or("FFmpeg not found")?;

    let mut args = vec![
        "-y".to_string(),
        // Raw RGBA input from stdin
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgba".to_string(),
        "-s".to_string(),
        format!("{}x{}", width, height),
        "-r".to_string(),
        fps.to_string(),
        "-i".to_string(),
        "-".to_string(),
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
                "-c:v".to_string(),
                "libx264".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-preset".to_string(),
                "fast".to_string(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
            if has_audio(project) {
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "192k".to_string(),
                    "-shortest".to_string(),
                ]);
            }
        },
        ExportFormat::Webm => {
            let crf = quality_to_crf(project.export.quality);
            args.extend([
                "-c:v".to_string(),
                "libvpx-vp9".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-b:v".to_string(),
                "0".to_string(),
                "-deadline".to_string(),
                "realtime".to_string(),
                "-cpu-used".to_string(),
                "4".to_string(),
            ]);
            if has_audio(project) {
                args.extend([
                    "-c:a".to_string(),
                    "libopus".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                ]);
            }
        },
        ExportFormat::Gif => {
            args.extend([
                "-vf".to_string(),
                format!(
                    "fps={},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                    fps.min(15)
                ),
            ]);
        },
    }

    args.push(output_path.to_string_lossy().to_string());

    log::info!("[EXPORT] FFmpeg encoder: ffmpeg {}", args.join(" "));

    crate::commands::storage::ffmpeg::create_hidden_command(&ffmpeg_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))
}

/// Check if project has audio to encode.
pub fn has_audio(project: &VideoProject) -> bool {
    (project.sources.system_audio.is_some() && !project.audio.system_muted)
        || (project.sources.microphone_audio.is_some() && !project.audio.microphone_muted)
}

/// Convert quality percentage to CRF value.
pub fn quality_to_crf(quality: u32) -> u8 {
    (35 - ((quality as f32 / 100.0) * 20.0) as u8).clamp(15, 35)
}

/// Emit export progress event to frontend.
pub fn emit_progress(app: &AppHandle, progress: f32, stage: ExportStage, message: &str) {
    let _ = app.emit(
        "export-progress",
        ExportProgress {
            progress,
            stage,
            message: message.to_string(),
        },
    );
}

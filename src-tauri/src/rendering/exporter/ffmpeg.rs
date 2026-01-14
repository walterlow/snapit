//! FFmpeg encoder setup and helpers.

use std::path::Path;
use std::process::{Child, Stdio};

use tauri::{AppHandle, Emitter};

use crate::commands::video_recording::video_export::{ExportProgress, ExportStage};
use crate::commands::video_recording::video_project::{ExportFormat, VideoProject};

use super::encoder_selection::{select_encoder, EncoderType};

/// Audio input info for building ffmpeg filter.
struct AudioInput {
    input_index: usize,
    volume: f32,
}

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

    // Track audio inputs for filter graph
    // Input 0 is always video (stdin)
    let mut audio_inputs: Vec<AudioInput> = Vec::new();
    let mut next_input_index = 1;

    // Add system audio if available and not muted
    if let Some(ref audio_path) = project.sources.system_audio {
        if Path::new(audio_path).exists() && !project.audio.system_muted {
            args.extend(["-i".to_string(), audio_path.clone()]);
            audio_inputs.push(AudioInput {
                input_index: next_input_index,
                volume: project.audio.system_volume,
            });
            next_input_index += 1;
        }
    }

    // Add microphone audio if available and not muted
    if let Some(ref mic_path) = project.sources.microphone_audio {
        if Path::new(mic_path).exists() && !project.audio.microphone_muted {
            args.extend(["-i".to_string(), mic_path.clone()]);
            audio_inputs.push(AudioInput {
                input_index: next_input_index,
                volume: project.audio.microphone_volume,
            });
            // next_input_index += 1; // Uncomment when adding more audio sources
        }
    }

    // Build audio filter graph if we have audio inputs
    let audio_filter = build_audio_filter(&audio_inputs);

    // Output encoding based on format
    match project.export.format {
        ExportFormat::Mp4 => {
            // Select encoder (NVENC if available and preferred, otherwise x264)
            let prefer_hardware = project.export.prefer_hardware_encoding.unwrap_or(false);
            let encoder_config =
                select_encoder(&ffmpeg_path, project.export.quality, prefer_hardware);

            args.extend([
                "-c:v".to_string(),
                encoder_config.codec.clone(),
                encoder_config.quality_param.clone(),
                encoder_config.quality_value.to_string(),
                "-preset".to_string(),
                encoder_config.preset.clone(),
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
                // Keyframe every 1 second for precise seeking
                "-g".to_string(),
                fps.to_string(),
                // Move moov atom to start for fast playback start
                "-movflags".to_string(),
                "+faststart".to_string(),
            ]);

            // Encoder-specific optimizations
            if encoder_config.encoder_type == EncoderType::Nvenc {
                // NVENC: add b-frames and lookahead for better quality
                args.extend([
                    "-bf".to_string(),
                    "2".to_string(),
                    "-rc-lookahead".to_string(),
                    "20".to_string(),
                ]);
            } else {
                // x264: enable multi-threaded encoding for better CPU utilization
                args.extend([
                    "-threads".to_string(),
                    "0".to_string(), // Auto-detect CPU cores
                    "-x264-params".to_string(),
                    "threads=auto:lookahead_threads=auto".to_string(),
                ]);
            }

            log::info!(
                "[EXPORT] Encoder: {} (preset: {}, {}: {})",
                encoder_config.codec,
                encoder_config.preset,
                encoder_config.quality_param,
                encoder_config.quality_value
            );

            if !audio_inputs.is_empty() {
                if let Some(ref filter) = audio_filter {
                    args.extend(["-filter_complex".to_string(), filter.clone()]);
                    args.extend(["-map".to_string(), "0:v".to_string()]);
                    args.extend(["-map".to_string(), "[aout]".to_string()]);
                }
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
                // Keyframe every 1 second for precise seeking
                "-g".to_string(),
                fps.to_string(),
            ]);
            if !audio_inputs.is_empty() {
                if let Some(ref filter) = audio_filter {
                    args.extend(["-filter_complex".to_string(), filter.clone()]);
                    args.extend(["-map".to_string(), "0:v".to_string()]);
                    args.extend(["-map".to_string(), "[aout]".to_string()]);
                }
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

/// Build audio filter graph for mixing multiple audio tracks with volume control.
/// Returns None if no audio inputs, otherwise returns the filter string.
fn build_audio_filter(audio_inputs: &[AudioInput]) -> Option<String> {
    if audio_inputs.is_empty() {
        return None;
    }

    if audio_inputs.len() == 1 {
        // Single audio track - just apply volume
        let input = &audio_inputs[0];
        Some(format!(
            "[{}:a]volume={:.2}[aout]",
            input.input_index, input.volume
        ))
    } else {
        // Multiple audio tracks - apply volume to each, then mix
        let mut filter_parts: Vec<String> = Vec::new();
        let mut mix_inputs: Vec<String> = Vec::new();

        for (i, input) in audio_inputs.iter().enumerate() {
            let label = format!("a{}", i);
            filter_parts.push(format!(
                "[{}:a]volume={:.2}[{}]",
                input.input_index, input.volume, label
            ));
            mix_inputs.push(format!("[{}]", label));
        }

        // Mix all audio streams together
        filter_parts.push(format!(
            "{}amix=inputs={}:duration=longest[aout]",
            mix_inputs.join(""),
            audio_inputs.len()
        ));

        Some(filter_parts.join(";"))
    }
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

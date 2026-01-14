//! Encoder selection and hardware acceleration detection.

use std::path::PathBuf;
use std::process::Stdio;

/// Encoder type for video export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderType {
    /// NVIDIA NVENC hardware encoder (h264_nvenc).
    Nvenc,
    /// Software x264 encoder (libx264).
    X264,
}

/// Encoder configuration with codec-specific parameters.
#[derive(Debug, Clone)]
pub struct EncoderConfig {
    pub encoder_type: EncoderType,
    pub codec: String,
    pub preset: String,
    pub quality_param: String,
    pub quality_value: u8,
}

/// NVENC preset mapping (p1=fastest, p7=highest quality).
/// p4 is balanced speed/quality for most use cases.
fn nvenc_preset_from_quality(quality: u32) -> &'static str {
    match quality {
        0..=25 => "p1",   // Fastest, lowest quality
        26..=50 => "p3",  // Fast
        51..=75 => "p4",  // Balanced (default)
        76..=90 => "p5",  // Quality
        91..=100 => "p7", // Maximum quality
        _ => "p4",
    }
}

/// Convert quality percentage to NVENC CQ value.
/// CQ range: 0 (highest quality) to 51 (lowest quality).
/// Quality 100% -> CQ ~15, Quality 50% -> CQ ~25, Quality 0% -> CQ ~40.
fn quality_to_cq(quality: u32) -> u8 {
    let cq = 40.0 - (quality as f32 / 100.0) * 25.0;
    (cq as u8).clamp(15, 40)
}

/// Check if NVENC is available by testing FFmpeg encoder.
pub fn is_nvenc_available(ffmpeg_path: &PathBuf) -> bool {
    // Run a quick encode test to verify NVENC works
    // Note: NVENC has minimum frame size requirements (~145x49), so we use 256x256
    let result = crate::commands::storage::ffmpeg::create_hidden_command(ffmpeg_path)
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=0.01:size=256x256:rate=1",
            "-c:v",
            "h264_nvenc",
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    match result {
        Ok(status) => {
            let available = status.success();
            log::info!(
                "[ENCODER] NVENC availability check: {}",
                if available {
                    "available"
                } else {
                    "not available"
                }
            );
            available
        },
        Err(e) => {
            log::debug!("[ENCODER] NVENC check failed: {}", e);
            false
        },
    }
}

/// Select the best available encoder based on hardware and preferences.
pub fn select_encoder(ffmpeg_path: &PathBuf, quality: u32, prefer_hardware: bool) -> EncoderConfig {
    let use_nvenc = prefer_hardware && is_nvenc_available(ffmpeg_path);

    if use_nvenc {
        log::info!("[ENCODER] Using NVENC hardware encoder");
        EncoderConfig {
            encoder_type: EncoderType::Nvenc,
            codec: "h264_nvenc".to_string(),
            preset: nvenc_preset_from_quality(quality).to_string(),
            quality_param: "-cq".to_string(),
            quality_value: quality_to_cq(quality),
        }
    } else {
        log::info!("[ENCODER] Using x264 software encoder");
        EncoderConfig {
            encoder_type: EncoderType::X264,
            codec: "libx264".to_string(),
            // "superfast" is ~2x faster than "fast" with minimal quality loss
            // For balanced quality/speed when hardware encoding unavailable
            preset: "superfast".to_string(),
            quality_param: "-crf".to_string(),
            quality_value: super::ffmpeg::quality_to_crf(quality),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quality_to_cq_range() {
        assert_eq!(quality_to_cq(100), 15); // Best quality
        assert_eq!(quality_to_cq(0), 40); // Lowest quality
        let mid = quality_to_cq(50);
        assert!(mid > 15 && mid < 40);
    }

    #[test]
    fn test_nvenc_preset_selection() {
        assert_eq!(nvenc_preset_from_quality(100), "p7");
        assert_eq!(nvenc_preset_from_quality(50), "p4");
        assert_eq!(nvenc_preset_from_quality(0), "p1");
    }
}

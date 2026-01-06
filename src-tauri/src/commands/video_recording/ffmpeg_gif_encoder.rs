//! FFmpeg-based GIF encoding with direct piping.
//!
//! Optimized for screen recording with global palette and diff_mode.
//! Uses rectangle diff to only encode changed regions (huge size savings).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::gif_encoder::GifFrame;

/// Quality preset for GIF encoding.
///
/// All presets use:
/// - `stats_mode=full`: Global palette optimized across all frames
/// - `diff_mode=rectangle`: Only encodes changed rectangular regions
/// - `+transdiff`: Transparency for unchanged pixels
///
/// These are ideal for screen recording where colors are consistent
/// and most of the frame stays static between captures.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum GifQualityPreset {
    /// Smallest file size: 128 colors, no dithering.
    /// Best for: quick previews, slow connections, simple UI content.
    Fast,
    /// Good balance: 256 colors, bayer dithering.
    /// Best for: most screen recordings, default choice.
    #[default]
    Balanced,
    /// Best quality: 256 colors, floyd-steinberg dithering.
    /// Best for: detailed content, gradients, final deliverables.
    High,
}

impl GifQualityPreset {
    /// Get the FFmpeg filter string for this preset.
    fn to_filter(&self) -> &'static str {
        // All presets use:
        // - stats_mode=full: global palette from all frames
        // - diff_mode=rectangle: only encode changed regions
        match self {
            // Fast: 128 colors, no dithering (smallest files)
            GifQualityPreset::Fast =>
                "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
            // Balanced: 256 colors, bayer dithering (good quality/size)
            GifQualityPreset::Balanced =>
                "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
            // High: 256 colors, floyd_steinberg (best quality)
            GifQualityPreset::High =>
                "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=floyd_steinberg:diff_mode=rectangle",
        }
    }
}

/// FFmpeg-based GIF encoder with direct piping.
pub struct FfmpegGifEncoder {
    ffmpeg_path: PathBuf,
    width: u32,
    height: u32,
    fps: f64,
    preset: GifQualityPreset,
}

impl FfmpegGifEncoder {
    /// Create a new FFmpeg GIF encoder.
    pub fn new(
        width: u32,
        height: u32,
        fps: f64,
        preset: GifQualityPreset,
    ) -> Result<Self, String> {
        let ffmpeg_path = crate::commands::storage::find_ffmpeg()
            .ok_or_else(|| "FFmpeg not found. Ensure FFmpeg is installed.".to_string())?;

        Ok(Self {
            ffmpeg_path,
            width,
            height,
            fps,
            preset,
        })
    }

    /// Encode frames to a GIF file with progress callback.
    pub fn encode<F>(
        &self,
        frames: &[GifFrame],
        output_path: &Path,
        progress_callback: F,
    ) -> Result<u64, String>
    where
        F: Fn(f32) + Send + Sync,
    {
        if frames.is_empty() {
            return Err("No frames to encode".to_string());
        }

        // Validate frame data
        let expected_frame_size = (self.width * self.height * 4) as usize;
        let valid_frames: Vec<_> = frames
            .iter()
            .filter(|f| f.rgba_data.len() == expected_frame_size)
            .collect();

        if valid_frames.is_empty() {
            if let Some(first) = frames.first() {
                return Err(format!(
                    "No valid frames to encode. First frame has {} bytes, expected {} ({}x{}x4)",
                    first.rgba_data.len(),
                    expected_frame_size,
                    self.width,
                    self.height
                ));
            }
            return Err("No valid frames to encode".to_string());
        }

        // Build filter chain based on preset
        let filter = self.preset.to_filter();

        // Ensure even dimensions for filter compatibility
        let width = if self.width % 2 != 0 {
            self.width - 1
        } else {
            self.width
        };
        let height = if self.height % 2 != 0 {
            self.height - 1
        } else {
            self.height
        };
        let needs_crop = width != self.width || height != self.height;

        // Build filter chain - prepend crop if dimensions need adjustment
        let full_filter = if needs_crop {
            format!("crop={}:{}:0:0,{}", width, height, filter)
        } else {
            filter.to_string()
        };

        log::debug!(
            "[GIF] Encoding {} frames ({}x{} @ {:.1} fps) to {}",
            valid_frames.len(),
            self.width,
            self.height,
            self.fps,
            output_path.display()
        );

        // Direct pipe: rawvideo -> palettegen -> paletteuse -> GIF
        // Using BGRA input to avoid color conversion overhead in capture loop
        // gifflags +transdiff: use transparency for unchanged pixels (major size reduction)
        let mut child = crate::commands::storage::ffmpeg::create_hidden_command(&self.ffmpeg_path)
            .args([
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "-s",
                &format!("{}x{}", self.width, self.height),
                "-r",
                &format!("{}", self.fps),
                "-i",
                "pipe:0",
                "-filter_complex",
                &full_filter,
                "-loop",
                "0",
            ])
            .arg(output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open FFmpeg stdin".to_string())?;

        // Pipe frames directly to FFmpeg (only valid-sized frames)
        let total = valid_frames.len();
        for (i, frame) in valid_frames.iter().enumerate() {
            if let Err(e) = stdin.write_all(&frame.rgba_data) {
                // Write failed - FFmpeg probably crashed, get stderr
                drop(stdin);
                let output = child.wait_with_output().ok();
                let stderr = output
                    .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
                    .unwrap_or_default();
                return Err(format!(
                    "Failed to write frame {}: {}. FFmpeg error: {}",
                    i, e, stderr
                ));
            }

            progress_callback((i + 1) as f32 / total as f32 * 0.9);
        }

        // Close stdin to signal end of input
        drop(stdin);

        // Wait for FFmpeg to finish
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("GIF encoding failed: {}", stderr));
        }

        progress_callback(1.0);

        // Get file size
        let file_size = std::fs::metadata(output_path)
            .map(|m| m.len())
            .map_err(|e| format!("Failed to get output file size: {}", e))?;

        Ok(file_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preset_fast_filter() {
        let filter = GifQualityPreset::Fast.to_filter();
        // Fast preset should use 128 colors and no dithering
        assert!(filter.contains("max_colors=128"));
        assert!(filter.contains("dither=none"));
        assert!(filter.contains("diff_mode=rectangle"));
        assert!(filter.contains("stats_mode=full"));
    }

    #[test]
    fn test_preset_balanced_filter() {
        let filter = GifQualityPreset::Balanced.to_filter();
        // Balanced preset should use 256 colors and bayer dithering
        assert!(filter.contains("max_colors=256"));
        assert!(filter.contains("dither=bayer"));
        assert!(filter.contains("bayer_scale=5"));
        assert!(filter.contains("diff_mode=rectangle"));
        assert!(filter.contains("stats_mode=full"));
    }

    #[test]
    fn test_preset_high_filter() {
        let filter = GifQualityPreset::High.to_filter();
        // High preset should use 256 colors and floyd_steinberg dithering
        assert!(filter.contains("max_colors=256"));
        assert!(filter.contains("dither=floyd_steinberg"));
        assert!(filter.contains("diff_mode=rectangle"));
        assert!(filter.contains("stats_mode=full"));
    }

    #[test]
    fn test_all_presets_use_split_filter() {
        // All presets should use split filter for palette generation
        for preset in [
            GifQualityPreset::Fast,
            GifQualityPreset::Balanced,
            GifQualityPreset::High,
        ] {
            let filter = preset.to_filter();
            assert!(filter.starts_with("split[a][b]"));
            assert!(filter.contains("palettegen"));
            assert!(filter.contains("paletteuse"));
        }
    }

    #[test]
    fn test_default_preset_is_balanced() {
        assert_eq!(GifQualityPreset::default(), GifQualityPreset::Balanced);
    }
}

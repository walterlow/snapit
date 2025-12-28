//! FFmpeg-based GIF encoding with direct piping.
//!
//! Uses per-frame palette generation for optimal color accuracy.
//! Each frame gets its own 256-color palette instead of sharing
//! a global palette across all frames.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::gif_encoder::GifFrame;

/// Quality preset for GIF encoding.
/// All presets use per-frame palette for better color accuracy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum GifQualityPreset {
    /// No dithering - fastest, may show banding.
    Fast,
    /// Bayer dithering - good speed/quality balance.
    #[default]
    Balanced,
    /// Floyd-Steinberg dithering - best quality, slower.
    High,
}

impl GifQualityPreset {
    /// Get the FFmpeg filter string for this preset.
    /// Uses per-frame palette generation for better color accuracy.
    fn to_filter(&self) -> &'static str {
        // Per-frame palette: each frame gets its own optimized 256-color palette
        // split[a][b] = duplicate input to two streams
        // [a]palettegen = generate palette from first stream
        // stats_mode=single = generate new palette for EACH frame
        // [b][p]paletteuse = combine second stream with palette
        // new=1 = use new palette for each frame
        match self {
            // Fast: per-frame palette, no dithering (fastest)
            GifQualityPreset::Fast =>
                "split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=none",
            // Balanced: per-frame palette, bayer dithering (fast + good quality)
            GifQualityPreset::Balanced =>
                "split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=bayer:bayer_scale=5",
            // High: per-frame palette, floyd_steinberg (best quality)
            GifQualityPreset::High =>
                "split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=floyd_steinberg",
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

        // Build filter chain based on preset
        let filter = self.preset.to_filter();

        eprintln!("[FFMPEG] ========================================");
        eprintln!("[FFMPEG] Input: {} frames of {}x{} RGBA", frames.len(), self.width, self.height);
        eprintln!("[FFMPEG] Input FPS: {:.2}", self.fps);
        eprintln!("[FFMPEG] Expected GIF duration: {:.2}s", frames.len() as f64 / self.fps);
        eprintln!("[FFMPEG] Filter: {}", filter);
        eprintln!("[FFMPEG] Output: {}", output_path.display());
        eprintln!("[FFMPEG] ========================================");

        // Direct pipe: rawvideo -> palettegen -> paletteuse -> GIF
        // Using BGRA input to avoid color conversion overhead in capture loop
        let mut child = Command::new(&self.ffmpeg_path)
            .args([
                "-y",
                "-f", "rawvideo",
                "-pix_fmt", "bgra",
                "-s", &format!("{}x{}", self.width, self.height),
                "-r", &format!("{}", self.fps),
                "-i", "pipe:0",
                "-filter_complex", filter,
                "-loop", "0",
            ])
            .arg(output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let mut stdin = child.stdin.take()
            .ok_or_else(|| "Failed to open FFmpeg stdin".to_string())?;

        // Pipe frames directly to FFmpeg
        let total = frames.len();
        for (i, frame) in frames.iter().enumerate() {
            if let Err(e) = stdin.write_all(&frame.rgba_data) {
                // Write failed - FFmpeg probably crashed, get stderr
                drop(stdin);
                let output = child.wait_with_output().ok();
                let stderr = output
                    .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
                    .unwrap_or_default();
                return Err(format!("Failed to write frame {}: {}. FFmpeg error: {}", i, e, stderr));
            }

            progress_callback((i + 1) as f32 / total as f32 * 0.9);
        }

        // Close stdin to signal end of input
        drop(stdin);

        // Wait for FFmpeg to finish
        let output = child.wait_with_output()
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

        eprintln!("[FFMPEG] Encoding complete! Output size: {} bytes ({:.2} MB)",
            file_size, file_size as f64 / 1024.0 / 1024.0);

        Ok(file_size)
    }
}

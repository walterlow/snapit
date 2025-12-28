//! FFmpeg-based GIF encoding for fast, high-quality output.
//!
//! Uses FFmpeg's palettegen and paletteuse filters for optimal GIF quality
//! while being significantly faster than pure Rust alternatives.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::gif_encoder::GifFrame;

/// RAII guard for automatic temp file cleanup.
/// Ensures the temp file is deleted even on panic.
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Quality preset for GIF encoding.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum GifQualityPreset {
    /// Single-pass, no dithering - fastest encoding.
    Fast,
    /// Two-pass with optimized palette - good quality/speed balance.
    #[default]
    Balanced,
    /// Two-pass with sierra2_4a dithering - best quality.
    High,
}

/// FFmpeg-based GIF encoder.
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

        match self.preset {
            GifQualityPreset::Fast => self.encode_single_pass(frames, output_path, progress_callback),
            GifQualityPreset::Balanced | GifQualityPreset::High => {
                self.encode_two_pass(frames, output_path, progress_callback)
            }
        }
    }

    /// Single-pass encoding for fast mode.
    fn encode_single_pass<F>(
        &self,
        frames: &[GifFrame],
        output_path: &Path,
        progress_callback: F,
    ) -> Result<u64, String>
    where
        F: Fn(f32) + Send + Sync,
    {
        // Single-pass command with split filter for inline palette generation
        let mut child = Command::new(&self.ffmpeg_path)
            .args([
                "-y",
                "-f", "rawvideo",
                "-pix_fmt", "rgba",
                "-s", &format!("{}x{}", self.width, self.height),
                "-r", &format!("{}", self.fps),
                "-i", "pipe:0",
                "-vf", "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=none",
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

        // Pipe frames to FFmpeg
        self.pipe_frames(&mut stdin, frames, &progress_callback)?;

        // Close stdin to signal end of input
        drop(stdin);

        // Wait for FFmpeg to complete
        let output = child.wait_with_output()
            .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("FFmpeg encoding failed: {}", stderr));
        }

        progress_callback(1.0);

        // Get file size
        std::fs::metadata(output_path)
            .map(|m| m.len())
            .map_err(|e| format!("Failed to get output file size: {}", e))
    }

    /// Two-pass encoding for balanced/high quality.
    fn encode_two_pass<F>(
        &self,
        frames: &[GifFrame],
        output_path: &Path,
        progress_callback: F,
    ) -> Result<u64, String>
    where
        F: Fn(f32) + Send + Sync,
    {
        // Create temp file for palette with RAII guard for automatic cleanup
        let temp_dir = std::env::temp_dir();
        let palette_path = temp_dir.join(format!("snapit_palette_{}.png", std::process::id()));
        let _guard = TempFileGuard(palette_path.clone());

        // Pass 1: Generate palette (0% - 40%)
        self.generate_palette(frames, &palette_path, |p| {
            progress_callback(p * 0.4);
        })?;

        // Pass 2: Generate GIF with palette (40% - 100%)
        let dither = match self.preset {
            GifQualityPreset::High => "sierra2_4a",
            _ => "bayer:bayer_scale=5",
        };

        self.apply_palette(frames, &palette_path, output_path, dither, |p| {
            progress_callback(0.4 + p * 0.6);
        })
        // TempFileGuard automatically cleans up palette_path on drop
    }

    /// Pass 1: Generate palette from frames.
    fn generate_palette<F>(
        &self,
        frames: &[GifFrame],
        palette_path: &Path,
        progress_callback: F,
    ) -> Result<(), String>
    where
        F: Fn(f32) + Send + Sync,
    {
        let mut child = Command::new(&self.ffmpeg_path)
            .args([
                "-y",
                "-f", "rawvideo",
                "-pix_fmt", "rgba",
                "-s", &format!("{}x{}", self.width, self.height),
                "-r", &format!("{}", self.fps),
                "-i", "pipe:0",
                "-vf", "palettegen=stats_mode=full:max_colors=256",
                "-update", "1",
            ])
            .arg(palette_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg for palette: {}", e))?;

        let mut stdin = child.stdin.take()
            .ok_or_else(|| "Failed to open FFmpeg stdin".to_string())?;

        self.pipe_frames(&mut stdin, frames, &progress_callback)?;

        drop(stdin);

        let output = child.wait_with_output()
            .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Palette generation failed: {}", stderr));
        }

        Ok(())
    }

    /// Pass 2: Apply palette to generate final GIF.
    fn apply_palette<F>(
        &self,
        frames: &[GifFrame],
        palette_path: &Path,
        output_path: &Path,
        dither: &str,
        progress_callback: F,
    ) -> Result<u64, String>
    where
        F: Fn(f32) + Send + Sync,
    {
        let filter = format!("[0:v][1:v]paletteuse=dither={}:diff_mode=rectangle", dither);

        let mut child = Command::new(&self.ffmpeg_path)
            .args([
                "-y",
                "-f", "rawvideo",
                "-pix_fmt", "rgba",
                "-s", &format!("{}x{}", self.width, self.height),
                "-r", &format!("{}", self.fps),
                "-i", "pipe:0",
                "-i",
            ])
            .arg(palette_path)
            .args([
                "-lavfi", &filter,
                "-loop", "0",
            ])
            .arg(output_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg for GIF: {}", e))?;

        let mut stdin = child.stdin.take()
            .ok_or_else(|| "Failed to open FFmpeg stdin".to_string())?;

        self.pipe_frames(&mut stdin, frames, &progress_callback)?;

        drop(stdin);

        let output = child.wait_with_output()
            .map_err(|e| format!("Failed to wait for FFmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("GIF encoding failed: {}", stderr));
        }

        progress_callback(1.0);

        std::fs::metadata(output_path)
            .map(|m| m.len())
            .map_err(|e| format!("Failed to get output file size: {}", e))
    }

    /// Pipe frames to FFmpeg stdin with progress reporting.
    fn pipe_frames<F>(
        &self,
        stdin: &mut std::process::ChildStdin,
        frames: &[GifFrame],
        progress_callback: &F,
    ) -> Result<(), String>
    where
        F: Fn(f32) + Send + Sync,
    {
        let total = frames.len();

        for (i, frame) in frames.iter().enumerate() {
            stdin
                .write_all(&frame.rgba_data)
                .map_err(|e| format!("Failed to write frame {}: {}", i, e))?;

            progress_callback((i + 1) as f32 / total as f32);
        }

        Ok(())
    }
}


use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Ensure FFmpeg binaries are in the binaries folder for Tauri to bundle
    if let Err(e) = ensure_ffmpeg_binaries() {
        eprintln!("Warning: Failed to set up ffmpeg binaries: {}", e);
        eprintln!("The app will download ffmpeg at runtime if not bundled.");
    }

    tauri_build::build()
}

/// Ensure FFmpeg binaries exist in the binaries folder for bundling.
/// Tries multiple sources: existing binaries, ffmpeg-sidecar cache, system PATH.
fn ensure_ffmpeg_binaries() -> Result<(), Box<dyn std::error::Error>> {
    let (ffmpeg_name, ffprobe_name, target_suffix) = if cfg!(target_os = "windows") {
        ("ffmpeg.exe", "ffprobe.exe", "x86_64-pc-windows-msvc.exe")
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            ("ffmpeg", "ffprobe", "aarch64-apple-darwin")
        } else {
            ("ffmpeg", "ffprobe", "x86_64-apple-darwin")
        }
    } else {
        ("ffmpeg", "ffprobe", "x86_64-unknown-linux-gnu")
    };

    let binaries_dir = PathBuf::from("binaries");
    let ffmpeg_dest = binaries_dir.join(format!("ffmpeg-{}", target_suffix));
    let ffprobe_dest = binaries_dir.join(format!("ffprobe-{}", target_suffix));

    // If binaries already exist, we're done
    if ffmpeg_dest.exists() && ffprobe_dest.exists() {
        println!("cargo:warning=FFmpeg binaries already present");
        return Ok(());
    }

    fs::create_dir_all(&binaries_dir)?;

    // Try 1: Download via ffmpeg-sidecar
    println!("cargo:warning=Downloading FFmpeg via ffmpeg-sidecar...");
    if ffmpeg_sidecar::download::auto_download().is_ok() {
        // Check common cache locations
        let cache_dirs = get_possible_cache_dirs();
        for cache_dir in cache_dirs {
            let ffmpeg_src = cache_dir.join(ffmpeg_name);
            let ffprobe_src = cache_dir.join(ffprobe_name);
            if ffmpeg_src.exists() {
                fs::copy(&ffmpeg_src, &ffmpeg_dest)?;
                println!("cargo:warning=Copied ffmpeg from {:?}", cache_dir);
                if ffprobe_src.exists() {
                    fs::copy(&ffprobe_src, &ffprobe_dest)?;
                }
                return Ok(());
            }
        }
    }

    // Try 2: Copy from system PATH
    if let Some(system_ffmpeg) = find_in_path(ffmpeg_name) {
        fs::copy(&system_ffmpeg, &ffmpeg_dest)?;
        println!("cargo:warning=Copied ffmpeg from system PATH: {:?}", system_ffmpeg);

        if let Some(system_ffprobe) = find_in_path(ffprobe_name) {
            fs::copy(&system_ffprobe, &ffprobe_dest)?;
        }
        return Ok(());
    }

    Err("Could not find or download FFmpeg".into())
}

/// Get possible FFmpeg cache directories
fn get_possible_cache_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // ffmpeg-sidecar default cache
    if let Ok(sidecar_dir) = ffmpeg_sidecar::paths::sidecar_dir() {
        dirs.push(sidecar_dir);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("ffmpeg-sidecar"));
            dirs.push(PathBuf::from(&local).join("ffmpeg"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(data_dir) = dirs::data_local_dir() {
            dirs.push(data_dir.join("ffmpeg-sidecar"));
        }
    }

    dirs
}

/// Find an executable in system PATH
fn find_in_path(name: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let cmd = "which";

    Command::new(cmd)
        .arg(name)
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout);
                let first_line = path_str.lines().next()?.trim();
                if !first_line.is_empty() {
                    let path = PathBuf::from(first_line);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
            None
        })
}

fn main() {
    // Download ffmpeg binary at build time for development
    // In production, ffmpeg-sidecar will download on first use if not cached
    let _ = ffmpeg_sidecar::download::auto_download();

    tauri_build::build()
}

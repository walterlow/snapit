#[cfg(test)]
mod tests;

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use image::{DynamicImage, GenericImageView};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Manager};
use tokio::fs as async_fs;
use ts_rs::TS;

/// Get the user's configured save directory from settings, falling back to Pictures/SnapIt
fn get_captures_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = get_app_data_dir(app)?;
    let settings_path = app_data_dir.join("settings.json");

    // Try to read settings file
    if let Ok(content) = fs::read_to_string(&settings_path) {
        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&content) {
            // Get the "general" object and then "defaultSaveDir"
            if let Some(general) = settings.get("general") {
                if let Some(default_dir) = general.get("defaultSaveDir") {
                    if let Some(dir_str) = default_dir.as_str() {
                        let path = PathBuf::from(dir_str);
                        // Ensure directory exists
                        if !path.exists() {
                            fs::create_dir_all(&path)
                                .map_err(|e| format!("Failed to create save directory: {}", e))?;
                        }
                        return Ok(path);
                    }
                }
            }
        }
    }

    // Fallback to Pictures/SnapIt
    let pictures_dir = app
        .path()
        .picture_dir()
        .map_err(|e| format!("Failed to get pictures directory: {}", e))?;
    let snapit_path = pictures_dir.join("SnapIt");

    if !snapit_path.exists() {
        fs::create_dir_all(&snapit_path)
            .map_err(|e| format!("Failed to create SnapIt directory: {}", e))?;
    }

    Ok(snapit_path)
}

const THUMBNAIL_SIZE: u32 = 400;

/// Find ffmpeg binary - checks bundled location, sidecar cache, then system PATH.
pub fn find_ffmpeg() -> Option<PathBuf> {
    let binary_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    
    // Check bundled location (next to executable)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled = exe_dir.join(binary_name);
            if bundled.exists() {
                return Some(bundled);
            }
            // Also check resources subdirectory (Tauri puts resources there on some platforms)
            let resources = exe_dir.join("resources").join(binary_name);
            if resources.exists() {
                return Some(resources);
            }
        }
    }
    
    // Check ffmpeg-sidecar cache
    if let Ok(sidecar_dir) = ffmpeg_sidecar::paths::sidecar_dir() {
        let cached = sidecar_dir.join(binary_name);
        if cached.exists() {
            return Some(cached);
        }
    }
    
    // Check system PATH (for development or if ffmpeg is installed globally)
    if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(binary_name)
        .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let first_line = path_str.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                let path = PathBuf::from(first_line);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }
    
    None
}

/// Generate thumbnail from video file using bundled ffmpeg.
/// Returns the thumbnail path if successful.
fn generate_video_thumbnail(
    video_path: &PathBuf,
    thumbnail_path: &PathBuf,
) -> Result<(), String> {
    use std::process::Command;
    
    let ffmpeg_path = find_ffmpeg()
        .ok_or_else(|| "ffmpeg not found".to_string())?;
    
    // Use ffmpeg to extract a frame at 1 second (or 0 if video is shorter)
    let result = Command::new(&ffmpeg_path)
        .args([
            "-y",
            "-ss", "1",
            "-i", &video_path.to_string_lossy().to_string(),
            "-vframes", "1",
            "-vf", &format!("scale={}:-1", THUMBNAIL_SIZE),
            &thumbnail_path.to_string_lossy().to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    
    if result.status.success() {
        return Ok(());
    }
    
    // Try at 0 seconds if 1 second failed (video might be < 1 second)
    let retry_result = Command::new(&ffmpeg_path)
        .args([
            "-y",
            "-ss", "0",
            "-i", &video_path.to_string_lossy().to_string(),
            "-vframes", "1",
            "-vf", &format!("scale={}:-1", THUMBNAIL_SIZE),
            &thumbnail_path.to_string_lossy().to_string(),
        ])
        .output()
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;
    
    if retry_result.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&retry_result.stderr);
        Err(format!("ffmpeg failed: {}", stderr))
    }
}

/// Find ffprobe binary - checks bundled location, sidecar cache, then system PATH.
pub fn find_ffprobe() -> Option<PathBuf> {
    let binary_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    
    // Check bundled location (next to executable)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled = exe_dir.join(binary_name);
            if bundled.exists() {
                return Some(bundled);
            }
            // Also check resources subdirectory
            let resources = exe_dir.join("resources").join(binary_name);
            if resources.exists() {
                return Some(resources);
            }
        }
    }
    
    // Check ffmpeg-sidecar cache
    if let Ok(sidecar_dir) = ffmpeg_sidecar::paths::sidecar_dir() {
        let cached = sidecar_dir.join(binary_name);
        if cached.exists() {
            return Some(cached);
        }
    }
    
    // Check system PATH
    if let Ok(output) = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg(binary_name)
        .output()
    {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            let first_line = path_str.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                let path = PathBuf::from(first_line);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }
    
    None
}

/// Get video dimensions using bundled ffprobe.
/// Returns (width, height) if successful.
#[allow(dead_code)]
fn get_video_dimensions(video_path: &PathBuf) -> Option<(u32, u32)> {
    use std::process::Command;
    
    let ffprobe_path = find_ffprobe()?;
    
    let output = Command::new(ffprobe_path)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0:s=x",
            &video_path.to_string_lossy().to_string(),
        ])
        .output()
        .ok()?;
    
    if !output.status.success() {
        return None;
    }
    
    let output_str = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = output_str.trim().split('x').collect();
    
    if parts.len() == 2 {
        let width = parts[0].parse::<u32>().ok()?;
        let height = parts[1].parse::<u32>().ok()?;
        Some((width, height))
    } else {
        None
    }
}

/// Generate thumbnail from GIF using pure Rust (image crate).
/// Extracts the first frame and resizes it.
fn generate_gif_thumbnail(
    gif_path: &PathBuf,
    thumbnail_path: &PathBuf,
) -> Result<(), String> {
    // Open the GIF and get the first frame
    let file = fs::File::open(gif_path)
        .map_err(|e| format!("Failed to open GIF: {}", e))?;
    
    let decoder = image::codecs::gif::GifDecoder::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Failed to decode GIF: {}", e))?;
    
    use image::AnimationDecoder;
    let frames = decoder.into_frames();
    let first_frame = frames
        .into_iter()
        .next()
        .ok_or_else(|| "GIF has no frames".to_string())?
        .map_err(|e| format!("Failed to get frame: {}", e))?;
    
    let image = DynamicImage::ImageRgba8(first_frame.into_buffer());
    let thumbnail = image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    
    thumbnail.save(thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    
    Ok(())
}

/// Region coordinates for capture selection.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Source information for a capture.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CaptureSource {
    pub monitor: Option<u32>,
    pub window_id: Option<u32>,
    pub window_title: Option<String>,
    pub region: Option<Region>,
}

/// Image dimensions.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

/// Annotation on a capture.
/// Note: This type uses serde(flatten) which ts-rs can't handle automatically,
/// so we define the TypeScript type manually in src/types/index.ts.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    #[serde(flatten)]
    pub properties: serde_json::Value,
}

/// Full capture project data.
/// Note: Contains Annotation type with serde(flatten) which ts-rs can't handle.
/// The TypeScript type is manually defined in src/types/index.ts.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureProject {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub capture_type: String,
    pub source: CaptureSource,
    pub original_image: String,
    pub dimensions: Dimensions,
    pub annotations: Vec<Annotation>,
    pub tags: Vec<String>,
    pub favorite: bool,
}

/// Lightweight capture item for list display.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CaptureListItem {
    pub id: String,
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "string")]
    pub updated_at: DateTime<Utc>,
    pub capture_type: String,
    pub dimensions: Dimensions,
    pub thumbnail_path: String,
    pub image_path: String,
    pub has_annotations: bool,
    pub tags: Vec<String>,
    pub favorite: bool,
    /// True if the original image file is missing from disk
    pub is_missing: bool,
}

/// Request to save a new capture.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct SaveCaptureRequest {
    pub image_data: String,
    pub capture_type: String,
    pub source: CaptureSource,
}

/// Response after saving a capture.
/// Note: Contains CaptureProject which has Annotation with serde(flatten).
/// The TypeScript type is manually defined in src/types/index.ts.
#[derive(Debug, Serialize, Deserialize)]
pub struct SaveCaptureResponse {
    pub id: String,
    pub project: CaptureProject,
    pub thumbnail_path: String,
    pub image_path: String,
}

/// Storage statistics.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct StorageStats {
    #[ts(type = "number")]
    pub total_size_bytes: u64,
    pub total_size_mb: f64,
    #[ts(type = "number")]
    pub capture_count: u32,
    pub storage_path: String,
}

fn get_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

#[command]
pub fn get_library_folder(app: AppHandle) -> Result<String, String> {
    let captures_dir = get_captures_dir(&app)?;
    Ok(captures_dir.to_string_lossy().to_string())
}

fn ensure_directories(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = get_app_data_dir(app)?;

    let dirs = ["captures", "projects", "thumbnails"];
    for dir in dirs {
        let path = base_dir.join(dir);
        if !path.exists() {
            fs::create_dir_all(&path)
                .map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
        }
    }

    Ok(base_dir)
}

fn generate_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0))
        .as_millis();
    let random: u32 = rand::thread_rng().gen();
    format!("{:x}{:06x}", timestamp, random & 0xFFFFFF)
}

fn generate_thumbnail(image: &DynamicImage) -> Result<DynamicImage, String> {
    Ok(image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE))
}

fn calculate_dir_size(path: &PathBuf) -> u64 {
    let mut size: u64 = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(metadata) = fs::metadata(&path) {
                    size += metadata.len();
                }
            } else if path.is_dir() {
                size += calculate_dir_size(&path);
            }
        }
    }
    size
}

#[command]
pub async fn save_capture(
    app: AppHandle,
    request: SaveCaptureRequest,
) -> Result<SaveCaptureResponse, String> {
    let base_dir = ensure_directories(&app)?;
    let captures_dir = get_captures_dir(&app)?;
    let id = generate_id();
    let now = Utc::now();

    let decoded = STANDARD
        .decode(&request.image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let image = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let (width, height) = image.dimensions();

    let date_str = now.format("%Y-%m-%d_%H%M%S").to_string();
    let original_filename = format!("{}_{}.png", date_str, &id);
    let thumbnail_filename = format!("{}_thumb.png", &id);

    // Save original image to user's configured directory
    let original_path = captures_dir.join(&original_filename);
    image
        .save(&original_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    // Generate and save thumbnail (always in app data dir)
    let thumbnail = generate_thumbnail(&image)?;
    let thumbnails_dir = base_dir.join("thumbnails");
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    // Create project data - store full path to image
    let project = CaptureProject {
        id: id.clone(),
        created_at: now,
        updated_at: now,
        capture_type: request.capture_type,
        source: request.source,
        original_image: original_path.to_string_lossy().to_string(),
        dimensions: Dimensions { width, height },
        annotations: Vec::new(),
        tags: Vec::new(),
        favorite: false,
    };

    // Save project file
    let projects_dir = base_dir.join("projects");
    let project_dir = projects_dir.join(&id);
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project dir: {}", e))?;

    let project_file = project_dir.join("project.json");
    let project_json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    fs::write(&project_file, project_json)
        .map_err(|e| format!("Failed to write project file: {}", e))?;

    Ok(SaveCaptureResponse {
        id,
        project,
        thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
        image_path: original_path.to_string_lossy().to_string(),
    })
}

/// Fast save capture from RGBA file path - skips base64 encoding/decoding
#[command]
pub async fn save_capture_from_file(
    app: AppHandle,
    file_path: String,
    width: u32,
    height: u32,
    capture_type: String,
    source: CaptureSource,
) -> Result<SaveCaptureResponse, String> {
    let base_dir = ensure_directories(&app)?;
    let captures_dir = get_captures_dir(&app)?;
    let id = generate_id();
    let now = Utc::now();

    // Read RGBA file - skip 8-byte header (width + height stored in file)
    use std::io::Read;
    let mut file = fs::File::open(&file_path)
        .map_err(|e| format!("Failed to open RGBA file: {}", e))?;

    // Skip the 8-byte header (4 bytes width + 4 bytes height)
    let mut header = [0u8; 8];
    file.read_exact(&mut header)
        .map_err(|e| format!("Failed to read header: {}", e))?;

    // Read RGBA data
    let expected_size = (width * height * 4) as usize;
    let mut rgba_data = vec![0u8; expected_size];
    file.read_exact(&mut rgba_data)
        .map_err(|e| format!("Failed to read RGBA data: {}", e))?;

    // Create image from RGBA data
    let image: DynamicImage = image::RgbaImage::from_raw(width, height, rgba_data)
        .ok_or_else(|| "Failed to create image from RGBA data".to_string())?
        .into();

    let date_str = now.format("%Y-%m-%d_%H%M%S").to_string();
    let original_filename = format!("{}_{}.png", date_str, &id);
    let thumbnail_filename = format!("{}_thumb.png", &id);

    // Save original image to user's configured directory
    let original_path = captures_dir.join(&original_filename);
    image
        .save(&original_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    // Generate and save thumbnail (always in app data dir)
    let thumbnail = generate_thumbnail(&image)?;
    let thumbnails_dir = base_dir.join("thumbnails");
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    // NOTE: Don't delete the temp file here - JS needs to read it for display.
    // The useFastImage hook will clean it up after loading successfully.

    // Create project data - store full path to image
    let project = CaptureProject {
        id: id.clone(),
        created_at: now,
        updated_at: now,
        capture_type,
        source,
        original_image: original_path.to_string_lossy().to_string(),
        dimensions: Dimensions { width, height },
        annotations: Vec::new(),
        tags: Vec::new(),
        favorite: false,
    };

    // Save project file
    let projects_dir = base_dir.join("projects");
    let project_dir = projects_dir.join(&id);
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project dir: {}", e))?;

    let project_file = project_dir.join("project.json");
    let project_json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    fs::write(&project_file, project_json)
        .map_err(|e| format!("Failed to write project file: {}", e))?;

    Ok(SaveCaptureResponse {
        id,
        project,
        thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
        image_path: original_path.to_string_lossy().to_string(),
    })
}

#[command]
pub async fn update_project_annotations(
    app: AppHandle,
    project_id: String,
    annotations: Vec<Annotation>,
) -> Result<CaptureProject, String> {
    let base_dir = get_app_data_dir(&app)?;
    let project_file = base_dir
        .join("projects")
        .join(&project_id)
        .join("project.json");

    if !project_file.exists() {
        return Err("Project not found".to_string());
    }

    let content = fs::read_to_string(&project_file)
        .map_err(|e| format!("Failed to read project: {}", e))?;

    let mut project: CaptureProject =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;

    project.annotations = annotations;
    project.updated_at = Utc::now();

    let project_json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    fs::write(&project_file, project_json)
        .map_err(|e| format!("Failed to write project: {}", e))?;

    Ok(project)
}

#[command]
pub async fn update_project_metadata(
    app: AppHandle,
    project_id: String,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
) -> Result<CaptureProject, String> {
    let base_dir = get_app_data_dir(&app)?;
    let project_file = base_dir
        .join("projects")
        .join(&project_id)
        .join("project.json");

    if !project_file.exists() {
        return Err("Project not found".to_string());
    }

    let content = fs::read_to_string(&project_file)
        .map_err(|e| format!("Failed to read project: {}", e))?;

    let mut project: CaptureProject =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;

    if let Some(t) = tags {
        project.tags = t;
    }
    if let Some(f) = favorite {
        project.favorite = f;
    }
    project.updated_at = Utc::now();

    let project_json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    fs::write(&project_file, project_json)
        .map_err(|e| format!("Failed to write project: {}", e))?;

    Ok(project)
}

/// Process a single project directory into a CaptureListItem.
/// Returns None if the project can't be loaded.
async fn load_project_item(
    project_dir: PathBuf,
    base_dir: PathBuf,
    thumbnails_dir: PathBuf,
) -> Option<CaptureListItem> {
    let project_file = project_dir.join("project.json");
    let content = async_fs::read_to_string(&project_file).await.ok()?;
    let project: CaptureProject = serde_json::from_str(&content).ok()?;

    let thumbnail_path = thumbnails_dir
        .join(format!("{}_thumb.png", &project.id))
        .to_string_lossy()
        .to_string();

    // Handle both old format (filename only) and new format (full path)
    let original_path = PathBuf::from(&project.original_image);
    let image_path_buf = if original_path.is_absolute() {
        original_path
    } else {
        // Legacy: construct path from app data dir
        base_dir.join("captures").join(&project.original_image)
    };
    let image_path = image_path_buf.to_string_lossy().to_string();

    // Check if the original image file exists
    let is_missing = !async_fs::try_exists(&image_path_buf).await.unwrap_or(false);

    Some(CaptureListItem {
        id: project.id,
        created_at: project.created_at,
        updated_at: project.updated_at,
        capture_type: project.capture_type,
        dimensions: project.dimensions,
        thumbnail_path,
        image_path,
        has_annotations: !project.annotations.is_empty(),
        tags: project.tags,
        favorite: project.favorite,
        is_missing,
    })
}

/// Process a video project folder into a CaptureListItem.
/// 
/// Video project folders contain:
///   - project.json (metadata)
///   - screen.mp4 (main recording)
///   - webcam.mp4 (optional)
///   - cursor.json (optional)
/// 
/// Returns None if the folder isn't a valid video project.
async fn load_video_project_folder(
    folder_path: PathBuf,
    thumbnails_dir: PathBuf,
) -> Option<CaptureListItem> {
    // Check if this is a video project folder
    let project_json = folder_path.join("project.json");
    let screen_mp4 = folder_path.join("screen.mp4");
    
    // Must have at least screen.mp4
    if !async_fs::try_exists(&screen_mp4).await.unwrap_or(false) {
        return None;
    }
    
    // Use folder name as ID
    let id = folder_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("recording")
        .to_string();
    
    // Try to read metadata from project.json, fall back to file metadata
    let (created_at, updated_at, dimensions) = if async_fs::try_exists(&project_json).await.unwrap_or(false) {
        if let Ok(content) = async_fs::read_to_string(&project_json).await {
            if let Ok(project) = serde_json::from_str::<serde_json::Value>(&content) {
                let created = project.get("createdAt")
                    .and_then(|v| v.as_str())
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(Utc::now);
                let updated = project.get("updatedAt")
                    .and_then(|v| v.as_str())
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or(created);
                let dims = project.get("sources")
                    .map(|s| Dimensions {
                        width: s.get("originalWidth").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                        height: s.get("originalHeight").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    })
                    .unwrap_or(Dimensions { width: 0, height: 0 });
                (created, updated, dims)
            } else {
                (Utc::now(), Utc::now(), Dimensions { width: 0, height: 0 })
            }
        } else {
            (Utc::now(), Utc::now(), Dimensions { width: 0, height: 0 })
        }
    } else {
        // Fall back to folder metadata
        let metadata = async_fs::metadata(&folder_path).await.ok()?;
        let created = metadata.created()
            .or_else(|_| metadata.modified())
            .map(|t| DateTime::<Utc>::from(t))
            .unwrap_or_else(|_| Utc::now());
        let updated = metadata.modified()
            .map(|t| DateTime::<Utc>::from(t))
            .unwrap_or(created);
        (created, updated, Dimensions { width: 0, height: 0 })
    };
    
    // Check/generate thumbnail
    let thumbnail_filename = format!("{}_thumb.png", &id);
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
    let thumb_exists = async_fs::try_exists(&thumbnail_path).await.unwrap_or(false);
    
    if !thumb_exists {
        let video_path = screen_mp4.clone();
        let thumb_path = thumbnail_path.clone();
        std::thread::spawn(move || {
            match generate_video_thumbnail(&video_path, &thumb_path) {
                Ok(()) => log::debug!("[THUMB] Video project OK: {:?}", thumb_path),
                Err(e) => log::warn!("[THUMB] Video project FAILED: {}", e),
            }
        });
    }
    
    let thumbnail_path_str = if thumb_exists {
        thumbnail_path.to_string_lossy().to_string()
    } else {
        String::new()
    };
    
    Some(CaptureListItem {
        id,
        created_at,
        updated_at,
        capture_type: "video".to_string(),
        dimensions,
        thumbnail_path: thumbnail_path_str,
        // Point to the screen.mp4 inside the folder
        image_path: screen_mp4.to_string_lossy().to_string(),
        has_annotations: false,
        tags: Vec::new(),
        favorite: false,
        is_missing: false,
    })
}

/// Process a single media file (GIF or legacy flat MP4) into a CaptureListItem.
/// Returns None if the file can't be processed.
/// 
/// Note: New MP4 recordings are stored in project folders, but we still support
/// legacy flat MP4 files for backward compatibility.
async fn load_media_item(
    path: PathBuf,
    thumbnails_dir: PathBuf,
) -> Option<CaptureListItem> {
    let metadata = async_fs::metadata(&path).await.ok()?;
    if !metadata.is_file() {
        return None;
    }

    let extension = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())?;

    if extension != "mp4" && extension != "gif" {
        return None;
    }

    // Filter out auxiliary video editor files (webcam recordings, cursor data)
    // These are stored alongside the main recording but shouldn't appear in library
    let file_stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or("");
    if file_stem.ends_with("_webcam") || file_stem.ends_with("_cursor") {
        return None;
    }

    let file_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("recording")
        .to_string();

    // Use file name as ID (without extension)
    let id = path.file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or(&file_name)
        .to_string();

    // Get creation/modification time
    let created_at = metadata.created()
        .or_else(|_| metadata.modified())
        .map(|t| DateTime::<Utc>::from(t))
        .unwrap_or_else(|_| Utc::now());

    let updated_at = metadata.modified()
        .map(|t| DateTime::<Utc>::from(t))
        .unwrap_or(created_at);

    let capture_type = if extension == "gif" { "gif" } else { "video" };

    // Check thumbnail
    let thumbnail_filename = format!("{}_thumb.png", &id);
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
    let thumb_exists = async_fs::try_exists(&thumbnail_path).await.unwrap_or(false);

    if !thumb_exists {
        // Generate thumbnail in background to avoid blocking UI
        let video_path = path.clone();
        let thumb_path = thumbnail_path.clone();
        let is_gif = extension == "gif";
        std::thread::spawn(move || {
            if is_gif {
                match generate_gif_thumbnail(&video_path, &thumb_path) {
                    Ok(()) => log::debug!("[THUMB] GIF OK: {:?}", thumb_path),
                    Err(e) => log::warn!("[THUMB] GIF FAILED: {}", e),
                }
            } else {
                match generate_video_thumbnail(&video_path, &thumb_path) {
                    Ok(()) => log::debug!("[THUMB] Video OK: {:?}", thumb_path),
                    Err(e) => log::warn!("[THUMB] Video FAILED: {}", e),
                }
            }
        });
    }

    let thumbnail_path_str = if thumb_exists {
        thumbnail_path.to_string_lossy().to_string()
    } else {
        String::new()
    };

    // Skip video dimension fetching on startup for faster load
    let dimensions = Dimensions { width: 0, height: 0 };

    Some(CaptureListItem {
        id,
        created_at,
        updated_at,
        capture_type: capture_type.to_string(),
        dimensions,
        thumbnail_path: thumbnail_path_str,
        image_path: path.to_string_lossy().to_string(),
        has_annotations: false,
        tags: Vec::new(),
        favorite: false,
        is_missing: false,
    })
}

#[command]
pub async fn get_capture_list(app: AppHandle) -> Result<Vec<CaptureListItem>, String> {
    use futures::future::join_all;

    let base_dir = get_app_data_dir(&app)?;
    let projects_dir = base_dir.join("projects");
    let thumbnails_dir = base_dir.join("thumbnails");
    let captures_dir = get_captures_dir(&app)?;

    let mut captures: Vec<CaptureListItem> = Vec::new();

    // 1. Load screenshot projects in PARALLEL
    if async_fs::try_exists(&projects_dir).await.unwrap_or(false) {
        // First, collect all project directory paths
        let mut project_dirs: Vec<PathBuf> = Vec::new();
        let mut entries = async_fs::read_dir(&projects_dir)
            .await
            .map_err(|e| format!("Failed to read projects dir: {}", e))?;

        while let Some(entry) = entries.next_entry().await.map_err(|e| format!("Failed to read entry: {}", e))? {
            let path = entry.path();
            if path.is_dir() {
                project_dirs.push(path);
            }
        }

        // Process all projects in parallel
        let project_futures: Vec<_> = project_dirs
            .into_iter()
            .map(|dir| {
                let base = base_dir.clone();
                let thumbs = thumbnails_dir.clone();
                load_project_item(dir, base, thumbs)
            })
            .collect();

        let project_results = join_all(project_futures).await;
        captures.extend(project_results.into_iter().flatten());
    }

    // 2. Scan for video project folders and GIF/legacy MP4 files in PARALLEL
    if async_fs::try_exists(&captures_dir).await.unwrap_or(false) {
        // Collect all entries, separating folders (potential video projects) from files
        let mut video_project_folders: Vec<PathBuf> = Vec::new();
        let mut media_files: Vec<PathBuf> = Vec::new();
        
        if let Ok(mut entries) = async_fs::read_dir(&captures_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.is_dir() {
                    // Check if folder contains screen.mp4 (video project folder)
                    if path.join("screen.mp4").exists() {
                        video_project_folders.push(path);
                    }
                } else {
                    media_files.push(path);
                }
            }
        }

        // Process video project folders in parallel
        let folder_futures: Vec<_> = video_project_folders
            .into_iter()
            .map(|path| {
                let thumbs = thumbnails_dir.clone();
                load_video_project_folder(path, thumbs)
            })
            .collect();

        // Process media files (GIF and legacy MP4) in parallel
        let file_futures: Vec<_> = media_files
            .into_iter()
            .map(|path| {
                let thumbs = thumbnails_dir.clone();
                load_media_item(path, thumbs)
            })
            .collect();

        let folder_results = join_all(folder_futures).await;
        let file_results = join_all(file_futures).await;
        
        captures.extend(folder_results.into_iter().flatten());
        captures.extend(file_results.into_iter().flatten());
    }

    captures.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(captures)
}

#[command]
pub async fn get_project(app: AppHandle, project_id: String) -> Result<CaptureProject, String> {
    let base_dir = get_app_data_dir(&app)?;
    let project_file = base_dir
        .join("projects")
        .join(&project_id)
        .join("project.json");

    if !project_file.exists() {
        return Err("Project not found".to_string());
    }

    let content = fs::read_to_string(&project_file)
        .map_err(|e| format!("Failed to read project: {}", e))?;

    let project: CaptureProject =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;

    Ok(project)
}

#[command]
pub async fn get_project_image(app: AppHandle, project_id: String) -> Result<String, String> {
    let base_dir = get_app_data_dir(&app)?;
    let project_file = base_dir
        .join("projects")
        .join(&project_id)
        .join("project.json");

    if !project_file.exists() {
        return Err("Project not found".to_string());
    }

    let content = fs::read_to_string(&project_file)
        .map_err(|e| format!("Failed to read project: {}", e))?;

    let project: CaptureProject =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse project: {}", e))?;

    // Handle both old format (filename only) and new format (full path)
    let original_path = PathBuf::from(&project.original_image);
    let image_path = if original_path.is_absolute() {
        original_path
    } else {
        base_dir.join("captures").join(&project.original_image)
    };

    let image_data =
        fs::read(&image_path).map_err(|e| format!("Failed to read image: {}", e))?;

    Ok(STANDARD.encode(&image_data))
}

/// Determines the type of capture based on its ID and returns the appropriate file path.
/// Returns (capture_type, file_path) where capture_type is:
///   - "project": Screenshot project (in app_data/projects/)
///   - "video_folder": Video project folder (in captures_dir/)
///   - "video": Legacy flat MP4 file (in captures_dir/)
///   - "gif": GIF file (in captures_dir/)
///   - "unknown": Not found
fn determine_capture_type(
    app: &AppHandle,
    project_id: &str,
) -> Result<(String, Option<PathBuf>), String> {
    let base_dir = get_app_data_dir(app)?;
    let captures_dir = get_captures_dir(app)?;

    // 1. Check if it's a screenshot project (has project.json in app_data/projects/)
    let project_dir = base_dir.join("projects").join(project_id);
    let project_file = project_dir.join("project.json");
    if project_file.exists() {
        // It's a screenshot project - get the image path from project.json
        if let Ok(content) = fs::read_to_string(&project_file) {
            if let Ok(project) = serde_json::from_str::<CaptureProject>(&content) {
                let original_path = PathBuf::from(&project.original_image);
                let image_path = if original_path.is_absolute() {
                    original_path
                } else {
                    base_dir.join("captures").join(&project.original_image)
                };
                return Ok(("project".to_string(), Some(image_path)));
            }
        }
        // project.json exists but couldn't be parsed - still treat as project
        return Ok(("project".to_string(), None));
    }

    // 2. Check if it's a video project folder (folder with screen.mp4 inside)
    let video_folder = captures_dir.join(project_id);
    if video_folder.is_dir() && video_folder.join("screen.mp4").exists() {
        return Ok(("video_folder".to_string(), Some(video_folder)));
    }

    // 3. Check if it's a legacy flat video file (.mp4)
    let video_path = captures_dir.join(format!("{}.mp4", project_id));
    if video_path.exists() {
        return Ok(("video".to_string(), Some(video_path)));
    }

    // 4. Check if it's a GIF file
    let gif_path = captures_dir.join(format!("{}.gif", project_id));
    if gif_path.exists() {
        return Ok(("gif".to_string(), Some(gif_path)));
    }

    // Unknown type - might be already deleted or invalid ID
    Ok(("unknown".to_string(), None))
}

#[command]
pub async fn delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let base_dir = get_app_data_dir(&app)?;
    let captures_dir = get_captures_dir(&app)?;

    // Determine what type of capture this is
    let (capture_type, file_path) = determine_capture_type(&app, &project_id)?;

    match capture_type.as_str() {
        "project" => {
            // Screenshot project - delete original image, project dir, and thumbnail
            if let Some(image_path) = file_path {
                let _ = fs::remove_file(image_path);
            }

            let project_dir = base_dir.join("projects").join(&project_id);
            if project_dir.exists() {
                fs::remove_dir_all(&project_dir)
                    .map_err(|e| format!("Failed to delete project: {}", e))?;
            }
        }
        "video_folder" => {
            // Video project folder - delete the entire folder and all its contents
            // This removes screen.mp4, webcam.mp4, cursor.json, project.json, etc.
            if let Some(folder_path) = file_path {
                if folder_path.exists() {
                    fs::remove_dir_all(&folder_path)
                        .map_err(|e| format!("Failed to delete video project folder: {}", e))?;
                    log::info!("[DELETE] Removed video project folder: {:?}", folder_path);
                }
            }
        }
        "video" => {
            // Legacy flat MP4 file - delete main file and any associated files
            if let Some(video_path) = file_path {
                fs::remove_file(&video_path)
                    .map_err(|e| format!("Failed to delete video file: {}", e))?;
                
                // Also try to delete associated legacy files (_webcam.mp4, _cursor.json, etc.)
                let stem = video_path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let parent = video_path.parent().unwrap_or(&captures_dir);
                
                // Try to delete associated files (don't error if they don't exist)
                let _ = fs::remove_file(parent.join(format!("{}_webcam.mp4", stem)));
                let _ = fs::remove_file(parent.join(format!("{}_cursor.json", stem)));
                let _ = fs::remove_file(parent.join(format!("{}_system.wav", stem)));
                let _ = fs::remove_file(parent.join(format!("{}_mic.wav", stem)));
            }
        }
        "gif" => {
            // GIF file - just delete the file
            if let Some(gif_path) = file_path {
                fs::remove_file(&gif_path)
                    .map_err(|e| format!("Failed to delete GIF file: {}", e))?;
            }
        }
        _ => {
            // Unknown type - nothing to delete, but don't error
            // The item might have already been deleted
        }
    }

    // Always try to delete the thumbnail (common to all types)
    let thumbnail_path = base_dir
        .join("thumbnails")
        .join(format!("{}_thumb.png", &project_id));
    let _ = fs::remove_file(thumbnail_path);

    Ok(())
}

#[command]
pub async fn delete_projects(app: AppHandle, project_ids: Vec<String>) -> Result<(), String> {
    for id in project_ids {
        delete_project(app.clone(), id).await?;
    }
    Ok(())
}

#[command]
pub async fn export_project(
    app: AppHandle,
    project_id: String,
    rendered_image_data: String,
    file_path: String,
    format: String,
) -> Result<(), String> {
    let decoded = STANDARD
        .decode(&rendered_image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let image = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let img_format = match format.to_lowercase().as_str() {
        "png" => image::ImageFormat::Png,
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        _ => image::ImageFormat::Png,
    };

    image
        .save_with_format(&file_path, img_format)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    // Save a copy in the project folder
    let base_dir = get_app_data_dir(&app)?;
    let edited_path = base_dir
        .join("projects")
        .join(&project_id)
        .join("edited.png");

    let mut buffer = Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;
    fs::write(&edited_path, buffer.get_ref())
        .map_err(|e| format!("Failed to save edited copy: {}", e))?;

    Ok(())
}

#[command]
pub async fn get_storage_stats(app: AppHandle) -> Result<StorageStats, String> {
    let base_dir = get_app_data_dir(&app)?;

    let mut total_size: u64 = 0;
    let mut capture_count: u32 = 0;

    let projects_dir = base_dir.join("projects");
    if projects_dir.exists() {
        if let Ok(entries) = fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    capture_count += 1;
                }
            }
        }
    }

    for dir in ["captures", "projects", "thumbnails"] {
        let path = base_dir.join(dir);
        if path.exists() {
            total_size += calculate_dir_size(&path);
        }
    }

    Ok(StorageStats {
        total_size_bytes: total_size,
        total_size_mb: total_size as f64 / (1024.0 * 1024.0),
        capture_count,
        storage_path: base_dir.to_string_lossy().to_string(),
    })
}

/// Ensure ffmpeg is available for video thumbnail generation.
/// Downloads if not already cached.
#[command]
pub async fn ensure_ffmpeg() -> Result<bool, String> {
    // Check if ffmpeg is already available
    if find_ffmpeg().is_some() {
        log::info!("ffmpeg already available");
        return Ok(true);
    }
    
    // Try to download ffmpeg in background
    log::info!("ffmpeg not found, attempting download...");
    match ffmpeg_sidecar::download::auto_download() {
        Ok(()) => {
            log::info!("ffmpeg downloaded successfully");
            Ok(true)
        }
        Err(e) => {
            log::warn!("Failed to download ffmpeg: {:?}", e);
            Ok(false)
        }
    }
}

/// Startup cleanup: ensure directories exist, remove orphan temp files, 
/// migrate legacy video files to folder structure, and regenerate missing thumbnails.
/// Returns immediately and runs heavy work in background thread to avoid blocking UI
#[command]
pub async fn startup_cleanup(app: AppHandle) -> Result<StartupCleanupResult, String> {
    // 0. Pre-create storage directories so first capture isn't slow (fast, do sync)
    ensure_directories(&app)?;

    // Also pre-create the user's save directory (Pictures/SnapIt or custom)
    let captures_dir = get_captures_dir(&app)?;

    // Get paths for background work
    let base_dir = get_app_data_dir(&app)?;
    let projects_dir = base_dir.join("projects");
    let thumbnails_dir = base_dir.join("thumbnails");
    let temp_dir = std::env::temp_dir();

    // Spawn background thread for heavy cleanup work (don't block UI)
    std::thread::spawn(move || {
        let mut temp_files_cleaned = 0;
        let mut thumbnails_regenerated = 0;
        let mut videos_migrated = 0;

        // 1. Clean up orphan RGBA temp files
        if let Ok(entries) = fs::read_dir(&temp_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("snapit_capture_") && name.ends_with(".rgba") {
                        if fs::remove_file(&path).is_ok() {
                            temp_files_cleaned += 1;
                        }
                    }
                }
            }
        }

        // 2. Migrate legacy flat MP4 files to folder structure
        if captures_dir.exists() {
            if let Ok(entries) = fs::read_dir(&captures_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    
                    // Skip directories and non-MP4 files
                    if !path.is_file() {
                        continue;
                    }
                    let extension = path.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();
                    if extension != "mp4" {
                        continue;
                    }
                    
                    // Skip auxiliary files (webcam, etc.)
                    let stem = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    if stem.ends_with("_webcam") || stem.ends_with("_cursor") {
                        continue;
                    }
                    
                    // Migrate this MP4 to folder structure
                    if let Err(e) = migrate_legacy_video(&path, &captures_dir, &thumbnails_dir) {
                        log::warn!("Failed to migrate video {:?}: {}", path, e);
                    } else {
                        videos_migrated += 1;
                    }
                }
            }
        }

        // 3. Regenerate missing thumbnails for screenshot projects
        if projects_dir.exists() {
            if let Ok(entries) = fs::read_dir(&projects_dir) {
                for entry in entries.flatten() {
                    let project_dir = entry.path();
                    if !project_dir.is_dir() {
                        continue;
                    }

                    let project_id = project_dir
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    let thumbnail_path = thumbnails_dir.join(format!("{}_thumb.png", &project_id));

                    // Check if thumbnail is missing
                    if !thumbnail_path.exists() {
                        // Try to read project.json to get the original image path
                        let project_file = project_dir.join("project.json");
                        if let Ok(content) = fs::read_to_string(&project_file) {
                            if let Ok(project) = serde_json::from_str::<CaptureProject>(&content) {
                                // Try to regenerate thumbnail from original image
                                let original_path = PathBuf::from(&project.original_image);
                                if original_path.exists() {
                                    if let Ok(image) = image::open(&original_path) {
                                        if let Ok(thumbnail) = generate_thumbnail(&image) {
                                            if thumbnail.save(&thumbnail_path).is_ok() {
                                                thumbnails_regenerated += 1;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        log::info!(
            "Startup cleanup complete: {} temp files, {} thumbnails, {} videos migrated",
            temp_files_cleaned,
            thumbnails_regenerated,
            videos_migrated
        );
    });

    // Return immediately - cleanup runs in background
    Ok(StartupCleanupResult {
        temp_files_cleaned: 0, // Actual count determined in background
        thumbnails_regenerated: 0,
    })
}

/// Migrate a legacy flat MP4 video to the new folder structure.
/// 
/// Converts: recording_123456.mp4 + recording_123456_webcam.mp4 + recording_123456_cursor.json
/// Into: recording_123456/screen.mp4 + webcam.mp4 + cursor.json + project.json
fn migrate_legacy_video(
    video_path: &PathBuf,
    captures_dir: &PathBuf,
    thumbnails_dir: &PathBuf,
) -> Result<(), String> {
    let stem = video_path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid video path")?
        .to_string();
    
    // Create the project folder
    let folder_path = captures_dir.join(&stem);
    if folder_path.exists() {
        // Already migrated or folder exists with same name
        return Ok(());
    }
    
    fs::create_dir_all(&folder_path)
        .map_err(|e| format!("Failed to create project folder: {}", e))?;
    
    // Move main video to screen.mp4
    let screen_path = folder_path.join("screen.mp4");
    fs::rename(video_path, &screen_path)
        .map_err(|e| format!("Failed to move main video: {}", e))?;
    
    // Move associated files if they exist
    let webcam_src = captures_dir.join(format!("{}_webcam.mp4", stem));
    if webcam_src.exists() {
        let _ = fs::rename(&webcam_src, folder_path.join("webcam.mp4"));
    }
    
    let cursor_src = captures_dir.join(format!("{}_cursor.json", stem));
    if cursor_src.exists() {
        let _ = fs::rename(&cursor_src, folder_path.join("cursor.json"));
    }
    
    let system_src = captures_dir.join(format!("{}_system.wav", stem));
    if system_src.exists() {
        let _ = fs::rename(&system_src, folder_path.join("system.wav"));
    }
    
    let mic_src = captures_dir.join(format!("{}_mic.wav", stem));
    if mic_src.exists() {
        let _ = fs::rename(&mic_src, folder_path.join("mic.wav"));
    }
    
    // Get video metadata using ffprobe if available
    let (width, height, duration_ms, fps) = if let Some(ffprobe) = find_ffprobe() {
        get_video_metadata_for_migration(&ffprobe, &screen_path)
            .unwrap_or((0, 0, 0, 30))
    } else {
        (0, 0, 0, 30)
    };
    
    // Create project.json
    let project = create_migration_project_json(&stem, width, height, duration_ms, fps, &folder_path);
    let project_file = folder_path.join("project.json");
    fs::write(&project_file, project)
        .map_err(|e| format!("Failed to write project.json: {}", e))?;
    
    // Rename thumbnail if it exists (from stem_thumb.png to new folder ID)
    let old_thumb = thumbnails_dir.join(format!("{}_thumb.png", stem));
    if old_thumb.exists() {
        // Thumbnail ID stays the same (folder name = old stem)
        // No need to rename, just keep it
    }
    
    log::info!("[MIGRATION] Migrated legacy video: {} -> {:?}", stem, folder_path);
    
    Ok(())
}

/// Get video metadata using ffprobe for migration.
fn get_video_metadata_for_migration(
    ffprobe_path: &PathBuf,
    video_path: &PathBuf,
) -> Result<(u32, u32, u64, u32), String> {
    use std::process::Command;
    
    let output = Command::new(ffprobe_path)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            "-select_streams", "v:0",
        ])
        .arg(video_path)
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;
    
    if !output.status.success() {
        return Err("ffprobe failed".to_string());
    }
    
    let json_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;
    
    let stream = json["streams"].as_array()
        .and_then(|s| s.first())
        .ok_or("No video stream")?;
    
    let width = stream["width"].as_u64().unwrap_or(0) as u32;
    let height = stream["height"].as_u64().unwrap_or(0) as u32;
    
    let duration_secs = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let duration_ms = (duration_secs * 1000.0) as u64;
    
    let fps_str = stream["r_frame_rate"].as_str()
        .or_else(|| stream["avg_frame_rate"].as_str())
        .unwrap_or("30/1");
    let fps = if let Some((num, den)) = fps_str.split_once('/') {
        let n: f64 = num.parse().unwrap_or(30.0);
        let d: f64 = den.parse().unwrap_or(1.0);
        if d > 0.0 { (n / d).round() as u32 } else { 30 }
    } else {
        fps_str.parse::<f64>().unwrap_or(30.0).round() as u32
    };
    
    Ok((width, height, duration_ms, fps))
}

/// Create a minimal project.json for a migrated video.
fn create_migration_project_json(
    id: &str,
    width: u32,
    height: u32,
    duration_ms: u64,
    fps: u32,
    folder_path: &PathBuf,
) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    let has_webcam = folder_path.join("webcam.mp4").exists();
    let has_cursor = folder_path.join("cursor.json").exists();
    
    // Use serde_json to create a proper VideoProject-compatible JSON
    let sources = serde_json::json!({
        "screenVideo": "screen.mp4",
        "webcamVideo": if has_webcam { Some("webcam.mp4") } else { None::<&str> },
        "cursorData": if has_cursor { Some("cursor.json") } else { None::<&str> },
        "audioFile": null,
        "systemAudio": null,
        "microphoneAudio": null,
        "backgroundMusic": null,
        "originalWidth": width,
        "originalHeight": height,
        "durationMs": duration_ms,
        "fps": fps
    });
    
    let project = serde_json::json!({
        "id": format!("proj_migrated_{}", id),
        "createdAt": now,
        "updatedAt": now,
        "name": id,
        "sources": sources,
        "timeline": {
            "durationMs": duration_ms,
            "inPoint": 0,
            "outPoint": duration_ms,
            "speed": 1.0
        },
        "zoom": {
            "mode": "auto",
            "autoZoomScale": 2.0,
            "regions": []
        },
        "cursor": {
            "visible": true,
            "cursorType": "auto",
            "scale": 1.0,
            "smoothMovement": true,
            "animationStyle": "mellow",
            "tension": 120.0,
            "mass": 1.1,
            "friction": 18.0,
            "motionBlur": 0.0,
            "clickHighlight": {
                "enabled": true,
                "color": "#FF6B6B",
                "radius": 30,
                "durationMs": 400,
                "style": "ripple"
            },
            "hideWhenIdle": false,
            "idleTimeoutMs": 3000
        },
        "webcam": {
            "enabled": has_webcam,
            "position": "bottomRight",
            "customX": 0.95,
            "customY": 0.95,
            "size": 0.2,
            "shape": "circle",
            "rounding": 100.0,
            "cornerStyle": "squircle",
            "shadow": 62.5,
            "shadowConfig": { "size": 33.9, "opacity": 44.2, "blur": 10.5 },
            "mirror": false,
            "border": { "enabled": false, "width": 3, "color": "#FFFFFF" },
            "visibilitySegments": []
        },
        "audio": {
            "systemVolume": 1.0,
            "microphoneVolume": 0.9,
            "musicVolume": 0.25,
            "musicFadeInSecs": 2.0,
            "musicFadeOutSecs": 3.0,
            "normalizeOutput": true,
            "systemMuted": false,
            "microphoneMuted": false,
            "musicMuted": false
        },
        "export": {
            "preset": "standard",
            "format": "mp4",
            "resolution": "original",
            "quality": 80,
            "fps": 30,
            "aspectRatio": "auto",
            "background": {
                "bgType": "solid",
                "solidColor": "#000000",
                "gradientStart": "#1a1a2e",
                "gradientEnd": "#16213e",
                "gradientAngle": 135.0
            }
        },
        "scene": {
            "segments": [],
            "defaultMode": "default"
        },
        "text": {
            "segments": []
        }
    });
    
    serde_json::to_string_pretty(&project).unwrap_or_else(|_| "{}".to_string())
}

#[derive(Debug, Serialize)]
pub struct StartupCleanupResult {
    pub temp_files_cleaned: u32,
    pub thumbnails_regenerated: u32,
}

/// Import an image from a file path (used for drag-drop import)
#[command]
pub async fn import_image_from_path(
    app: AppHandle,
    file_path: String,
) -> Result<SaveCaptureResponse, String> {
    let path = PathBuf::from(&file_path);

    // Verify file exists and is an image
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let valid_extensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    if !valid_extensions.contains(&extension.as_str()) {
        return Err(format!("Unsupported image format: {}", extension));
    }

    // Load image directly from file
    let image = image::open(&path)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let (width, height) = image.dimensions();

    let base_dir = ensure_directories(&app)?;
    let captures_dir = get_captures_dir(&app)?;
    let id = generate_id();
    let now = Utc::now();

    let date_str = now.format("%Y-%m-%d_%H%M%S").to_string();
    let original_filename = format!("{}_{}.png", date_str, &id);
    let thumbnail_filename = format!("{}_thumb.png", &id);

    // Save as PNG to user's configured directory
    let original_path = captures_dir.join(&original_filename);
    image
        .save(&original_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    // Generate and save thumbnail
    let thumbnail = generate_thumbnail(&image)?;
    let thumbnails_dir = base_dir.join("thumbnails");
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
    thumbnail
        .save(&thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    // Create project data
    let project = CaptureProject {
        id: id.clone(),
        created_at: now,
        updated_at: now,
        capture_type: "import".to_string(),
        source: CaptureSource {
            monitor: None,
            window_id: None,
            window_title: None,
            region: None,
        },
        original_image: original_path.to_string_lossy().to_string(),
        dimensions: Dimensions { width, height },
        annotations: Vec::new(),
        tags: Vec::new(),
        favorite: false,
    };

    // Save project file
    let projects_dir = base_dir.join("projects");
    let project_dir = projects_dir.join(&id);
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project dir: {}", e))?;

    let project_file = project_dir.join("project.json");
    let project_json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    fs::write(&project_file, project_json)
        .map_err(|e| format!("Failed to write project file: {}", e))?;

    Ok(SaveCaptureResponse {
        id,
        project,
        thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
        image_path: original_path.to_string_lossy().to_string(),
    })
}

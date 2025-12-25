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

const THUMBNAIL_SIZE: u32 = 200;

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
#[allow(dead_code)]
fn find_ffprobe() -> Option<PathBuf> {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureSource {
    pub monitor: Option<u32>,
    pub window_id: Option<u32>,
    pub window_title: Option<String>,
    pub region: Option<Region>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    #[serde(flatten)]
    pub properties: serde_json::Value,
}

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

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureListItem {
    pub id: String,
    pub created_at: DateTime<Utc>,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveCaptureRequest {
    pub image_data: String,
    pub capture_type: String,
    pub source: CaptureSource,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveCaptureResponse {
    pub id: String,
    pub project: CaptureProject,
    pub thumbnail_path: String,
    pub image_path: String,
}

#[derive(Debug, Serialize)]
pub struct StorageStats {
    pub total_size_bytes: u64,
    pub total_size_mb: f64,
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
        .unwrap()
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

    // Clean up the temporary RGBA file
    let _ = fs::remove_file(&file_path);

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

#[command]
pub async fn get_capture_list(app: AppHandle) -> Result<Vec<CaptureListItem>, String> {
    let base_dir = get_app_data_dir(&app)?;
    let projects_dir = base_dir.join("projects");
    let thumbnails_dir = base_dir.join("thumbnails");
    let captures_dir = get_captures_dir(&app)?;

    let mut captures: Vec<CaptureListItem> = Vec::new();

    // 1. Load screenshot projects
    if projects_dir.exists() {
        let entries =
            fs::read_dir(&projects_dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();

            if path.is_dir() {
                let project_file = path.join("project.json");
                if project_file.exists() {
                    if let Ok(content) = fs::read_to_string(&project_file) {
                        if let Ok(project) = serde_json::from_str::<CaptureProject>(&content) {
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
                            let is_missing = !image_path_buf.exists();

                            captures.push(CaptureListItem {
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
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. Scan for video/GIF recordings in the captures directory
    if captures_dir.exists() {
        if let Ok(entries) = fs::read_dir(&captures_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let extension = path.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase());
                    
                    // Check for video/gif files
                    if let Some(ext) = extension {
                        if ext == "mp4" || ext == "gif" {
                            // Get file metadata for timestamps
                            if let Ok(metadata) = fs::metadata(&path) {
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
                                
                                let capture_type = if ext == "gif" { "gif" } else { "video" };
                                
                                // Generate thumbnail if missing
                                let thumbnail_filename = format!("{}_thumb.png", &id);
                                let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);
                                
                                if !thumbnail_path.exists() {
                                    // Generate thumbnail in background to avoid blocking UI
                                    let video_path = path.clone();
                                    let thumb_path = thumbnail_path.clone();
                                    let is_gif = ext == "gif";
                                    std::thread::spawn(move || {
                                        if is_gif {
                                            match generate_gif_thumbnail(&video_path, &thumb_path) {
                                                Ok(()) => println!("[THUMB] GIF OK: {:?}", thumb_path),
                                                Err(e) => println!("[THUMB] GIF FAILED: {}", e),
                                            }
                                        } else {
                                            match generate_video_thumbnail(&video_path, &thumb_path) {
                                                Ok(()) => println!("[THUMB] Video OK: {:?}", thumb_path),
                                                Err(e) => println!("[THUMB] Video FAILED: {}", e),
                                            }
                                        }
                                    });
                                }
                                
                                let thumbnail_path_str = if thumbnail_path.exists() {
                                    thumbnail_path.to_string_lossy().to_string()
                                } else {
                                    String::new()
                                };
                                
                                // Skip video dimension fetching on startup for faster load
                                // Dimensions will be 0x0 until video is opened
                                // This avoids blocking ffprobe calls for each video
                                let dimensions = Dimensions { width: 0, height: 0 };
                                
                                captures.push(CaptureListItem {
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
                                });
                            }
                        }
                    }
                }
            }
        }
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

#[command]
pub async fn delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let base_dir = get_app_data_dir(&app)?;

    let project_dir = base_dir.join("projects").join(&project_id);
    let project_file = project_dir.join("project.json");

    if project_file.exists() {
        if let Ok(content) = fs::read_to_string(&project_file) {
            if let Ok(project) = serde_json::from_str::<CaptureProject>(&content) {
                // Handle both old format (filename only) and new format (full path)
                let original_path = PathBuf::from(&project.original_image);
                let image_path = if original_path.is_absolute() {
                    original_path
                } else {
                    base_dir.join("captures").join(&project.original_image)
                };
                let _ = fs::remove_file(image_path);
            }
        }
    }

    let thumbnail_path = base_dir
        .join("thumbnails")
        .join(format!("{}_thumb.png", &project_id));
    let _ = fs::remove_file(thumbnail_path);

    if project_dir.exists() {
        fs::remove_dir_all(&project_dir)
            .map_err(|e| format!("Failed to delete project: {}", e))?;
    }

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

/// Startup cleanup: ensure directories exist, remove orphan temp files and regenerate missing thumbnails
/// Returns immediately and runs heavy work in background thread to avoid blocking UI
#[command]
pub async fn startup_cleanup(app: AppHandle) -> Result<StartupCleanupResult, String> {
    // 0. Pre-create storage directories so first capture isn't slow (fast, do sync)
    ensure_directories(&app)?;

    // Also pre-create the user's save directory (Pictures/SnapIt or custom)
    let _ = get_captures_dir(&app);

    // Get paths for background work
    let base_dir = get_app_data_dir(&app)?;
    let projects_dir = base_dir.join("projects");
    let thumbnails_dir = base_dir.join("thumbnails");
    let temp_dir = std::env::temp_dir();

    // Spawn background thread for heavy cleanup work (don't block UI)
    std::thread::spawn(move || {
        let mut temp_files_cleaned = 0;
        let mut thumbnails_regenerated = 0;

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

        // 2. Regenerate missing thumbnails
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

        log::debug!(
            "Startup cleanup complete: {} temp files, {} thumbnails",
            temp_files_cleaned,
            thumbnails_regenerated
        );
    });

    // Return immediately - cleanup runs in background
    Ok(StartupCleanupResult {
        temp_files_cleaned: 0, // Actual count determined in background
        thumbnails_regenerated: 0,
    })
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

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

const THUMBNAIL_SIZE: u32 = 200;

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
    pub has_annotations: bool,
    pub tags: Vec<String>,
    pub favorite: bool,
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
    let base_dir = get_app_data_dir(&app)?;
    let captures_dir = base_dir.join("captures");
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

    // Save original image
    let captures_dir = base_dir.join("captures");
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
        capture_type: request.capture_type,
        source: request.source,
        original_image: original_filename,
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

    Ok(SaveCaptureResponse { id, project })
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

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut captures: Vec<CaptureListItem> = Vec::new();

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

                        captures.push(CaptureListItem {
                            id: project.id,
                            created_at: project.created_at,
                            updated_at: project.updated_at,
                            capture_type: project.capture_type,
                            dimensions: project.dimensions,
                            thumbnail_path,
                            has_annotations: !project.annotations.is_empty(),
                            tags: project.tags,
                            favorite: project.favorite,
                        });
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

    let image_path = base_dir.join("captures").join(&project.original_image);
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
                let image_path = base_dir.join("captures").join(&project.original_image);
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

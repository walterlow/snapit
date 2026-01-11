//! Video editor window commands.
//!
//! Each video opens in its own dedicated window for faster switching
//! between projects. Windows are tracked by project path to prevent duplicates.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{command, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Video editor window label prefix
const VIDEO_EDITOR_LABEL_PREFIX: &str = "video-editor-";

/// Track open video editor windows by project path
/// Maps: project_path -> window_label
static OPEN_EDITORS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn get_editors() -> std::sync::MutexGuard<'static, Option<HashMap<String, String>>> {
    let mut guard = OPEN_EDITORS.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

/// Generate a unique window label for a new video editor
fn generate_window_label() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!("{}{}", VIDEO_EDITOR_LABEL_PREFIX, timestamp)
}

/// Show or create a video editor window for the given project path.
/// If a window for this project already exists, focus it instead.
#[command]
pub async fn show_video_editor_window(
    app: AppHandle,
    project_path: String,
) -> Result<String, String> {
    let mut editors = get_editors();
    let editors_map = editors.as_mut().unwrap();

    // Check if a window for this project already exists
    if let Some(existing_label) = editors_map.get(&project_path) {
        if let Some(window) = app.get_webview_window(existing_label) {
            // Window exists - focus it
            window
                .show()
                .map_err(|e| format!("Failed to show window: {}", e))?;
            window
                .set_focus()
                .map_err(|e| format!("Failed to focus window: {}", e))?;
            return Ok(existing_label.clone());
        } else {
            // Window was closed but not cleaned up - remove from tracking
            editors_map.remove(&project_path);
        }
    }

    // Create new window
    let label = generate_window_label();

    // Pass project path via URL query parameter for immediate availability
    let encoded_path = urlencoding::encode(&project_path);
    let url = WebviewUrl::App(format!("video-editor.html?path={}", encoded_path).into());

    // Extract filename for window title
    let filename = std::path::Path::new(&project_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Video Editor");

    let window = WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("{} - SnapIt", filename))
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .maximizable(true)
        .transparent(true)
        .decorations(false)
        .always_on_top(false)
        .skip_taskbar(false)
        .shadow(true)
        .center()
        .visible(false) // Hidden until frontend is ready
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to create video editor window: {}", e))?;

    // Track the window
    editors_map.insert(project_path.clone(), label.clone());

    // Show the window - project path is in URL query params
    let _ = window.show();

    Ok(label)
}

/// Close a video editor window by its label.
#[command]
pub async fn close_video_editor_window(app: AppHandle, label: String) -> Result<(), String> {
    // Remove from tracking
    let mut editors = get_editors();
    let editors_map = editors.as_mut().unwrap();

    // Find and remove by label
    let project_path = editors_map
        .iter()
        .find(|(_, v)| **v == label)
        .map(|(k, _)| k.clone());

    if let Some(path) = project_path {
        editors_map.remove(&path);
    }

    // Close the window
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|e| format!("Failed to close window: {}", e))?;
    }

    Ok(())
}

/// Get the project path for a video editor window.
#[command]
pub fn get_video_editor_project_path(label: String) -> Option<String> {
    let editors = get_editors();
    let editors_map = editors.as_ref().unwrap();

    editors_map
        .iter()
        .find(|(_, v)| **v == label)
        .map(|(k, _)| k.clone())
}

/// Clean up tracking when a video editor window is closed.
/// Called from window close event handler.
pub fn on_video_editor_closed(label: &str) {
    if !label.starts_with(VIDEO_EDITOR_LABEL_PREFIX) {
        return;
    }

    let mut editors = get_editors();
    let editors_map = editors.as_mut().unwrap();

    // Find and remove by label
    let project_path = editors_map
        .iter()
        .find(|(_, v)| v.as_str() == label)
        .map(|(k, _)| k.clone());

    if let Some(path) = project_path {
        editors_map.remove(&path);
        log::info!("Cleaned up video editor window: {} ({})", label, path);
    }
}

/// Check if a label belongs to a video editor window.
pub fn is_video_editor_window(label: &str) -> bool {
    label.starts_with(VIDEO_EDITOR_LABEL_PREFIX)
}

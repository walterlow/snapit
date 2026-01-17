//! Image editor window commands.
//!
//! Each image opens in its own dedicated window for faster switching
//! between projects. Windows are tracked by capture path to prevent duplicates.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{command, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Image editor window label prefix
const IMAGE_EDITOR_LABEL_PREFIX: &str = "image-editor-";

/// Track open image editor windows by capture path
/// Maps: capture_path -> window_label
static OPEN_EDITORS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn get_editors() -> std::sync::MutexGuard<'static, Option<HashMap<String, String>>> {
    let mut guard = OPEN_EDITORS.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

/// Generate a unique window label for a new image editor
fn generate_window_label() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!("{}{}", IMAGE_EDITOR_LABEL_PREFIX, timestamp)
}

/// Show or create an image editor window for the given capture path.
/// If a window for this capture already exists, focus it instead.
#[command]
pub async fn show_image_editor_window(
    app: AppHandle,
    capture_path: String,
) -> Result<String, String> {
    let mut editors = get_editors();
    let editors_map = editors.as_mut().unwrap();

    // Check if a window for this capture already exists
    if let Some(existing_label) = editors_map.get(&capture_path) {
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
            editors_map.remove(&capture_path);
        }
    }

    // Create new window
    let label = generate_window_label();

    // Pass capture path via URL query parameter for immediate availability
    let encoded_path = urlencoding::encode(&capture_path);
    let url = WebviewUrl::App(format!("windows/image-editor.html?path={}", encoded_path).into());

    // Extract filename for window title
    let filename = std::path::Path::new(&capture_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Image Editor");

    let window = WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("{} - SnapIt", filename))
        .inner_size(1200.0, 800.0)
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
        .map_err(|e| format!("Failed to create image editor window: {}", e))?;

    // Track the window
    editors_map.insert(capture_path.clone(), label.clone());

    // Show the window - capture path is in URL query params
    let _ = window.show();

    Ok(label)
}

/// Close an image editor window by its label.
#[command]
pub async fn close_image_editor_window(app: AppHandle, label: String) -> Result<(), String> {
    // Remove from tracking
    let mut editors = get_editors();
    let editors_map = editors.as_mut().unwrap();

    // Find and remove by label
    let capture_path = editors_map
        .iter()
        .find(|(_, v)| **v == label)
        .map(|(k, _)| k.clone());

    if let Some(path) = capture_path {
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

/// Get the capture path for an image editor window.
#[command]
pub fn get_image_editor_capture_path(label: String) -> Option<String> {
    let editors = get_editors();
    let editors_map = editors.as_ref().unwrap();

    editors_map
        .iter()
        .find(|(_, v)| **v == label)
        .map(|(k, _)| k.clone())
}

/// Clean up tracking when an image editor window is closed.
/// Called from window close event handler.
pub fn on_image_editor_closed(label: &str) {
    if !label.starts_with(IMAGE_EDITOR_LABEL_PREFIX) {
        return;
    }

    let mut editors = get_editors();
    let editors_map = editors.as_mut().unwrap();

    // Find and remove by label
    let capture_path = editors_map
        .iter()
        .find(|(_, v)| v.as_str() == label)
        .map(|(k, _)| k.clone());

    if let Some(path) = capture_path {
        editors_map.remove(&path);
        log::info!("Cleaned up image editor window: {} ({})", label, path);
    }
}

/// Check if a label belongs to an image editor window.
pub fn is_image_editor_window(label: &str) -> bool {
    label.starts_with(IMAGE_EDITOR_LABEL_PREFIX)
}

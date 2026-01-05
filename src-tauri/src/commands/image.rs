use image::GenericImageView;
use tauri::{command, image::Image as TauriImage, AppHandle};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Copy image from file path to clipboard
#[command]
pub async fn copy_image_to_clipboard(app: AppHandle, path: String) -> Result<(), String> {
    // Read the image file
    let image = image::open(&path).map_err(|e| format!("Failed to open image: {}", e))?;

    let (width, height) = image.dimensions();
    let rgba = image.to_rgba8();
    let raw_data = rgba.into_raw();

    // Create a Tauri Image from the RGBA data
    let tauri_image = TauriImage::new_owned(raw_data, width, height);

    app.clipboard()
        .write_image(&tauri_image)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    Ok(())
}

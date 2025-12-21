use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, GenericImageView, Rgba, RgbaImage};
use serde::Deserialize;
use std::io::Cursor;
use tauri::{command, image::Image as TauriImage, AppHandle};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Deserialize)]
pub struct BlurRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub intensity: u32,
}

#[command]
pub async fn save_image(image_data: String, file_path: String, format: String) -> Result<(), String> {
    let decoded = STANDARD
        .decode(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let image = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let img_format = match format.to_lowercase().as_str() {
        "png" => image::ImageFormat::Png,
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        "gif" => image::ImageFormat::Gif,
        _ => image::ImageFormat::Png,
    };

    image
        .save_with_format(&file_path, img_format)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(())
}

/// Copy image to clipboard from base64 PNG (legacy, slower)
#[command]
pub async fn copy_to_clipboard(app: AppHandle, image_data: String) -> Result<(), String> {
    let decoded = STANDARD
        .decode(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Load the image to get its dimensions and RGBA data
    let img = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    let (width, height) = img.dimensions();
    let rgba = img.to_rgba8();
    let raw_data = rgba.into_raw();

    // Create a Tauri Image from the RGBA data
    let tauri_image = TauriImage::new_owned(raw_data, width, height);

    app.clipboard()
        .write_image(&tauri_image)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    Ok(())
}

/// Copy raw RGBA image data directly to clipboard (fast path)
/// Skips PNG encode/decode - much faster for large images
#[command]
pub async fn copy_rgba_to_clipboard(
    app: AppHandle,
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Validate data size
    let expected_size = (width * height * 4) as usize;
    if rgba_data.len() != expected_size {
        return Err(format!(
            "Invalid RGBA data size: expected {}, got {}",
            expected_size,
            rgba_data.len()
        ));
    }

    // Create Tauri Image directly from RGBA data - no encoding/decoding
    let tauri_image = TauriImage::new_owned(rgba_data, width, height);

    app.clipboard()
        .write_image(&tauri_image)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    Ok(())
}

#[command]
pub async fn crop_image(
    image_data: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let decoded = STANDARD
        .decode(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let image = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let cropped = image.crop_imm(x, y, width, height);

    let mut buffer = Cursor::new(Vec::new());
    cropped
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    Ok(STANDARD.encode(buffer.get_ref()))
}

#[command]
pub async fn apply_blur_region(
    image_data: String,
    regions: Vec<BlurRegion>,
) -> Result<String, String> {
    let decoded = STANDARD
        .decode(&image_data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let mut image = image::load_from_memory(&decoded)
        .map_err(|e| format!("Failed to load image: {}", e))?
        .to_rgba8();

    for region in regions {
        pixelate_region(&mut image, region);
    }

    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    Ok(STANDARD.encode(buffer.get_ref()))
}

fn pixelate_region(image: &mut RgbaImage, region: BlurRegion) {
    let pixel_size = region.intensity.max(2) as usize;

    let (img_width, img_height) = image.dimensions();
    let end_x = (region.x + region.width).min(img_width);
    let end_y = (region.y + region.height).min(img_height);

    let mut y = region.y as usize;
    while y < end_y as usize {
        let mut x = region.x as usize;
        while x < end_x as usize {
            let mut r_sum: u32 = 0;
            let mut g_sum: u32 = 0;
            let mut b_sum: u32 = 0;
            let mut a_sum: u32 = 0;
            let mut count: u32 = 0;

            for by in y..(y + pixel_size).min(end_y as usize) {
                for bx in x..(x + pixel_size).min(end_x as usize) {
                    let pixel = image.get_pixel(bx as u32, by as u32);
                    r_sum += pixel[0] as u32;
                    g_sum += pixel[1] as u32;
                    b_sum += pixel[2] as u32;
                    a_sum += pixel[3] as u32;
                    count += 1;
                }
            }

            if count > 0 {
                let avg_color = Rgba([
                    (r_sum / count) as u8,
                    (g_sum / count) as u8,
                    (b_sum / count) as u8,
                    (a_sum / count) as u8,
                ]);

                for by in y..(y + pixel_size).min(end_y as usize) {
                    for bx in x..(x + pixel_size).min(end_x as usize) {
                        image.put_pixel(bx as u32, by as u32, avg_color);
                    }
                }
            }

            x += pixel_size;
        }
        y += pixel_size;
    }
}

//! Font loading commands using font-kit.
//!
//! font-kit provides cross-platform font loading using native APIs:
//! - Windows: DirectWrite
//! - macOS: Core Text
//! - Linux: Fontconfig

use font_kit::family_name::FamilyName;
use font_kit::properties::{Properties, Style, Weight};
use font_kit::source::SystemSource;
use std::collections::HashSet;

/// Get list of installed system fonts (only fonts that can actually be loaded)
#[tauri::command]
pub fn get_system_fonts() -> Result<Vec<String>, String> {
    let source = SystemSource::new();

    let families = source
        .all_families()
        .map_err(|e| format!("Failed to get font families: {}", e))?;

    // Filter to only fonts we can actually load
    let mut valid_fonts: Vec<String> = Vec::new();

    for name in families {
        // Skip internal/symbol fonts
        if name.starts_with('@') || name.starts_with('.') || name.is_empty() {
            continue;
        }

        // Try to actually load the font - only include if it works
        let props = Properties::new();
        if let Ok(handle) = source.select_best_match(&[FamilyName::Title(name.clone())], &props) {
            if let Ok(font) = handle.load() {
                // Verify we can get font data
                if font.copy_font_data().is_some() {
                    valid_fonts.push(name);
                }
            }
        }
    }

    valid_fonts.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(valid_fonts)
}

/// Get font file data for a given font family name, weight, and style
#[tauri::command]
pub fn get_font_data(
    family: String,
    weight: Option<u32>,
    italic: Option<bool>,
) -> Result<Vec<u8>, String> {
    let source = SystemSource::new();

    // Build font properties
    let mut props = Properties::new();

    // Set weight (default 400 = normal)
    let weight_value = weight.unwrap_or(400);
    props.weight = Weight(weight_value as f32);

    // Set style
    if italic.unwrap_or(false) {
        props.style = Style::Italic;
    }

    // Try to find the font
    let handle = source
        .select_best_match(&[FamilyName::Title(family.clone())], &props)
        .map_err(|e| format!("Font '{}' not found: {}", family, e))?;

    // Load the font and get its data
    let font = handle
        .load()
        .map_err(|e| format!("Failed to load font '{}': {}", family, e))?;

    // Get font data - font-kit provides this directly
    let font_data = font
        .copy_font_data()
        .ok_or_else(|| format!("Failed to get font data for '{}'", family))?;

    // Log what we got
    log::debug!(
        "Font '{}': requested weight={} italic={} -> loaded successfully ({} bytes)",
        family,
        weight_value,
        italic.unwrap_or(false),
        font_data.len()
    );

    Ok((*font_data).clone())
}

/// Get available font weights for a font family
#[tauri::command]
pub fn get_font_weights(family: String) -> Result<Vec<u32>, String> {
    let source = SystemSource::new();

    // Get all fonts in the family
    let family_handle = source
        .select_family_by_name(&family)
        .map_err(|e| format!("Font family '{}' not found: {}", family, e))?;

    let fonts = family_handle.fonts();

    // Collect unique weights
    let mut weights: HashSet<u32> = HashSet::new();

    for handle in fonts {
        if let Ok(font) = handle.load() {
            let props = font.properties();
            // Round weight to nearest 100
            let weight = ((props.weight.0 as u32 + 50) / 100) * 100;
            weights.insert(weight.clamp(100, 900));
        }
    }

    // If no weights found, return common defaults
    if weights.is_empty() {
        return Ok(vec![400, 700]);
    }

    let mut result: Vec<u32> = weights.into_iter().collect();
    result.sort();
    Ok(result)
}

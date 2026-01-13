use std::collections::HashSet;

/// Get list of installed system fonts
#[tauri::command]
pub fn get_system_fonts() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        get_windows_fonts()
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Fallback for non-Windows platforms
        Ok(get_fallback_fonts())
    }
}

#[cfg(target_os = "windows")]
fn get_windows_fonts() -> Result<Vec<String>, String> {
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, DWRITE_FACTORY_TYPE_SHARED,
    };

    unsafe {
        // Create DirectWrite factory
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|e| format!("Failed to create DirectWrite factory: {}", e))?;

        // Get system font collection
        let mut font_collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut font_collection, false)
            .map_err(|e| format!("Failed to get system font collection: {}", e))?;

        let font_collection =
            font_collection.ok_or_else(|| "Font collection is null".to_string())?;

        let family_count = font_collection.GetFontFamilyCount();
        let mut font_names: HashSet<String> = HashSet::new();

        for i in 0..family_count {
            if let Ok(font_family) = font_collection.GetFontFamily(i) {
                if let Ok(family_names) = font_family.GetFamilyNames() {
                    // Get the first localized name (usually English)
                    if let Ok(length) = family_names.GetStringLength(0) {
                        let mut name_buffer: Vec<u16> = vec![0; (length + 1) as usize];
                        if family_names.GetString(0, &mut name_buffer).is_ok() {
                            let name = String::from_utf16_lossy(&name_buffer)
                                .trim_end_matches('\0')
                                .to_string();
                            if !name.is_empty() && !name.starts_with('@') {
                                font_names.insert(name);
                            }
                        }
                    }
                }
            }
        }

        let mut fonts: Vec<String> = font_names.into_iter().collect();
        fonts.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        Ok(fonts)
    }
}

#[cfg(not(target_os = "windows"))]
fn get_fallback_fonts() -> Vec<String> {
    vec![
        "system-ui".to_string(),
        "Arial".to_string(),
        "Helvetica".to_string(),
        "Georgia".to_string(),
        "Times New Roman".to_string(),
        "Courier New".to_string(),
        "Verdana".to_string(),
    ]
}

/// Get font file data for a given font family name and weight
#[tauri::command]
pub fn get_font_data(family: String, weight: Option<u32>) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        get_windows_font_data(&family, weight.unwrap_or(400))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(format!("Font loading not supported on this platform"))
    }
}

/// Get available font weights for a font family
#[tauri::command]
pub fn get_font_weights(family: String) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "windows")]
    {
        get_windows_font_weights(&family)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Fallback: return common weights
        Ok(vec![400, 700])
    }
}

#[cfg(target_os = "windows")]
fn get_windows_font_weights(family: &str) -> Result<Vec<u32>, String> {
    use std::collections::BTreeSet;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, DWRITE_FACTORY_TYPE_SHARED,
        DWRITE_FONT_SIMULATIONS_NONE,
    };

    unsafe {
        // Create DirectWrite factory
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|e| format!("Failed to create DirectWrite factory: {}", e))?;

        // Get system font collection
        let mut font_collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut font_collection, false)
            .map_err(|e| format!("Failed to get system font collection: {}", e))?;

        let font_collection =
            font_collection.ok_or_else(|| "Font collection is null".to_string())?;

        // Find the font family by name
        let family_wide: Vec<u16> = family.encode_utf16().chain(std::iter::once(0)).collect();
        let mut index: u32 = 0;
        let mut exists = windows::Win32::Foundation::BOOL::default();

        font_collection
            .FindFamilyName(
                windows::core::PCWSTR(family_wide.as_ptr()),
                &mut index,
                &mut exists,
            )
            .map_err(|e| format!("Failed to find font family: {}", e))?;

        if !exists.as_bool() {
            return Err(format!("Font family '{}' not found", family));
        }

        // Get the font family
        let font_family = font_collection
            .GetFontFamily(index)
            .map_err(|e| format!("Failed to get font family: {}", e))?;

        // Iterate through all fonts in the family and collect unique weights
        // Only include fonts that are NOT simulated (actual font files)
        let font_count = font_family.GetFontCount();
        let mut weights: BTreeSet<u32> = BTreeSet::new();

        for i in 0..font_count {
            if let Ok(font) = font_family.GetFont(i) {
                // Skip simulated fonts (synthesized bold/italic)
                let simulations = font.GetSimulations();
                if simulations != DWRITE_FONT_SIMULATIONS_NONE {
                    continue;
                }

                let weight = font.GetWeight().0 as u32;
                // Round to nearest 100 for standard weight values
                let rounded_weight = ((weight + 50) / 100) * 100;
                weights.insert(rounded_weight.clamp(100, 900));
            }
        }

        Ok(weights.into_iter().collect())
    }
}

#[cfg(target_os = "windows")]
fn get_windows_font_data(family: &str, target_weight: u32) -> Result<Vec<u8>, String> {
    use std::fs;
    use windows::core::Interface;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteFontFile,
        IDWriteLocalFontFileLoader, DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STYLE_NORMAL,
    };

    unsafe {
        // Create DirectWrite factory
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|e| format!("Failed to create DirectWrite factory: {}", e))?;

        // Get system font collection
        let mut font_collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut font_collection, false)
            .map_err(|e| format!("Failed to get system font collection: {}", e))?;

        let font_collection =
            font_collection.ok_or_else(|| "Font collection is null".to_string())?;

        // Find the font family by name
        let family_wide: Vec<u16> = family.encode_utf16().chain(std::iter::once(0)).collect();
        let mut index: u32 = 0;
        let mut exists = windows::Win32::Foundation::BOOL::default();

        font_collection
            .FindFamilyName(
                windows::core::PCWSTR(family_wide.as_ptr()),
                &mut index,
                &mut exists,
            )
            .map_err(|e| format!("Failed to find font family: {}", e))?;

        if !exists.as_bool() {
            return Err(format!("Font family '{}' not found", family));
        }

        // Get the font family
        let font_family = font_collection
            .GetFontFamily(index)
            .map_err(|e| format!("Failed to get font family: {}", e))?;

        // Find the font with the closest matching weight from the family
        let font_count = font_family.GetFontCount();
        let mut best_font = None;
        let mut best_weight_diff = u32::MAX;

        for i in 0..font_count {
            if let Ok(font) = font_family.GetFont(i) {
                let font_weight = font.GetWeight().0 as u32;
                let diff = (font_weight as i32 - target_weight as i32).unsigned_abs();
                if diff < best_weight_diff {
                    best_weight_diff = diff;
                    best_font = Some(font);
                }
            }
        }

        let font = best_font.ok_or_else(|| format!("No fonts found in family '{}'", family))?;

        // Log actual vs requested weight for debugging
        let actual_weight = font.GetWeight().0 as u32;
        if actual_weight != target_weight {
            log::debug!(
                "Font '{}': requested weight {} -> actual weight {}",
                family,
                target_weight,
                actual_weight
            );
        }

        // Create font face
        let font_face = font
            .CreateFontFace()
            .map_err(|e| format!("Failed to create font face: {}", e))?;

        // Get font files
        let mut file_count: u32 = 0;
        font_face
            .GetFiles(&mut file_count, None)
            .map_err(|e| format!("Failed to get font file count: {}", e))?;

        if file_count == 0 {
            return Err("No font files found".to_string());
        }

        let mut font_files: Vec<Option<IDWriteFontFile>> = vec![None; file_count as usize];
        font_face
            .GetFiles(&mut file_count, Some(font_files.as_mut_ptr()))
            .map_err(|e| format!("Failed to get font files: {}", e))?;

        let font_file = font_files[0]
            .take()
            .ok_or_else(|| "Font file is null".to_string())?;

        // Get the font file loader
        let loader = font_file
            .GetLoader()
            .map_err(|e| format!("Failed to get font file loader: {}", e))?;

        // Try to cast to local file loader
        let local_loader: IDWriteLocalFontFileLoader = loader
            .cast()
            .map_err(|_| "Font is not a local file".to_string())?;

        // Get the file reference key
        let mut key_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut key_size: u32 = 0;
        font_file
            .GetReferenceKey(&mut key_ptr, &mut key_size)
            .map_err(|e| format!("Failed to get reference key: {}", e))?;

        // Get the file path length
        let path_length = local_loader
            .GetFilePathLengthFromKey(key_ptr as *const _, key_size)
            .map_err(|e| format!("Failed to get file path length: {}", e))?;

        // Get the file path
        let mut path_buffer: Vec<u16> = vec![0; (path_length + 1) as usize];
        local_loader
            .GetFilePathFromKey(key_ptr as *const _, key_size, &mut path_buffer)
            .map_err(|e| format!("Failed to get file path: {}", e))?;

        let path = String::from_utf16_lossy(&path_buffer)
            .trim_end_matches('\0')
            .to_string();

        // Read the font file
        let font_data =
            fs::read(&path).map_err(|e| format!("Failed to read font file '{}': {}", path, e))?;

        Ok(font_data)
    }
}

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

        let font_collection = font_collection
            .ok_or_else(|| "Font collection is null".to_string())?;

        let family_count = font_collection.GetFontFamilyCount();
        let mut font_names: HashSet<String> = HashSet::new();

        for i in 0..family_count {
            if let Ok(font_family) = font_collection.GetFontFamily(i) {
                if let Ok(family_names) = font_family.GetFamilyNames() {
                    // Get the first localized name (usually English)
                    if let Ok(length) = family_names.GetStringLength(0) {
                        let mut name_buffer: Vec<u16> = vec![0; (length + 1) as usize];
                        if family_names
                            .GetString(0, &mut name_buffer)
                            .is_ok()
                        {
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

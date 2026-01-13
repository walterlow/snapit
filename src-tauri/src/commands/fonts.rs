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

/// Get font file data for a given font family name
#[tauri::command]
pub fn get_font_data(family: String) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "windows")]
    {
        get_windows_font_data(&family)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(format!("Font loading not supported on this platform"))
    }
}

#[cfg(target_os = "windows")]
fn get_windows_font_data(family: &str) -> Result<Vec<u8>, String> {
    use std::fs;
    use windows::core::Interface;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteFontFile,
        IDWriteLocalFontFileLoader, DWRITE_FACTORY_TYPE_SHARED,
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

        // Get the first font in the family (regular weight)
        let font = font_family
            .GetFont(0)
            .map_err(|e| format!("Failed to get font: {}", e))?;

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

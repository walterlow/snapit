use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

#[cfg(desktop)]
use crate::TrayState;

/// Global state for close-to-tray behavior
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Set close-to-tray behavior
#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

/// Check if close-to-tray is enabled
pub fn is_close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::SeqCst)
}

/// Update tray menu item text for a shortcut
#[tauri::command]
pub fn update_tray_shortcut(
    app: tauri::AppHandle,
    shortcut_id: String,
    display_text: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let tray_state = app.state::<Mutex<TrayState>>();
        let tray = tray_state
            .lock()
            .map_err(|e| format!("Failed to lock tray state: {}", e))?;

        match shortcut_id.as_str() {
            "new_capture" => tray
                .update_new_capture_text(&display_text)
                .map_err(|e| format!("Failed to update new capture text: {}", e))?,
            "fullscreen_capture" => tray
                .update_fullscreen_text(&display_text)
                .map_err(|e| format!("Failed to update fullscreen text: {}", e))?,
            "all_monitors_capture" => tray
                .update_all_monitors_text(&display_text)
                .map_err(|e| format!("Failed to update all monitors text: {}", e))?,
            _ => {} // Ignore unknown shortcut IDs
        }
    }

    Ok(())
}

/// Set autostart enabled/disabled
#[tauri::command]
pub async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        
        let autostart_manager = app.autolaunch();
        
        if enabled {
            autostart_manager
                .enable()
                .map_err(|e| format!("Failed to enable autostart: {}", e))?;
        } else {
            autostart_manager
                .disable()
                .map_err(|e| format!("Failed to disable autostart: {}", e))?;
        }
    }
    
    Ok(())
}

/// Check if autostart is enabled
#[tauri::command]
pub async fn is_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        
        let autostart_manager = app.autolaunch();
        autostart_manager
            .is_enabled()
            .map_err(|e| format!("Failed to check autostart status: {}", e))
    }
    
    #[cfg(not(desktop))]
    Ok(false)
}

/// Open file explorer at the given path
#[tauri::command]
pub async fn open_path_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

/// Reveal a file in the file explorer (opens containing folder and selects the file)
#[tauri::command]
pub async fn reveal_file_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Linux doesn't have a standard way to select a file, so open the parent folder
        let path = std::path::Path::new(&path);
        let parent = path.parent().map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

/// Get the default save directory path
#[tauri::command]
pub async fn get_default_save_dir(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .picture_dir()
        .map_err(|e| format!("Failed to get pictures directory: {}", e))?;
    
    let snapit_path = path.join("SnapIt");
    
    // Create the directory if it doesn't exist
    if !snapit_path.exists() {
        std::fs::create_dir_all(&snapit_path)
            .map_err(|e| format!("Failed to create SnapIt directory: {}", e))?;
    }
    
    Ok(snapit_path.to_string_lossy().to_string())
}

/// Get the default save directory path (synchronous version for internal use).
pub fn get_default_save_dir_sync() -> Result<std::path::PathBuf, String> {
    let path = dirs::picture_dir()
        .ok_or_else(|| "Failed to get pictures directory".to_string())?;
    
    let snapit_path = path.join("SnapIt");
    
    // Create the directory if it doesn't exist
    if !snapit_path.exists() {
        std::fs::create_dir_all(&snapit_path)
            .map_err(|e| format!("Failed to create SnapIt directory: {}", e))?;
    }
    
    Ok(snapit_path)
}

/// Open a file with the system's default application
#[tauri::command]
pub async fn open_file_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

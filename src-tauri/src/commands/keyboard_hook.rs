//! Windows Global Hotkey Registration using RegisterHotKey
//!
//! Uses RegisterHotKey API for global shortcuts. This is simpler and more reliable
//! than low-level keyboard hooks for our use case.
//!
//! For PrintScreen specifically, we use IDHOT_SNAPDESKTOP to override the default
//! Windows clipboard behavior.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        Input::KeyboardAndMouse::{
            RegisterHotKey, UnregisterHotKey, 
            MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, HOT_KEY_MODIFIERS,
        },
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, 
            PostQuitMessage, RegisterClassW, TranslateMessage, 
            CS_HREDRAW, CS_VREDRAW, HMENU, MSG, 
            WINDOW_EX_STYLE, WM_DESTROY, WM_HOTKEY, WNDCLASSW, WS_OVERLAPPED,
        },
    },
};

// Virtual key codes
const VK_SNAPSHOT: u32 = 0x2C; // PrintScreen

// Special hotkey IDs for system keys
const IDHOT_SNAPDESKTOP: i32 = -2; // Overrides PrintScreen

#[derive(Clone)]
struct RegisteredHotkey {
    id: String,
    hotkey_id: i32, // Windows hotkey ID
    modifiers: u32,
    key_code: u32,
}

struct HotkeyState {
    hwnd: Option<isize>,
    hotkeys: HashMap<String, RegisteredHotkey>,
    app_handle: Option<AppHandle>,
    running: bool,
    next_id: i32,
}

static HOTKEY_STATE: OnceLock<Arc<Mutex<HotkeyState>>> = OnceLock::new();

fn get_state() -> &'static Arc<Mutex<HotkeyState>> {
    HOTKEY_STATE.get_or_init(|| {
        Arc::new(Mutex::new(HotkeyState {
            hwnd: None,
            hotkeys: HashMap::new(),
            app_handle: None,
            running: false,
            next_id: 1, // Start at 1, reserve negative IDs for special keys
        }))
    })
}

fn parse_shortcut(shortcut: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = shortcut.split('+').map(|s| s.trim()).collect();
    if parts.is_empty() {
        return None;
    }

    let mut modifiers: u32 = 0;

    // Single key (no modifiers)
    if parts.len() == 1 {
        let key = parse_key_code(&parts[0].to_lowercase());
        return if key != 0 { Some((0, key)) } else { None };
    }

    // Modifiers + key
    for part in parts.iter().take(parts.len() - 1) {
        match part.to_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" => modifiers |= MOD_CONTROL.0,
            "alt" => modifiers |= MOD_ALT.0,
            "shift" => modifiers |= MOD_SHIFT.0,
            _ => {}
        }
    }

    let key = parse_key_code(&parts.last()?.to_lowercase());
    if key != 0 {
        Some((modifiers, key))
    } else {
        None
    }
}

fn parse_key_code(key: &str) -> u32 {
    match key {
        "a" => 0x41, "b" => 0x42, "c" => 0x43, "d" => 0x44, "e" => 0x45,
        "f" => 0x46, "g" => 0x47, "h" => 0x48, "i" => 0x49, "j" => 0x4A,
        "k" => 0x4B, "l" => 0x4C, "m" => 0x4D, "n" => 0x4E, "o" => 0x4F,
        "p" => 0x50, "q" => 0x51, "r" => 0x52, "s" => 0x53, "t" => 0x54,
        "u" => 0x55, "v" => 0x56, "w" => 0x57, "x" => 0x58, "y" => 0x59, "z" => 0x5A,
        "0" => 0x30, "1" => 0x31, "2" => 0x32, "3" => 0x33, "4" => 0x34,
        "5" => 0x35, "6" => 0x36, "7" => 0x37, "8" => 0x38, "9" => 0x39,
        "f1" => 0x70, "f2" => 0x71, "f3" => 0x72, "f4" => 0x73, "f5" => 0x74,
        "f6" => 0x75, "f7" => 0x76, "f8" => 0x77, "f9" => 0x78, "f10" => 0x79,
        "f11" => 0x7A, "f12" => 0x7B,
        "space" => 0x20, "enter" | "return" => 0x0D, "escape" | "esc" => 0x1B,
        "tab" => 0x09, "backspace" => 0x08, "delete" => 0x2E, "insert" => 0x2D,
        "home" => 0x24, "end" => 0x23, "pageup" => 0x21, "pagedown" => 0x22,
        "arrowup" | "up" => 0x26, "arrowdown" | "down" => 0x28,
        "arrowleft" | "left" => 0x25, "arrowright" | "right" => 0x27,
        "printscreen" => VK_SNAPSHOT,
        _ => 0,
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    match msg {
        WM_HOTKEY => {
            let hotkey_id = w_param.0 as i32;
            
            // Find the shortcut ID for this hotkey
            if let Ok(state) = get_state().try_lock() {
                for (id, hotkey) in &state.hotkeys {
                    if hotkey.hotkey_id == hotkey_id {
                        if let Some(app) = &state.app_handle {
                            let event_name = format!("shortcut-{}", id);
                            let app_clone = app.clone();
                            
                            // Emit on a separate task to avoid blocking the message loop
                            std::thread::spawn(move || {
                                let _ = app_clone.emit(&event_name, ());
                            });
                        }
                        break;
                    }
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, w_param, l_param),
    }
}

#[cfg(target_os = "windows")]
fn create_message_window() -> Result<HWND, String> {
    unsafe {
        let hinstance = GetModuleHandleW(None)
            .map_err(|e| format!("GetModuleHandleW failed: {}", e))?;

        let class_name = windows::core::w!("SnapItHotkeyClass");

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };

        let atom = RegisterClassW(&wc);
        if atom == 0 {
            // Class might already be registered, which is fine
        }

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            windows::core::w!("SnapIt Hotkey Window"),
            WS_OVERLAPPED,
            0, 0, 0, 0,
            HWND::default(),
            HMENU::default(),
            hinstance,
            None,
        ).map_err(|e| format!("CreateWindowExW failed: {}", e))?;

        if hwnd.0.is_null() {
            return Err("CreateWindowExW returned null HWND".to_string());
        }

        Ok(hwnd)
    }
}

#[cfg(target_os = "windows")]
fn start_message_loop(app: AppHandle) -> Result<(), String> {
    let state = get_state();

    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        if s.running {
            // Already running, just update app handle
            s.app_handle = Some(app);
            return Ok(());
        }
        s.app_handle = Some(app);
        s.running = true;
    }

    let state_clone = state.clone();

    thread::spawn(move || {
        unsafe {
            // Create the message-only window
            match create_message_window() {
                Ok(hwnd) => {
                    if let Ok(mut s) = state_clone.lock() {
                        s.hwnd = Some(hwnd.0 as isize);
                    }

                    // Re-register any pending hotkeys now that we have a window
                    if let Ok(s) = state_clone.lock() {
                        for (_, hotkey) in &s.hotkeys {
                            let _ = if hotkey.key_code == VK_SNAPSHOT && hotkey.modifiers == 0 {
                                // Use IDHOT_SNAPDESKTOP for bare PrintScreen
                                RegisterHotKey(hwnd, IDHOT_SNAPDESKTOP, HOT_KEY_MODIFIERS(0), VK_SNAPSHOT)
                            } else {
                                RegisterHotKey(
                                    hwnd,
                                    hotkey.hotkey_id,
                                    HOT_KEY_MODIFIERS(hotkey.modifiers | MOD_NOREPEAT.0),
                                    hotkey.key_code,
                                )
                            };
                        }
                    }

                    // Message loop
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                Err(_) => {}
            }

            // Cleanup
            if let Ok(mut s) = state_clone.lock() {
                s.hwnd = None;
                s.running = false;
            }
        }
    });

    // Give the thread time to start
    thread::sleep(std::time::Duration::from_millis(50));

    Ok(())
}

#[cfg(target_os = "windows")]
fn register_hotkey_internal(hwnd: HWND, id: &str, hotkey_id: i32, modifiers: u32, key_code: u32) -> Result<(), String> {
    unsafe {
        // For bare PrintScreen, use IDHOT_SNAPDESKTOP to override clipboard behavior
        let (actual_id, actual_mods) = if key_code == VK_SNAPSHOT && modifiers == 0 {
            (IDHOT_SNAPDESKTOP, 0)
        } else {
            (hotkey_id, modifiers | MOD_NOREPEAT.0)
        };

        RegisterHotKey(hwnd, actual_id, HOT_KEY_MODIFIERS(actual_mods), key_code)
            .map_err(|e| format!("RegisterHotKey failed for {}: {}", id, e))?;

        Ok(())
    }
}

#[tauri::command]
pub async fn register_shortcut_with_hook(
    app: AppHandle,
    id: String,
    shortcut: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (modifiers, key) = parse_shortcut(&shortcut)
            .ok_or_else(|| format!("Invalid shortcut: {}", shortcut))?;

        if key == 0 {
            return Err(format!("Unknown key: {}", shortcut));
        }

        // Start the message loop if not running
        start_message_loop(app)?;

        let mut state = get_state().lock().map_err(|e| e.to_string())?;

        // Determine hotkey ID (use IDHOT_SNAPDESKTOP for bare PrintScreen)
        let hotkey_id = if key == VK_SNAPSHOT && modifiers == 0 {
            IDHOT_SNAPDESKTOP
        } else {
            let hid = state.next_id;
            state.next_id += 1;
            hid
        };

        // Remove existing registration if any
        if let Some(old) = state.hotkeys.remove(&id) {
            if let Some(hwnd_val) = state.hwnd {
                let hwnd = HWND(hwnd_val as *mut _);
                unsafe {
                    let _ = UnregisterHotKey(hwnd, old.hotkey_id);
                }
            }
        }

        // Store the hotkey info
        state.hotkeys.insert(id.clone(), RegisteredHotkey {
            id: id.clone(),
            hotkey_id,
            modifiers,
            key_code: key,
        });

        // If we have a window, register immediately
        if let Some(hwnd_val) = state.hwnd {
            let hwnd = HWND(hwnd_val as *mut _);
            register_hotkey_internal(hwnd, &id, hotkey_id, modifiers, key)?;
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, shortcut);
        Err("Only available on Windows".to_string())
    }
}

#[tauri::command]
pub async fn unregister_shortcut_hook(id: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut state = get_state().lock().map_err(|e| e.to_string())?;
        
        if let Some(hotkey) = state.hotkeys.remove(&id) {
            if let Some(hwnd_val) = state.hwnd {
                let hwnd = HWND(hwnd_val as *mut _);
                unsafe {
                    let _ = UnregisterHotKey(hwnd, hotkey.hotkey_id);
                }
            }
        }
        
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = id;
        Ok(())
    }
}

#[tauri::command]
pub async fn unregister_all_hooks() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut state = get_state().lock().map_err(|e| e.to_string())?;
        
        if let Some(hwnd_val) = state.hwnd {
            let hwnd = HWND(hwnd_val as *mut _);
            for hotkey in state.hotkeys.values() {
                unsafe {
                    let _ = UnregisterHotKey(hwnd, hotkey.hotkey_id);
                }
            }
        }
        
        state.hotkeys.clear();
        
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    Ok(())
}

/// Reinstall hotkeys (placeholder for API compatibility)
#[tauri::command]
pub async fn reinstall_hook() -> Result<(), String> {
    // With RegisterHotKey approach, we don't need to reinstall
    // The hotkeys stay registered until we unregister them
    Ok(())
}

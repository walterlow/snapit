//! Desktop icons visibility control for Windows.
//!
//! Hides/shows desktop icons during screen recording to produce cleaner videos.
//! Uses Windows API to find and toggle the desktop icon ListView.
//!
//! Safety features:
//! - Panic hook to restore icons if app panics
//! - Force restore on app startup in case of previous crash
//! - Always restore at end of recording thread

// Allow unused helpers - keeping for potential future use
#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};

/// Track if we hid the icons (so we only restore if we were the ones who hid them)
static ICONS_HIDDEN_BY_US: AtomicBool = AtomicBool::new(false);

/// Setting: whether to hide desktop icons during recording
static HIDE_DESKTOP_ICONS_ENABLED: AtomicBool = AtomicBool::new(false);

/// Get current setting
pub fn is_hide_desktop_icons_enabled() -> bool {
    HIDE_DESKTOP_ICONS_ENABLED.load(Ordering::SeqCst)
}

/// Set the hide desktop icons preference
pub fn set_hide_desktop_icons_enabled(enabled: bool) {
    HIDE_DESKTOP_ICONS_ENABLED.store(enabled, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, ShowWindow, SW_HIDE, SW_SHOW,
    };

    /// Find the desktop icons ListView window.
    ///
    /// Desktop icons are in a ListView control inside SHELLDLL_DefView.
    /// The parent can be either Progman or a WorkerW window (depends on wallpaper slideshow).
    fn find_desktop_icons_window() -> Option<HWND> {
        unsafe {
            // First try: Progman -> SHELLDLL_DefView -> SysListView32
            let progman = FindWindowW(w!("Progman"), None).ok()?;

            // Try to find SHELLDLL_DefView under Progman
            if let Ok(shell_view) =
                FindWindowExW(progman, HWND::default(), w!("SHELLDLL_DefView"), None)
            {
                if let Ok(list_view) =
                    FindWindowExW(shell_view, HWND::default(), w!("SysListView32"), None)
                {
                    return Some(list_view);
                }
            }

            // Second try: WorkerW windows (when wallpaper slideshow or Spotlight is active)
            // Enumerate WorkerW windows to find the one containing SHELLDLL_DefView
            let mut worker_w = HWND::default();
            loop {
                match FindWindowExW(HWND::default(), worker_w, w!("WorkerW"), None) {
                    Ok(hwnd) if hwnd != HWND::default() => {
                        worker_w = hwnd;

                        // Check if this WorkerW contains SHELLDLL_DefView
                        if let Ok(shell_view) =
                            FindWindowExW(worker_w, HWND::default(), w!("SHELLDLL_DefView"), None)
                        {
                            if let Ok(list_view) = FindWindowExW(
                                shell_view,
                                HWND::default(),
                                w!("SysListView32"),
                                None,
                            ) {
                                return Some(list_view);
                            }
                        }
                    },
                    _ => break,
                }
            }

            None
        }
    }

    /// Hide desktop icons.
    pub fn hide_desktop_icons() {
        if !is_hide_desktop_icons_enabled() {
            return;
        }

        if let Some(hwnd) = find_desktop_icons_window() {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
                ICONS_HIDDEN_BY_US.store(true, Ordering::SeqCst);
                log::debug!("[DESKTOP] Desktop icons hidden");
            }
        } else {
            log::warn!("[DESKTOP] Could not find desktop icons window");
        }
    }

    /// Show desktop icons (restore visibility).
    pub fn show_desktop_icons() {
        // Only restore if we were the ones who hid them
        if !ICONS_HIDDEN_BY_US.load(Ordering::SeqCst) {
            return;
        }

        force_show_desktop_icons();
    }

    /// Force show desktop icons unconditionally.
    /// Used on app startup to recover from crashes.
    pub fn force_show_desktop_icons() {
        if let Some(hwnd) = find_desktop_icons_window() {
            unsafe {
                let _ = ShowWindow(hwnd, SW_SHOW);
                ICONS_HIDDEN_BY_US.store(false, Ordering::SeqCst);
                log::debug!("[DESKTOP] Desktop icons restored");
            }
        }
    }

    /// Install panic hook to restore desktop icons on crash.
    pub fn install_panic_hook() {
        let original_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            // Restore desktop icons before panicking
            force_show_desktop_icons();
            log::error!("[DESKTOP] Panic detected - restored desktop icons");
            // Call original hook
            original_hook(panic_info);
        }));
        log::debug!("[DESKTOP] Panic hook installed");
    }
}

#[cfg(not(target_os = "windows"))]
mod windows_impl {
    /// Hide desktop icons (no-op on non-Windows).
    pub fn hide_desktop_icons() {}

    /// Show desktop icons (no-op on non-Windows).
    pub fn show_desktop_icons() {}

    /// Force show desktop icons (no-op on non-Windows).
    pub fn force_show_desktop_icons() {}

    /// Install panic hook (no-op on non-Windows).
    pub fn install_panic_hook() {}
}

pub use windows_impl::{
    force_show_desktop_icons, hide_desktop_icons, install_panic_hook, show_desktop_icons,
};

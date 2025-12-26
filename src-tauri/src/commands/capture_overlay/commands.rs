//! Tauri commands for toolbar <-> overlay communication.
//!
//! These commands are called from the React toolbar window to control
//! the overlay (confirm selection, cancel, reselect).
//!
//! Communication uses an atomic pending command that the overlay polls.

use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};

use super::types::OverlayCommand;

/// Global pending command for the overlay.
///
/// The overlay polls this in its message loop to check for commands
/// from the toolbar.
static PENDING_COMMAND: AtomicU8 = AtomicU8::new(0);

/// Pending dimensions for SetDimensions command
static PENDING_WIDTH: AtomicU32 = AtomicU32::new(0);
static PENDING_HEIGHT: AtomicU32 = AtomicU32::new(0);

/// Get and clear the pending command.
///
/// Returns the current pending command and resets it to None.
/// This is called by the overlay's message loop.
pub fn take_pending_command() -> OverlayCommand {
    OverlayCommand::from(PENDING_COMMAND.swap(0, Ordering::SeqCst))
}

/// Get and clear pending dimensions.
///
/// Returns the pending width and height, then clears them.
/// Should be called when handling SetDimensions command.
pub fn take_pending_dimensions() -> (u32, u32) {
    let width = PENDING_WIDTH.swap(0, Ordering::SeqCst);
    let height = PENDING_HEIGHT.swap(0, Ordering::SeqCst);
    (width, height)
}

/// Set a pending command for the overlay.
fn set_pending_command(cmd: OverlayCommand) {
    PENDING_COMMAND.store(cmd as u8, Ordering::SeqCst);
}

/// Confirm the overlay selection.
///
/// Called from the toolbar when the user clicks the record or screenshot button.
///
/// # Arguments
/// * `action` - Either "recording" or "screenshot"
#[tauri::command]
pub async fn capture_overlay_confirm(action: String) -> Result<(), String> {
    let cmd = match action.as_str() {
        "recording" => OverlayCommand::ConfirmRecording,
        "screenshot" => OverlayCommand::ConfirmScreenshot,
        _ => {
            return Err(format!(
                "Invalid action: '{}'. Expected 'recording' or 'screenshot'.",
                action
            ))
        }
    };
    set_pending_command(cmd);
    Ok(())
}

/// Cancel the overlay and close.
///
/// Called from the toolbar when the user clicks cancel or presses Escape.
#[tauri::command]
pub async fn capture_overlay_cancel() -> Result<(), String> {
    set_pending_command(OverlayCommand::Cancel);
    Ok(())
}

/// Go back to selection mode (reselect region).
///
/// Called from the toolbar when the user clicks the redo/reselect button.
#[tauri::command]
pub async fn capture_overlay_reselect() -> Result<(), String> {
    set_pending_command(OverlayCommand::Reselect);
    Ok(())
}

/// Set the selection dimensions.
///
/// Called from the toolbar when the user edits the dimension inputs.
/// The overlay will resize the selection to match while keeping the center point.
#[tauri::command]
pub async fn capture_overlay_set_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width < 20 || height < 20 {
        return Err("Dimensions must be at least 20x20".to_string());
    }
    PENDING_WIDTH.store(width, Ordering::SeqCst);
    PENDING_HEIGHT.store(height, Ordering::SeqCst);
    set_pending_command(OverlayCommand::SetDimensions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pending_command_lifecycle() {
        // Initially should be None
        assert_eq!(take_pending_command(), OverlayCommand::None);

        // Set a command
        set_pending_command(OverlayCommand::ConfirmRecording);

        // Take should return it and clear
        assert_eq!(take_pending_command(), OverlayCommand::ConfirmRecording);

        // Should be None again
        assert_eq!(take_pending_command(), OverlayCommand::None);
    }

    #[test]
    fn test_command_overwrite() {
        // Setting a new command should overwrite the previous one
        set_pending_command(OverlayCommand::ConfirmRecording);
        set_pending_command(OverlayCommand::Cancel);

        assert_eq!(take_pending_command(), OverlayCommand::Cancel);
    }
}

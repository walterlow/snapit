//! Toolbar Positioning Module
//!
//! Handles positioning of the capture toolbar window relative to a selection region.
//!
//! # Positioning Rules (DO NOT CHANGE WITHOUT UPDATING COMMENTS)
//!
//! 1. **Primary Position**: Centered horizontally below the selection, with margin
//! 2. **Vertical Fallback**: If below doesn't fit, try above the selection
//! 3. **Monitor Fallback**: If toolbar doesn't fit on current monitor:
//!    - If on primary monitor → move to secondary monitor
//!    - If on secondary monitor → move to primary monitor
//! 4. **Final Fallback**: Clamp to virtual screen bounds
//!
//! # Constants
//!
//! - `TOOLBAR_WIDTH`: 600px - width of toolbar window
//! - `TOOLBAR_HEIGHT`: 64px - height of toolbar window  
//! - `MARGIN`: 8px - margin from screen edges and selection

use super::capture::fallback::get_monitors;
use super::capture::types::MonitorInfo;

/// Toolbar window width in pixels
pub const TOOLBAR_WIDTH: i32 = 600;

/// Toolbar window height in pixels
pub const TOOLBAR_HEIGHT: i32 = 64;

/// Margin from edges in pixels
pub const MARGIN: i32 = 8;

/// Selection region bounds
#[derive(Debug, Clone, Copy)]
pub struct SelectionBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl SelectionBounds {
    pub fn center_x(&self) -> i32 {
        self.x + (self.width as i32) / 2
    }
    
    pub fn center_y(&self) -> i32 {
        self.y + (self.height as i32) / 2
    }
    
    pub fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }
    
    pub fn top(&self) -> i32 {
        self.y
    }
}

/// Toolbar position result
#[derive(Debug, Clone, Copy)]
pub struct ToolbarPosition {
    pub x: i32,
    pub y: i32,
}

/// Monitor bounds helper
struct MonitorBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    is_primary: bool,
}

impl From<&MonitorInfo> for MonitorBounds {
    fn from(m: &MonitorInfo) -> Self {
        Self {
            x: m.x,
            y: m.y,
            width: m.width as i32,
            height: m.height as i32,
            is_primary: m.is_primary,
        }
    }
}

impl MonitorBounds {
    fn right(&self) -> i32 {
        self.x + self.width
    }
    
    fn bottom(&self) -> i32 {
        self.y + self.height
    }
    
    /// Check if a toolbar at (x, y) fits within this monitor
    fn toolbar_fits(&self, x: i32, y: i32) -> bool {
        x >= self.x + MARGIN &&
        x + TOOLBAR_WIDTH <= self.right() - MARGIN &&
        y >= self.y + MARGIN &&
        y + TOOLBAR_HEIGHT <= self.bottom() - MARGIN
    }
    
    /// Clamp toolbar position to fit within this monitor
    fn clamp_toolbar(&self, x: i32, y: i32) -> ToolbarPosition {
        ToolbarPosition {
            x: x.max(self.x + MARGIN).min(self.right() - MARGIN - TOOLBAR_WIDTH),
            y: y.max(self.y + MARGIN).min(self.bottom() - MARGIN - TOOLBAR_HEIGHT),
        }
    }
    
    /// Get centered position (both horizontally and vertically) on this monitor
    fn centered(&self) -> ToolbarPosition {
        ToolbarPosition {
            x: self.x + (self.width - TOOLBAR_WIDTH) / 2,
            y: self.y + (self.height - TOOLBAR_HEIGHT) / 2,
        }
    }
    
    /// Check if point is inside this monitor
    fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.right() &&
        y >= self.y && y < self.bottom()
    }
}

/// Calculate the optimal toolbar position for a given selection.
///
/// # Algorithm
///
/// 1. Find which monitor contains the selection center
/// 2. Try positioning below selection (preferred)
/// 3. If doesn't fit below, try above selection
/// 4. If doesn't fit on current monitor at all, switch to alternate monitor
///    and center the toolbar on that monitor:
///    - Primary → Secondary (centered)
///    - Secondary → Primary (centered)
/// 5. If no alternate monitor, clamp to current monitor bounds
/// 6. If no monitor found, use virtual screen bounds
pub fn calculate_position(selection: SelectionBounds) -> ToolbarPosition {
    let monitors: Vec<MonitorBounds> = get_monitors()
        .unwrap_or_default()
        .iter()
        .map(MonitorBounds::from)
        .collect();
    
    // Find monitor containing selection center
    let current_monitor = monitors.iter().find(|m| {
        m.contains_point(selection.center_x(), selection.center_y())
    });
    
    // Calculate default position: centered below selection
    let below_x = selection.center_x() - TOOLBAR_WIDTH / 2;
    let below_y = selection.bottom() + MARGIN;
    
    // Calculate above position
    let above_y = selection.top() - TOOLBAR_HEIGHT - MARGIN;
    
    if let Some(current) = current_monitor {
        // Try 1: Below selection
        if current.toolbar_fits(below_x, below_y) {
            return ToolbarPosition { x: below_x, y: below_y };
        }
        
        // Try 2: Above selection
        if current.toolbar_fits(below_x, above_y) {
            return ToolbarPosition { x: below_x, y: above_y };
        }
        
        // Try 3: Alternate monitor
        let alternate = if current.is_primary {
            monitors.iter().find(|m| !m.is_primary)
        } else {
            monitors.iter().find(|m| m.is_primary)
        };
        
        if let Some(alt) = alternate {
            // Place at center of alternate monitor
            return alt.centered();
        }
        
        // Try 4: Clamp to current monitor
        return current.clamp_toolbar(below_x, below_y);
    }
    
    // Fallback: Use virtual screen bounds
    let (vs_x, vs_y, vs_w, vs_h) = get_virtual_screen_bounds();
    let vs = MonitorBounds {
        x: vs_x,
        y: vs_y,
        width: vs_w as i32,
        height: vs_h as i32,
        is_primary: true,
    };
    vs.clamp_toolbar(below_x, below_y)
}

/// Get virtual screen bounds (all monitors combined)
fn get_virtual_screen_bounds() -> (i32, i32, u32, u32) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, 
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN
    };
    
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN) as u32;
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN) as u32;
        (x, y, width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_selection_bounds() {
        let sel = SelectionBounds { x: 100, y: 200, width: 300, height: 400 };
        assert_eq!(sel.center_x(), 250);
        assert_eq!(sel.center_y(), 400);
        assert_eq!(sel.bottom(), 600);
        assert_eq!(sel.top(), 200);
    }
    
    #[test]
    fn test_monitor_bounds_contains() {
        let mon = MonitorBounds { x: 0, y: 0, width: 1920, height: 1080, is_primary: true };
        assert!(mon.contains_point(960, 540));
        assert!(!mon.contains_point(-10, 540));
        assert!(!mon.contains_point(2000, 540));
    }
    
    #[test]
    fn test_monitor_bounds_toolbar_fits() {
        let mon = MonitorBounds { x: 0, y: 0, width: 1920, height: 1080, is_primary: true };
        // Should fit in center
        assert!(mon.toolbar_fits(660, 500));
        // Should not fit if too far right
        assert!(!mon.toolbar_fits(1920 - TOOLBAR_WIDTH + 100, 500));
        // Should not fit if too far down
        assert!(!mon.toolbar_fits(660, 1080 - TOOLBAR_HEIGHT + 100));
    }
}

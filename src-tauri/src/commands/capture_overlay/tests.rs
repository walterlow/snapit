//! Unit tests for the capture overlay module.
//!
//! Tests are organized by component:
//! - Geometry types (Rect, Point)
//! - Capture types and enums
//! - State management
//! - Hit-testing
//! - Commands

#[cfg(test)]
mod geometry_tests {
    use crate::commands::capture_overlay::types::*;

    #[test]
    fn rect_from_xywh() {
        let r = Rect::from_xywh(10, 20, 100, 50);
        assert_eq!(r.left, 10);
        assert_eq!(r.top, 20);
        assert_eq!(r.right, 110);
        assert_eq!(r.bottom, 70);
    }

    #[test]
    fn rect_dimensions() {
        let r = Rect::new(10, 20, 110, 70);
        assert_eq!(r.width(), 100);
        assert_eq!(r.height(), 50);
    }

    #[test]
    fn rect_center() {
        let r = Rect::new(0, 0, 100, 100);
        assert_eq!(r.center(), (50, 50));

        let r2 = Rect::new(10, 20, 110, 120);
        assert_eq!(r2.center(), (60, 70));
    }

    #[test]
    fn rect_contains() {
        let r = Rect::new(10, 10, 100, 100);

        // Inside
        assert!(r.contains(50, 50));
        assert!(r.contains(10, 10)); // Left-top corner (inclusive)

        // Outside (right/bottom are exclusive)
        assert!(!r.contains(100, 100));
        assert!(!r.contains(5, 50));
        assert!(!r.contains(50, 5));
    }

    #[test]
    fn rect_contains_strict() {
        let r = Rect::new(10, 10, 100, 100);

        // Strictly inside
        assert!(r.contains_strict(50, 50));

        // On edges (not strictly inside)
        assert!(!r.contains_strict(10, 50)); // On left edge
        assert!(!r.contains_strict(50, 10)); // On top edge
    }

    #[test]
    fn rect_normalize() {
        // Already normalized
        let r1 = Rect::new(0, 0, 100, 100);
        assert_eq!(r1.normalize(), r1);

        // Inverted
        let r2 = Rect::new(100, 100, 0, 0);
        let n2 = r2.normalize();
        assert_eq!(n2.left, 0);
        assert_eq!(n2.top, 0);
        assert_eq!(n2.right, 100);
        assert_eq!(n2.bottom, 100);
    }

    #[test]
    fn rect_ensure_min_size() {
        let r = Rect::new(0, 0, 5, 5);
        let e = r.ensure_min_size(20);
        assert_eq!(e.width(), 20);
        assert_eq!(e.height(), 20);
        assert_eq!(e.left, 0); // Origin unchanged
        assert_eq!(e.top, 0);
    }

    #[test]
    fn rect_offset() {
        let r = Rect::new(10, 10, 20, 20);
        let o = r.offset(5, -5);
        assert_eq!(o, Rect::new(15, 5, 25, 15));
    }

    #[test]
    fn point_new() {
        let p = Point::new(10, 20);
        assert_eq!(p.x, 10);
        assert_eq!(p.y, 20);
    }
}

#[cfg(test)]
mod capture_type_tests {
    use crate::commands::capture_overlay::types::CaptureType;

    #[test]
    fn from_str_video() {
        assert_eq!(CaptureType::from_str("video"), CaptureType::Video);
        assert_eq!(CaptureType::from_str("VIDEO"), CaptureType::Video);
        assert_eq!(CaptureType::from_str("Video"), CaptureType::Video);
    }

    #[test]
    fn from_str_gif() {
        assert_eq!(CaptureType::from_str("gif"), CaptureType::Gif);
        assert_eq!(CaptureType::from_str("GIF"), CaptureType::Gif);
    }

    #[test]
    fn from_str_screenshot() {
        assert_eq!(CaptureType::from_str("screenshot"), CaptureType::Screenshot);
        assert_eq!(CaptureType::from_str("unknown"), CaptureType::Screenshot);
        assert_eq!(CaptureType::from_str(""), CaptureType::Screenshot);
    }

    #[test]
    fn is_recording() {
        assert!(!CaptureType::Screenshot.is_recording());
        assert!(CaptureType::Video.is_recording());
        assert!(CaptureType::Gif.is_recording());
    }
}

#[cfg(test)]
mod overlay_action_tests {
    use crate::commands::capture_overlay::types::OverlayAction;

    #[test]
    fn default_is_cancelled() {
        assert_eq!(OverlayAction::default(), OverlayAction::Cancelled);
    }
}

#[cfg(test)]
mod overlay_command_tests {
    use crate::commands::capture_overlay::types::OverlayCommand;

    #[test]
    fn from_u8() {
        assert_eq!(OverlayCommand::from(0), OverlayCommand::None);
        assert_eq!(OverlayCommand::from(1), OverlayCommand::ConfirmRecording);
        assert_eq!(OverlayCommand::from(2), OverlayCommand::ConfirmScreenshot);
        assert_eq!(OverlayCommand::from(3), OverlayCommand::Reselect);
        assert_eq!(OverlayCommand::from(4), OverlayCommand::Cancel);
        assert_eq!(OverlayCommand::from(255), OverlayCommand::None);
    }

    #[test]
    fn to_action() {
        assert_eq!(
            OverlayCommand::ConfirmRecording.to_action(),
            Some(crate::commands::capture_overlay::types::OverlayAction::StartRecording)
        );
        assert_eq!(
            OverlayCommand::ConfirmScreenshot.to_action(),
            Some(crate::commands::capture_overlay::types::OverlayAction::CaptureScreenshot)
        );
        assert_eq!(OverlayCommand::None.to_action(), None);
        assert_eq!(OverlayCommand::Cancel.to_action(), None);
    }
}

#[cfg(test)]
mod handle_position_tests {
    use crate::commands::capture_overlay::types::HandlePosition;

    #[test]
    fn is_active() {
        assert!(!HandlePosition::None.is_active());
        assert!(HandlePosition::TopLeft.is_active());
        assert!(HandlePosition::Interior.is_active());
    }
}

#[cfg(test)]
mod overlay_result_tests {
    use crate::commands::capture_overlay::types::{OverlayAction, OverlayResult, Rect};

    #[test]
    fn new_from_bounds() {
        let bounds = Rect::new(10, 20, 110, 120);
        let result = OverlayResult::new(bounds, OverlayAction::StartRecording);

        assert_eq!(result.x, 10);
        assert_eq!(result.y, 20);
        assert_eq!(result.width, 100);
        assert_eq!(result.height, 100);
        assert_eq!(result.action, OverlayAction::StartRecording);
    }

    #[test]
    fn cancelled() {
        let result = OverlayResult::cancelled();

        assert_eq!(result.x, 0);
        assert_eq!(result.y, 0);
        assert_eq!(result.width, 0);
        assert_eq!(result.height, 0);
        assert_eq!(result.action, OverlayAction::Cancelled);
    }
}

#[cfg(test)]
mod selection_event_tests {
    use crate::commands::capture_overlay::types::{Rect, SelectionEvent};

    #[test]
    fn from_rect() {
        let rect = Rect::new(100, 200, 400, 500);
        let event: SelectionEvent = rect.into();

        assert_eq!(event.x, 100);
        assert_eq!(event.y, 200);
        assert_eq!(event.width, 300);
        assert_eq!(event.height, 300);
    }
}

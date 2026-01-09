//! Cursor shape types and SVG asset resolution.
//!
//! Provides platform-specific cursor shape detection and maps shapes
//! to embedded SVG assets for high-quality rendering.

use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;

/// Information about a resolved cursor shape.
#[derive(Debug, Clone)]
pub struct ResolvedCursor {
    /// Raw SVG content of the cursor asset.
    pub raw: &'static str,
    /// Hotspot location within the cursor (normalized 0-1).
    pub hotspot: (f64, f64),
}

/// Platform-agnostic cursor shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CursorShape {
    Windows(CursorShapeWindows),
}

impl CursorShape {
    /// Resolve cursor shape to SVG asset and hotspot.
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        match self {
            CursorShape::Windows(cursor) => cursor.resolve(),
        }
    }
}

impl fmt::Display for CursorShape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            CursorShape::Windows(_) => "Windows",
        };

        let variant: &'static str = match self {
            CursorShape::Windows(cursor) => cursor.into(),
        };

        write!(f, "{kind}|{variant}")
    }
}

impl Serialize for CursorShape {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for CursorShape {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let string = String::deserialize(deserializer)?;

        let Some((kind, variant)) = string.split_once('|') else {
            return Err(serde::de::Error::custom(
                "Invalid CursorShape: missing delimiter",
            ));
        };

        match kind {
            "Windows" => {
                let shape = CursorShapeWindows::from_str(variant).map_err(|_| {
                    serde::de::Error::custom(format!("Unknown Windows cursor: {variant}"))
                })?;
                Ok(CursorShape::Windows(shape))
            },
            _ => Err(serde::de::Error::custom(format!(
                "Unknown cursor platform: {kind}"
            ))),
        }
    }
}

// Implement TS manually to serialize as String
impl TS for CursorShape {
    type WithoutGenerics = Self;

    fn name() -> String {
        "string".to_string()
    }

    fn decl() -> String {
        String::new()
    }

    fn decl_concrete() -> String {
        String::new()
    }

    fn inline() -> String {
        "string".to_string()
    }

    fn inline_flattened() -> String {
        Self::inline()
    }
}

/// Windows cursor shapes.
/// Maps to Windows IDC_* cursor constants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum CursorShapeWindows {
    /// IDC_ARROW - Standard arrow cursor
    Arrow,
    /// IDC_IBEAM - Text selection cursor
    IBeam,
    /// IDC_WAIT - Hourglass/busy cursor
    Wait,
    /// IDC_CROSS - Crosshair cursor
    Cross,
    /// IDC_UPARROW - Up arrow cursor
    UpArrow,
    /// IDC_SIZENWSE - Diagonal resize (NW-SE)
    SizeNWSE,
    /// IDC_SIZENESW - Diagonal resize (NE-SW)
    SizeNESW,
    /// IDC_SIZEWE - Horizontal resize
    SizeWE,
    /// IDC_SIZENS - Vertical resize
    SizeNS,
    /// IDC_SIZEALL - Move cursor (4-way arrow)
    SizeAll,
    /// IDC_NO - Not allowed cursor
    No,
    /// IDC_HAND - Hand/pointer cursor
    Hand,
    /// IDC_APPSTARTING - Arrow with hourglass
    AppStarting,
    /// IDC_HELP - Arrow with question mark
    Help,
    /// IDC_PIN - Pin cursor
    Pin,
    /// IDC_PERSON - Person cursor
    Person,
    /// MAKEINTRESOURCE(32631) - Pen cursor
    Pen,
    /// MAKEINTRESOURCE(32652) - Scroll NS
    ScrollNS,
    /// MAKEINTRESOURCE(32653) - Scroll WE
    ScrollWE,
    /// MAKEINTRESOURCE(32654) - Scroll NSEW
    ScrollNSEW,
    /// MAKEINTRESOURCE(32655) - Scroll N
    ScrollN,
    /// MAKEINTRESOURCE(32656) - Scroll S
    ScrollS,
    /// MAKEINTRESOURCE(32657) - Scroll W
    ScrollW,
    /// MAKEINTRESOURCE(32658) - Scroll E
    ScrollE,
    /// MAKEINTRESOURCE(32659) - Scroll NW
    ScrollNW,
    /// MAKEINTRESOURCE(32660) - Scroll NE
    ScrollNE,
    /// MAKEINTRESOURCE(32661) - Scroll SW
    ScrollSW,
    /// MAKEINTRESOURCE(32662) - Scroll SE
    ScrollSE,
    /// MAKEINTRESOURCE(32663) - Arrow CD
    ArrowCD,
}

impl CursorShapeWindows {
    /// Resolve cursor shape to SVG asset and hotspot.
    pub fn resolve(&self) -> Option<ResolvedCursor> {
        Some(match self {
            Self::Arrow => ResolvedCursor {
                raw: include_str!("assets/windows/arrow.svg"),
                hotspot: (0.288, 0.189),
            },
            Self::IBeam => ResolvedCursor {
                raw: include_str!("assets/windows/ibeam.svg"),
                hotspot: (0.490, 0.471),
            },
            Self::Wait => ResolvedCursor {
                raw: include_str!("assets/windows/wait.svg"),
                hotspot: (0.5, 0.52),
            },
            Self::Cross => ResolvedCursor {
                raw: include_str!("assets/windows/cross.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::UpArrow => ResolvedCursor {
                raw: include_str!("assets/windows/uparrow.svg"),
                hotspot: (0.5, 0.05),
            },
            Self::SizeNWSE => ResolvedCursor {
                raw: include_str!("assets/windows/sizenwse.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeNESW => ResolvedCursor {
                raw: include_str!("assets/windows/sizenesw.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeWE => ResolvedCursor {
                raw: include_str!("assets/windows/sizewe.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeNS => ResolvedCursor {
                raw: include_str!("assets/windows/sizens.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::SizeAll => ResolvedCursor {
                raw: include_str!("assets/windows/sizeall.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::No => ResolvedCursor {
                raw: include_str!("assets/windows/no.svg"),
                hotspot: (0.5, 0.5),
            },
            Self::Hand => ResolvedCursor {
                raw: include_str!("assets/windows/hand.svg"),
                hotspot: (0.441, 0.143),
            },
            Self::AppStarting => ResolvedCursor {
                raw: include_str!("assets/windows/appstarting.svg"),
                hotspot: (0.055, 0.368),
            },
            Self::Help => ResolvedCursor {
                raw: include_str!("assets/windows/help.svg"),
                hotspot: (0.056, 0.127),
            },
            Self::Pin => ResolvedCursor {
                raw: include_str!("assets/windows/pin.svg"),
                hotspot: (0.245, 0.05),
            },
            Self::Person => ResolvedCursor {
                raw: include_str!("assets/windows/person.svg"),
                hotspot: (0.235, 0.05),
            },
            Self::Pen => ResolvedCursor {
                raw: include_str!("assets/windows/pen.svg"),
                hotspot: (0.055, 0.945),
            },
            // Scroll cursors - not all have SVG assets yet
            _ => return None,
        })
    }

    /// Parse from string representation.
    pub fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "Arrow" => Ok(Self::Arrow),
            "IBeam" => Ok(Self::IBeam),
            "Wait" => Ok(Self::Wait),
            "Cross" => Ok(Self::Cross),
            "UpArrow" => Ok(Self::UpArrow),
            "SizeNWSE" => Ok(Self::SizeNWSE),
            "SizeNESW" => Ok(Self::SizeNESW),
            "SizeWE" => Ok(Self::SizeWE),
            "SizeNS" => Ok(Self::SizeNS),
            "SizeAll" => Ok(Self::SizeAll),
            "No" => Ok(Self::No),
            "Hand" => Ok(Self::Hand),
            "AppStarting" => Ok(Self::AppStarting),
            "Help" => Ok(Self::Help),
            "Pin" => Ok(Self::Pin),
            "Person" => Ok(Self::Person),
            "Pen" => Ok(Self::Pen),
            "ScrollNS" => Ok(Self::ScrollNS),
            "ScrollWE" => Ok(Self::ScrollWE),
            "ScrollNSEW" => Ok(Self::ScrollNSEW),
            "ScrollN" => Ok(Self::ScrollN),
            "ScrollS" => Ok(Self::ScrollS),
            "ScrollW" => Ok(Self::ScrollW),
            "ScrollE" => Ok(Self::ScrollE),
            "ScrollNW" => Ok(Self::ScrollNW),
            "ScrollNE" => Ok(Self::ScrollNE),
            "ScrollSW" => Ok(Self::ScrollSW),
            "ScrollSE" => Ok(Self::ScrollSE),
            "ArrowCD" => Ok(Self::ArrowCD),
            _ => Err(()),
        }
    }
}

impl From<&CursorShapeWindows> for &'static str {
    fn from(shape: &CursorShapeWindows) -> Self {
        match shape {
            CursorShapeWindows::Arrow => "Arrow",
            CursorShapeWindows::IBeam => "IBeam",
            CursorShapeWindows::Wait => "Wait",
            CursorShapeWindows::Cross => "Cross",
            CursorShapeWindows::UpArrow => "UpArrow",
            CursorShapeWindows::SizeNWSE => "SizeNWSE",
            CursorShapeWindows::SizeNESW => "SizeNESW",
            CursorShapeWindows::SizeWE => "SizeWE",
            CursorShapeWindows::SizeNS => "SizeNS",
            CursorShapeWindows::SizeAll => "SizeAll",
            CursorShapeWindows::No => "No",
            CursorShapeWindows::Hand => "Hand",
            CursorShapeWindows::AppStarting => "AppStarting",
            CursorShapeWindows::Help => "Help",
            CursorShapeWindows::Pin => "Pin",
            CursorShapeWindows::Person => "Person",
            CursorShapeWindows::Pen => "Pen",
            CursorShapeWindows::ScrollNS => "ScrollNS",
            CursorShapeWindows::ScrollWE => "ScrollWE",
            CursorShapeWindows::ScrollNSEW => "ScrollNSEW",
            CursorShapeWindows::ScrollN => "ScrollN",
            CursorShapeWindows::ScrollS => "ScrollS",
            CursorShapeWindows::ScrollW => "ScrollW",
            CursorShapeWindows::ScrollE => "ScrollE",
            CursorShapeWindows::ScrollNW => "ScrollNW",
            CursorShapeWindows::ScrollNE => "ScrollNE",
            CursorShapeWindows::ScrollSW => "ScrollSW",
            CursorShapeWindows::ScrollSE => "ScrollSE",
            CursorShapeWindows::ArrowCD => "ArrowCD",
        }
    }
}

impl From<CursorShapeWindows> for CursorShape {
    fn from(value: CursorShapeWindows) -> Self {
        CursorShape::Windows(value)
    }
}

// Windows-specific cursor handle detection
#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadCursorW, HCURSOR, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM,
        IDC_NO, IDC_PERSON, IDC_PIN, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE,
        IDC_SIZEWE, IDC_UPARROW, IDC_WAIT,
    };

    static CURSOR_CACHE: OnceLock<HashMap<usize, CursorShapeWindows>> = OnceLock::new();

    fn get_cursor_cache() -> &'static HashMap<usize, CursorShapeWindows> {
        CURSOR_CACHE.get_or_init(|| {
            #[inline]
            fn load_cursor(lpcursorname: PCWSTR) -> usize {
                unsafe {
                    LoadCursorW(None, lpcursorname)
                        .map(|c| c.0 as usize)
                        .unwrap_or(0)
                }
            }

            let mut cursors = HashMap::new();

            cursors.insert(load_cursor(IDC_ARROW), CursorShapeWindows::Arrow);
            cursors.insert(load_cursor(IDC_IBEAM), CursorShapeWindows::IBeam);
            cursors.insert(load_cursor(IDC_WAIT), CursorShapeWindows::Wait);
            cursors.insert(load_cursor(IDC_CROSS), CursorShapeWindows::Cross);
            cursors.insert(load_cursor(IDC_UPARROW), CursorShapeWindows::UpArrow);
            cursors.insert(load_cursor(IDC_SIZENWSE), CursorShapeWindows::SizeNWSE);
            cursors.insert(load_cursor(IDC_SIZENESW), CursorShapeWindows::SizeNESW);
            cursors.insert(load_cursor(IDC_SIZEWE), CursorShapeWindows::SizeWE);
            cursors.insert(load_cursor(IDC_SIZENS), CursorShapeWindows::SizeNS);
            cursors.insert(load_cursor(IDC_SIZEALL), CursorShapeWindows::SizeAll);
            cursors.insert(load_cursor(IDC_NO), CursorShapeWindows::No);
            cursors.insert(load_cursor(IDC_HAND), CursorShapeWindows::Hand);
            cursors.insert(
                load_cursor(IDC_APPSTARTING),
                CursorShapeWindows::AppStarting,
            );
            cursors.insert(load_cursor(IDC_HELP), CursorShapeWindows::Help);
            cursors.insert(load_cursor(IDC_PIN), CursorShapeWindows::Pin);
            cursors.insert(load_cursor(IDC_PERSON), CursorShapeWindows::Person);
            // Pen cursor: MAKEINTRESOURCE(32631)
            cursors.insert(
                load_cursor(PCWSTR(32631u16 as *const u16)),
                CursorShapeWindows::Pen,
            );
            // Scroll cursors
            cursors.insert(
                load_cursor(PCWSTR(32652u16 as *const u16)),
                CursorShapeWindows::ScrollNS,
            );
            cursors.insert(
                load_cursor(PCWSTR(32653u16 as *const u16)),
                CursorShapeWindows::ScrollWE,
            );
            cursors.insert(
                load_cursor(PCWSTR(32654u16 as *const u16)),
                CursorShapeWindows::ScrollNSEW,
            );
            cursors.insert(
                load_cursor(PCWSTR(32655u16 as *const u16)),
                CursorShapeWindows::ScrollN,
            );
            cursors.insert(
                load_cursor(PCWSTR(32656u16 as *const u16)),
                CursorShapeWindows::ScrollS,
            );
            cursors.insert(
                load_cursor(PCWSTR(32657u16 as *const u16)),
                CursorShapeWindows::ScrollW,
            );
            cursors.insert(
                load_cursor(PCWSTR(32658u16 as *const u16)),
                CursorShapeWindows::ScrollE,
            );
            cursors.insert(
                load_cursor(PCWSTR(32659u16 as *const u16)),
                CursorShapeWindows::ScrollNW,
            );
            cursors.insert(
                load_cursor(PCWSTR(32660u16 as *const u16)),
                CursorShapeWindows::ScrollNE,
            );
            cursors.insert(
                load_cursor(PCWSTR(32661u16 as *const u16)),
                CursorShapeWindows::ScrollSW,
            );
            cursors.insert(
                load_cursor(PCWSTR(32662u16 as *const u16)),
                CursorShapeWindows::ScrollSE,
            );
            cursors.insert(
                load_cursor(PCWSTR(32663u16 as *const u16)),
                CursorShapeWindows::ArrowCD,
            );

            // Remove invalid entries (0 key)
            cursors.remove(&0);

            cursors
        })
    }

    impl TryFrom<&HCURSOR> for CursorShape {
        type Error = ();

        fn try_from(cursor: &HCURSOR) -> Result<Self, Self::Error> {
            get_cursor_cache()
                .get(&(cursor.0 as usize))
                .map(|shape| CursorShape::Windows(*shape))
                .ok_or(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cursor_shape_display() {
        let shape = CursorShape::Windows(CursorShapeWindows::Arrow);
        assert_eq!(shape.to_string(), "Windows|Arrow");
    }

    #[test]
    fn test_cursor_shape_serde() {
        let shape = CursorShape::Windows(CursorShapeWindows::Hand);
        let json = serde_json::to_string(&shape).unwrap();
        assert_eq!(json, "\"Windows|Hand\"");

        let parsed: CursorShape = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, shape);
    }

    #[test]
    fn test_cursor_resolve() {
        let arrow = CursorShapeWindows::Arrow;
        let resolved = arrow.resolve().unwrap();
        assert!(resolved.raw.contains("<svg"));
        assert!((resolved.hotspot.0 - 0.288).abs() < 0.001);
    }
}

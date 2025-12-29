# Changelog

All notable changes to SnapIt are documented in this file.

## [0.3.0] - 2025-12-28

### Added
- **Video Recording** - Screen recording with MP4 output, system audio, and microphone support
- **GIF Recording** - Capture screen as animated GIFs with optimized encoding
- **Webcam Overlay** - Add webcam feed to recordings
- **Countdown Timer** - Configurable countdown before recording starts
- **Cursor Capture** - Include cursor in recordings
- **Line Tool** - Draw straight lines as annotations
- **Tag Support** - Organize captures with custom tags
- **Undo/Redo** - Full history support for editor actions
- **Testing Infrastructure** - Vitest setup with unit and integration tests

### Changed
- Migrated UI components to shadcn/ui (from Base UI)
- Refactored capture toolbar to frontend-controlled positioning
- Enhanced overlay with resize handles for region adjustment
- Improved glassmorphism styling throughout UI
- Integrated ts-rs for Rust-to-TypeScript type generation

### Fixed
- Windows resize lag with transparency enabled
- Stale closures in marquee selection
- Audio sync issues in recordings
- Save-on-exit race conditions

## [0.2.5] - 2025-12-24

### Added
- Momentum zoom for canvas navigation
- Double-click to open captures in library
- Momentum scroll in capture library
- WebView2 GPU optimization flags for Windows

### Changed
- Updated React to v19.2.0
- Instant theme switching (disabled transitions during switch)
- Optimized library grid animations and resize performance
- Memoized date grouping for better performance

### Fixed
- Virtual screen bounds calculation
- Duplicate window borders on rapid monitor switching

## [0.2.4] - 2025-12-24

### Added
- Window state persistence (remembers size/position)
- Single-instance enforcement (prevents multiple app windows)

### Changed
- Dynamic app version display in settings
- Enhanced startup cleanup with pre-created directories

## [0.2.3] - 2025-12-24

### Changed
- Build configuration cleanup
- Version sync script improvements

## [0.2.2] - 2025-12-23

### Added
- Auto-update checking and installation
- Missing file detection with re-import option
- Delete capture with confirmation dialog
- Text shape with stroke/fill color support
- All monitors capture mode
- Minimize-to-tray option
- User-configurable save directory
- BMP image format support
- Keyboard shortcuts for editor actions

### Changed
- Auto-deselect shapes when switching tools
- Reset to select tool on new image load
- Enhanced compositor settings persistence
- Improved blur controls with preset intensity levels

### Fixed
- Alert dialog animation classes
- Crop overlay dragging during pan
- Invisible shapes fallback color

## [0.2.1] - 2025-12-23

### Changed
- Minor improvements and bug fixes

## [0.2.0] - 2025-12-23

### Added
- Compositor background effects (solid, gradient, image)
- Color picker in properties panel
- Date grouping in capture library
- Dynamic tray menu with shortcut text
- Arrow shape with improved handles
- Tooltip responsiveness improvements

### Changed
- Simplified padding calculation to absolute pixels
- Extracted library components for modularity
- Throttled window detection
- Debounced canvas fit calculations

### Fixed
- Pixel alignment in screen capture
- Logical to physical pixel scaling
- Window capture reliability

## [0.1.0] - 2025-12-21

### Added
- Initial release
- Region, fullscreen, and window capture
- Annotation tools: rectangle, ellipse, arrow, text, highlight, blur, pen, steps
- Crop and expand functionality
- Global hotkey support
- Capture library with thumbnails
- Favorites system
- Light/dark theme support
- Auto-updates via GitHub releases

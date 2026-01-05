//! Tests for the exporter module.

#![cfg(test)]

use super::super::types::DecodedFrame;
use super::frame_ops::*;
use super::webcam::*;
use crate::commands::video_recording::video_project::{
    AudioTrackSettings, CornerStyle, CursorConfig, ExportConfig, SceneConfig, ShadowConfig,
    TextConfig, TimelineState, VideoProject, VideoSources, WebcamBorder, WebcamConfig,
    WebcamOverlayPosition, WebcamOverlayShape, ZoomConfig,
};

/// Create a minimal VideoProject for testing webcam positioning
fn make_test_project(
    position: WebcamOverlayPosition,
    size: f32,
    custom_x: f32,
    custom_y: f32,
) -> VideoProject {
    VideoProject {
        id: "test".to_string(),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        name: "test".to_string(),
        sources: VideoSources {
            screen_video: "/tmp/test.mp4".to_string(),
            webcam_video: Some("/tmp/webcam.mp4".to_string()),
            cursor_data: None,
            audio_file: None,
            system_audio: None,
            microphone_audio: None,
            background_music: None,
            original_width: 1920,
            original_height: 1080,
            duration_ms: 10000,
            fps: 30,
        },
        timeline: TimelineState::default(),
        zoom: ZoomConfig::default(),
        cursor: CursorConfig::default(),
        webcam: WebcamConfig {
            enabled: true,
            position,
            custom_x,
            custom_y,
            size,
            shape: WebcamOverlayShape::Circle,
            rounding: 100.0,
            corner_style: CornerStyle::Squircle,
            shadow: 62.5,
            shadow_config: ShadowConfig::default(),
            mirror: false,
            border: WebcamBorder {
                enabled: false,
                width: 0,
                color: "#ffffff".to_string(),
            },
            visibility_segments: vec![],
        },
        audio: AudioTrackSettings::default(),
        export: ExportConfig::default(),
        scene: SceneConfig::default(),
        text: TextConfig::default(),
    }
}

fn make_test_frame() -> DecodedFrame {
    DecodedFrame {
        frame_number: 0,
        timestamp_ms: 0,
        data: vec![0u8; 1280 * 720 * 4],
        width: 1280,
        height: 720,
    }
}

/// Helper to calculate expected position matching WebcamOverlay.tsx exactly
fn expected_position_px(
    position: WebcamOverlayPosition,
    custom_x: f32,
    custom_y: f32,
    out_w: u32,
    out_h: u32,
    size: f32,
) -> (f32, f32) {
    const MARGIN: f32 = 16.0;
    let webcam_size_px = out_w as f32 * size;

    match position {
        WebcamOverlayPosition::TopLeft => (MARGIN, MARGIN),
        WebcamOverlayPosition::TopRight => (out_w as f32 - webcam_size_px - MARGIN, MARGIN),
        WebcamOverlayPosition::BottomLeft => (MARGIN, out_h as f32 - webcam_size_px - MARGIN),
        WebcamOverlayPosition::BottomRight => (
            out_w as f32 - webcam_size_px - MARGIN,
            out_h as f32 - webcam_size_px - MARGIN,
        ),
        WebcamOverlayPosition::Custom => {
            let left = if custom_x <= 0.1 {
                MARGIN
            } else if custom_x >= 0.9 {
                out_w as f32 - webcam_size_px - MARGIN
            } else {
                custom_x * out_w as f32 - webcam_size_px / 2.0
            };
            let top = if custom_y <= 0.1 {
                MARGIN
            } else if custom_y >= 0.9 {
                out_h as f32 - webcam_size_px - MARGIN
            } else {
                custom_y * out_h as f32 - webcam_size_px / 2.0
            };
            (left, top)
        },
    }
}

#[test]
fn test_webcam_position_bottom_right() {
    let project = make_test_project(WebcamOverlayPosition::BottomRight, 0.20, 0.0, 0.0);
    let frame = make_test_frame();
    let (out_w, out_h) = (2262, 1228);

    let overlay = build_webcam_overlay(&project, frame, out_w, out_h);
    let (expected_x, expected_y) = expected_position_px(
        WebcamOverlayPosition::BottomRight,
        0.0,
        0.0,
        out_w,
        out_h,
        0.20,
    );

    let actual_x_px = overlay.x * out_w as f32;
    let actual_y_px = overlay.y * out_h as f32;

    assert!(
        (actual_x_px - expected_x).abs() < 1.0,
        "BottomRight X mismatch: expected {:.1}, got {:.1} (diff: {:.2})",
        expected_x,
        actual_x_px,
        (actual_x_px - expected_x).abs()
    );
    assert!(
        (actual_y_px - expected_y).abs() < 1.0,
        "BottomRight Y mismatch: expected {:.1}, got {:.1} (diff: {:.2})",
        expected_y,
        actual_y_px,
        (actual_y_px - expected_y).abs()
    );
}

#[test]
fn test_webcam_position_top_left() {
    let project = make_test_project(WebcamOverlayPosition::TopLeft, 0.20, 0.0, 0.0);
    let frame = make_test_frame();
    let (out_w, out_h) = (1920, 1080);

    let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

    let actual_x_px = overlay.x * out_w as f32;
    let actual_y_px = overlay.y * out_h as f32;

    assert!(
        (actual_x_px - 16.0).abs() < 1.0,
        "TopLeft X should be 16px margin, got {:.1}",
        actual_x_px
    );
    assert!(
        (actual_y_px - 16.0).abs() < 1.0,
        "TopLeft Y should be 16px margin, got {:.1}",
        actual_y_px
    );
}

#[test]
fn test_webcam_position_all_corners() {
    let positions = [
        (WebcamOverlayPosition::TopLeft, "TopLeft"),
        (WebcamOverlayPosition::TopRight, "TopRight"),
        (WebcamOverlayPosition::BottomLeft, "BottomLeft"),
        (WebcamOverlayPosition::BottomRight, "BottomRight"),
    ];
    let (out_w, out_h) = (1920, 1080);
    let size = 0.20;

    for (position, name) in positions {
        let project = make_test_project(position, size, 0.0, 0.0);
        let frame = make_test_frame();
        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

        let (expected_x, expected_y) = expected_position_px(position, 0.0, 0.0, out_w, out_h, size);
        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;

        assert!(
            (actual_x_px - expected_x).abs() < 1.0,
            "{} X mismatch: expected {:.1}, got {:.1}",
            name,
            expected_x,
            actual_x_px
        );
        assert!(
            (actual_y_px - expected_y).abs() < 1.0,
            "{} Y mismatch: expected {:.1}, got {:.1}",
            name,
            expected_y,
            actual_y_px
        );
    }
}

#[test]
fn test_webcam_custom_position_center() {
    let project = make_test_project(WebcamOverlayPosition::Custom, 0.20, 0.5, 0.5);
    let frame = make_test_frame();
    let (out_w, out_h) = (1920, 1080);

    let overlay = build_webcam_overlay(&project, frame, out_w, out_h);
    let webcam_size_px = out_w as f32 * 0.20;

    // Center position: webcam centered at 50% of screen
    let expected_x = 0.5 * out_w as f32 - webcam_size_px / 2.0;
    let expected_y = 0.5 * out_h as f32 - webcam_size_px / 2.0;

    let actual_x_px = overlay.x * out_w as f32;
    let actual_y_px = overlay.y * out_h as f32;

    assert!(
        (actual_x_px - expected_x).abs() < 1.0,
        "Custom center X mismatch: expected {:.1}, got {:.1}",
        expected_x,
        actual_x_px
    );
    assert!(
        (actual_y_px - expected_y).abs() < 1.0,
        "Custom center Y mismatch: expected {:.1}, got {:.1}",
        expected_y,
        actual_y_px
    );
}

#[test]
fn test_webcam_custom_position_edge_snapping() {
    // Test that custom positions near edges (<=0.1 or >=0.9) snap to margin
    let (out_w, out_h) = (1920, 1080);
    let size = 0.20;
    let webcam_size_px = out_w as f32 * size;

    // Test top-left edge snapping (custom_x=0.05, custom_y=0.05)
    let project = make_test_project(WebcamOverlayPosition::Custom, size, 0.05, 0.05);
    let overlay = build_webcam_overlay(&project, make_test_frame(), out_w, out_h);
    let actual_x_px = overlay.x * out_w as f32;
    let actual_y_px = overlay.y * out_h as f32;
    assert!(
        (actual_x_px - 16.0).abs() < 1.0,
        "Edge snap X should be 16px, got {:.1}",
        actual_x_px
    );
    assert!(
        (actual_y_px - 16.0).abs() < 1.0,
        "Edge snap Y should be 16px, got {:.1}",
        actual_y_px
    );

    // Test bottom-right edge snapping (custom_x=0.95, custom_y=0.95)
    let project = make_test_project(WebcamOverlayPosition::Custom, size, 0.95, 0.95);
    let overlay = build_webcam_overlay(&project, make_test_frame(), out_w, out_h);
    let actual_x_px = overlay.x * out_w as f32;
    let actual_y_px = overlay.y * out_h as f32;
    let expected_x = out_w as f32 - webcam_size_px - 16.0;
    let expected_y = out_h as f32 - webcam_size_px - 16.0;
    assert!(
        (actual_x_px - expected_x).abs() < 1.0,
        "Edge snap X should be {:.1}, got {:.1}",
        expected_x,
        actual_x_px
    );
    assert!(
        (actual_y_px - expected_y).abs() < 1.0,
        "Edge snap Y should be {:.1}, got {:.1}",
        expected_y,
        actual_y_px
    );
}

#[test]
fn test_webcam_size_consistency() {
    // The webcam overlay size should be stored as a fraction of width
    let project = make_test_project(WebcamOverlayPosition::BottomRight, 0.20, 0.0, 0.0);
    let frame = make_test_frame();
    let (out_w, out_h) = (2262, 1228);

    let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

    // Size should match what we passed in
    assert!(
        (overlay.size - 0.20).abs() < 0.001,
        "Size should be 0.20, got {}",
        overlay.size
    );

    // Size in pixels should be 20% of width
    let expected_size_px = out_w as f32 * 0.20;
    let actual_size_px = overlay.size * out_w as f32;
    assert!(
        (actual_size_px - expected_size_px).abs() < 1.0,
        "Pixel size should be {:.1}, got {:.1}",
        expected_size_px,
        actual_size_px
    );
}

#[test]
fn test_webcam_position_various_dimensions() {
    // Test positioning works correctly for various output dimensions
    let test_cases: [(u32, u32, &str); 5] = [
        (1920, 1080, "1080p 16:9"),
        (2560, 1440, "1440p 16:9"),
        (1280, 720, "720p 16:9"),
        (2262, 1228, "Custom aspect"),
        (1080, 1920, "Portrait 9:16"),
    ];

    for (out_w, out_h, desc) in test_cases {
        let project = make_test_project(WebcamOverlayPosition::BottomRight, 0.20, 0.0, 0.0);
        let frame = make_test_frame();
        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

        let webcam_size_px = out_w as f32 * 0.20;
        let expected_x = out_w as f32 - webcam_size_px - 16.0;
        let expected_y = out_h as f32 - webcam_size_px - 16.0;

        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;

        assert!(
            (actual_x_px - expected_x).abs() < 1.0,
            "{} ({out_w}x{out_h}) X mismatch: expected {:.1}, got {:.1}",
            desc,
            expected_x,
            actual_x_px
        );
        assert!(
            (actual_y_px - expected_y).abs() < 1.0,
            "{} ({out_w}x{out_h}) Y mismatch: expected {:.1}, got {:.1}",
            desc,
            expected_y,
            actual_y_px
        );
    }
}

#[test]
fn test_webcam_position_different_sizes() {
    // Test different webcam sizes
    let sizes = [0.10, 0.15, 0.20, 0.25, 0.30];
    let (out_w, out_h) = (1920, 1080);

    for size in sizes {
        let project = make_test_project(WebcamOverlayPosition::BottomRight, size, 0.0, 0.0);
        let frame = make_test_frame();
        let overlay = build_webcam_overlay(&project, frame, out_w, out_h);

        let webcam_size_px = out_w as f32 * size;
        let expected_x = out_w as f32 - webcam_size_px - 16.0;
        let expected_y = out_h as f32 - webcam_size_px - 16.0;

        let actual_x_px = overlay.x * out_w as f32;
        let actual_y_px = overlay.y * out_h as f32;

        assert!(
            (actual_x_px - expected_x).abs() < 1.0,
            "Size {:.0}% X mismatch: expected {:.1}, got {:.1}",
            size * 100.0,
            expected_x,
            actual_x_px
        );
        assert!(
            (actual_y_px - expected_y).abs() < 1.0,
            "Size {:.0}% Y mismatch: expected {:.1}, got {:.1}",
            size * 100.0,
            expected_y,
            actual_y_px
        );
    }
}

// ============================================================================
// GPU PIXEL TESTS - Verify actual rendered output matches expected positions
// ============================================================================
//
// These tests render frames through the GPU compositor and verify that
// the webcam overlay appears at the correct pixel coordinates.
//
// Requires GPU - will be skipped in CI without GPU support.
//
// Outputs test images to: src-tauri/src/tests/

/// Save RGBA pixels to a PNG file for visual verification.
fn save_test_image(pixels: &[u8], width: u32, height: u32, filename: &str) {
    use std::path::Path;

    // Output to src-tauri/src/tests/
    let output_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tests");
    if let Err(e) = std::fs::create_dir_all(&output_dir) {
        eprintln!("[WARN] Failed to create output dir: {}", e);
        return;
    }

    let output_path = output_dir.join(filename);

    // Use image crate to save PNG
    match image::RgbaImage::from_raw(width, height, pixels.to_vec()) {
        Some(img) => {
            if let Err(e) = img.save(&output_path) {
                eprintln!("[WARN] Failed to save image: {}", e);
            } else {
                eprintln!("[GPU TEST] Saved: {}", output_path.display());
            }
        },
        None => {
            eprintln!("[WARN] Failed to create image from pixels");
        },
    }
}

/// Create a solid color frame for testing.
fn make_solid_frame(width: u32, height: u32, r: u8, g: u8, b: u8) -> DecodedFrame {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for _ in 0..(width * height) {
        data.extend_from_slice(&[r, g, b, 255]);
    }
    DecodedFrame {
        frame_number: 0,
        timestamp_ms: 0,
        data,
        width,
        height,
    }
}

/// Scan rendered pixels to find the bounding box of webcam content.
/// Looks for pixels that are significantly different from the background.
/// Returns (min_x, min_y, max_x, max_y) in pixels.
fn find_webcam_bounds(
    pixels: &[u8],
    width: u32,
    height: u32,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
) -> Option<(u32, u32, u32, u32)> {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut found = false;

    // Threshold for detecting non-background pixels
    let threshold = 30;

    for y in 0..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            let r = pixels[idx];
            let g = pixels[idx + 1];
            let b = pixels[idx + 2];

            // Check if pixel is significantly different from background
            let dr = (r as i32 - bg_r as i32).abs();
            let dg = (g as i32 - bg_g as i32).abs();
            let db = (b as i32 - bg_b as i32).abs();

            if dr > threshold || dg > threshold || db > threshold {
                found = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }

    if found {
        Some((min_x, min_y, max_x, max_y))
    } else {
        None
    }
}

/// GPU pixel test: Render a frame with webcam overlay and verify position.
/// This test actually renders through wgpu and reads back pixels.
#[test]
fn test_gpu_webcam_pixel_position_bottom_right() {
    // Skip if no GPU available (CI environments)
    let renderer = match pollster::block_on(crate::rendering::renderer::Renderer::new()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[SKIP] GPU not available: {}", e);
            return;
        },
    };

    let compositor = crate::rendering::compositor::Compositor::new(&renderer);

    // Test parameters
    let out_w = 800u32;
    let out_h = 600u32;
    let webcam_size = 0.20f32; // 20% of width = 160px
    let webcam_size_px = out_w as f32 * webcam_size;

    // Create solid blue background frame (screen)
    let screen_frame = make_solid_frame(out_w, out_h, 0, 0, 128); // Dark blue

    // Create solid red webcam frame
    let webcam_frame = make_solid_frame(160, 160, 255, 0, 0); // Bright red

    // Build webcam overlay for BottomRight position
    let project = make_test_project(WebcamOverlayPosition::BottomRight, webcam_size, 0.0, 0.0);
    let overlay = build_webcam_overlay(&project, webcam_frame, out_w, out_h);

    // Create render options
    let render_options = crate::rendering::types::RenderOptions {
        output_width: out_w,
        output_height: out_h,
        zoom: crate::rendering::types::ZoomState::identity(),
        webcam: Some(overlay),
        cursor: None,
        background: Default::default(),
    };

    // Render frame through GPU
    let output_texture = compositor.composite(&renderer, &screen_frame, &render_options, 0.0);

    // Read back pixels
    let pixels = pollster::block_on(renderer.read_texture(&output_texture, out_w, out_h));

    // Save to dev folder for visual verification
    save_test_image(&pixels, out_w, out_h, "webcam_bottom_right.png");

    // Find webcam bounds by detecting red pixels (different from blue background)
    let bounds = find_webcam_bounds(&pixels, out_w, out_h, 0, 0, 128);

    assert!(
        bounds.is_some(),
        "Webcam should be visible in rendered output"
    );
    let (min_x, min_y, max_x, max_y) = bounds.unwrap();

    // Calculate expected position (BottomRight with 16px margin)
    let expected_left = out_w as f32 - webcam_size_px - 16.0;
    let expected_top = out_h as f32 - webcam_size_px - 16.0;
    let expected_right = out_w as f32 - 16.0;
    let expected_bottom = out_h as f32 - 16.0;

    // Allow some tolerance for anti-aliasing and circle shape
    let tolerance = 5.0;

    eprintln!(
        "[GPU TEST] Webcam bounds: ({}, {}) - ({}, {})",
        min_x, min_y, max_x, max_y
    );
    eprintln!(
        "[GPU TEST] Expected bounds: ({:.0}, {:.0}) - ({:.0}, {:.0})",
        expected_left, expected_top, expected_right, expected_bottom
    );

    // Verify left edge (min_x should be close to expected_left)
    assert!(
        (min_x as f32 - expected_left).abs() < tolerance,
        "Left edge mismatch: expected {:.0}, got {} (diff: {:.1})",
        expected_left,
        min_x,
        (min_x as f32 - expected_left).abs()
    );

    // Verify top edge (min_y should be close to expected_top)
    assert!(
        (min_y as f32 - expected_top).abs() < tolerance,
        "Top edge mismatch: expected {:.0}, got {} (diff: {:.1})",
        expected_top,
        min_y,
        (min_y as f32 - expected_top).abs()
    );

    // Verify right edge (max_x should be close to expected_right)
    assert!(
        (max_x as f32 - expected_right).abs() < tolerance,
        "Right edge mismatch: expected {:.0}, got {} (diff: {:.1})",
        expected_right,
        max_x,
        (max_x as f32 - expected_right).abs()
    );

    // Verify bottom edge (max_y should be close to expected_bottom)
    assert!(
        (max_y as f32 - expected_bottom).abs() < tolerance,
        "Bottom edge mismatch: expected {:.0}, got {} (diff: {:.1})",
        expected_bottom,
        max_y,
        (max_y as f32 - expected_bottom).abs()
    );

    eprintln!("[GPU TEST] PASSED: Webcam position verified at pixel level!");
}

/// GPU pixel test: Verify webcam is circular (not oval).
/// Checks that width and height of detected bounds are approximately equal.
#[test]
fn test_gpu_webcam_circle_not_oval() {
    // Skip if no GPU available
    let renderer = match pollster::block_on(crate::rendering::renderer::Renderer::new()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[SKIP] GPU not available: {}", e);
            return;
        },
    };

    let compositor = crate::rendering::compositor::Compositor::new(&renderer);

    // Non-square output to test aspect ratio handling
    let out_w = 1920u32;
    let out_h = 1080u32; // 16:9 aspect ratio
    let webcam_size = 0.15f32;

    let screen_frame = make_solid_frame(out_w, out_h, 0, 0, 64);
    let webcam_frame = make_solid_frame(200, 200, 200, 50, 50); // Reddish

    let project = make_test_project(WebcamOverlayPosition::BottomRight, webcam_size, 0.0, 0.0);
    let overlay = build_webcam_overlay(&project, webcam_frame, out_w, out_h);

    let render_options = crate::rendering::types::RenderOptions {
        output_width: out_w,
        output_height: out_h,
        zoom: crate::rendering::types::ZoomState::identity(),
        webcam: Some(overlay),
        cursor: None,
        background: Default::default(),
    };

    let output_texture = compositor.composite(&renderer, &screen_frame, &render_options, 0.0);
    let pixels = pollster::block_on(renderer.read_texture(&output_texture, out_w, out_h));

    // Save to dev folder for visual verification
    save_test_image(&pixels, out_w, out_h, "webcam_circle_16x9.png");

    let bounds = find_webcam_bounds(&pixels, out_w, out_h, 0, 0, 64);
    assert!(bounds.is_some(), "Webcam should be visible");

    let (min_x, min_y, max_x, max_y) = bounds.unwrap();
    let detected_width = max_x - min_x;
    let detected_height = max_y - min_y;

    eprintln!(
        "[GPU TEST] Detected webcam: {}x{} pixels",
        detected_width, detected_height
    );

    // For a circle, width and height should be approximately equal
    let aspect_ratio = detected_width as f32 / detected_height as f32;

    // Allow 5% tolerance (0.95 - 1.05)
    assert!(
        aspect_ratio > 0.95 && aspect_ratio < 1.05,
        "Webcam should be circular (square bounds), but aspect ratio is {:.3}. Size: {}x{}",
        aspect_ratio,
        detected_width,
        detected_height
    );

    eprintln!(
        "[GPU TEST] PASSED: Webcam is circular (aspect ratio: {:.3})!",
        aspect_ratio
    );
}

/// GPU pixel test: Verify all corner positions.
#[test]
fn test_gpu_webcam_all_corners() {
    // Skip if no GPU available
    let renderer = match pollster::block_on(crate::rendering::renderer::Renderer::new()) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[SKIP] GPU not available: {}", e);
            return;
        },
    };

    let compositor = crate::rendering::compositor::Compositor::new(&renderer);

    let out_w = 640u32;
    let out_h = 480u32;
    let webcam_size = 0.20f32;
    let webcam_size_px = out_w as f32 * webcam_size;
    const MARGIN: f32 = 16.0;
    let tolerance = 5.0;

    let positions = [
        (WebcamOverlayPosition::TopLeft, MARGIN, MARGIN, "TopLeft"),
        (
            WebcamOverlayPosition::TopRight,
            out_w as f32 - webcam_size_px - MARGIN,
            MARGIN,
            "TopRight",
        ),
        (
            WebcamOverlayPosition::BottomLeft,
            MARGIN,
            out_h as f32 - webcam_size_px - MARGIN,
            "BottomLeft",
        ),
        (
            WebcamOverlayPosition::BottomRight,
            out_w as f32 - webcam_size_px - MARGIN,
            out_h as f32 - webcam_size_px - MARGIN,
            "BottomRight",
        ),
    ];

    for (position, expected_x, expected_y, name) in positions {
        let screen_frame = make_solid_frame(out_w, out_h, 30, 30, 30);
        let webcam_frame = make_solid_frame(128, 128, 255, 100, 100);

        let project = make_test_project(position, webcam_size, 0.0, 0.0);
        let overlay = build_webcam_overlay(&project, webcam_frame, out_w, out_h);

        let render_options = crate::rendering::types::RenderOptions {
            output_width: out_w,
            output_height: out_h,
            zoom: crate::rendering::types::ZoomState::identity(),
            webcam: Some(overlay),
            cursor: None,
            background: Default::default(),
        };

        let output_texture = compositor.composite(&renderer, &screen_frame, &render_options, 0.0);
        let pixels = pollster::block_on(renderer.read_texture(&output_texture, out_w, out_h));

        // Save to dev folder for visual verification
        save_test_image(
            &pixels,
            out_w,
            out_h,
            &format!("webcam_{}.png", name.to_lowercase()),
        );

        let bounds = find_webcam_bounds(&pixels, out_w, out_h, 30, 30, 30);
        assert!(bounds.is_some(), "{}: Webcam should be visible", name);

        let (min_x, min_y, _max_x, _max_y) = bounds.unwrap();

        eprintln!(
            "[GPU TEST] {}: found at ({}, {}), expected ({:.0}, {:.0})",
            name, min_x, min_y, expected_x, expected_y
        );

        assert!(
            (min_x as f32 - expected_x).abs() < tolerance,
            "{} X mismatch: expected {:.0}, got {} (diff: {:.1})",
            name,
            expected_x,
            min_x,
            (min_x as f32 - expected_x).abs()
        );

        assert!(
            (min_y as f32 - expected_y).abs() < tolerance,
            "{} Y mismatch: expected {:.0}, got {} (diff: {:.1})",
            name,
            expected_y,
            min_y,
            (min_y as f32 - expected_y).abs()
        );
    }

    eprintln!("[GPU TEST] PASSED: All corner positions verified!");
}

//! Direct2D context, brushes, and text format creation.
//!
//! This module sets up all the Direct2D resources needed for rendering the overlay:
//! - Device context for drawing
//! - Solid color brushes for various elements
//! - Stroke style for dashed crosshair lines
//! - Text format for size indicator

use windows::core::{Interface, Result, PCWSTR};
use windows::Foundation::Numerics::Matrix3x2;
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_TARGET,
    D2D1_BITMAP_PROPERTIES1, D2D1_BRUSH_PROPERTIES, D2D1_CAP_STYLE_FLAT,
    D2D1_DASH_STYLE_CUSTOM, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_LINE_JOIN_MITER,
    D2D1_STROKE_STYLE_PROPERTIES1, D2D1_STROKE_TRANSFORM_TYPE_NORMAL, ID2D1Bitmap1,
    ID2D1Device, ID2D1DeviceContext, ID2D1Factory1, ID2D1RenderTarget, ID2D1SolidColorBrush,
    ID2D1StrokeStyle1,
};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, DWRITE_FACTORY_TYPE_SHARED,
    DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_BOLD,
    DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_CENTER,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGISurface};

/// Color constants for overlay rendering
pub mod colors {
    use super::D2D1_COLOR_F;

    /// Semi-transparent black for dimmed areas
    pub const OVERLAY: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.5,
    };

    /// Blue for selection border
    pub const BORDER: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 0.0,
        g: 0.47,
        b: 1.0,
        a: 1.0,
    };

    /// Blue for crosshair lines (slightly transparent)
    pub const CROSSHAIR: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 0.0,
        g: 0.47,
        b: 1.0,
        a: 0.9,
    };

    /// White for text
    pub const TEXT: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };

    /// Dark semi-transparent for text background
    pub const TEXT_BG: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.75,
    };

    /// White for resize handle fill
    pub const HANDLE_FILL: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };

    /// Blue for resize handle border
    pub const HANDLE_BORDER: D2D1_COLOR_F = D2D1_COLOR_F {
        r: 0.0,
        g: 0.47,
        b: 1.0,
        a: 1.0,
    };
}

/// Collection of brushes used for rendering
pub struct Brushes {
    /// Semi-transparent black for dimmed areas
    pub overlay: ID2D1SolidColorBrush,
    /// Blue for selection border
    pub border: ID2D1SolidColorBrush,
    /// Blue for crosshair lines
    pub crosshair: ID2D1SolidColorBrush,
    /// White for text
    pub text: ID2D1SolidColorBrush,
    /// Dark semi-transparent for text background
    pub text_bg: ID2D1SolidColorBrush,
    /// White for resize handle fill
    pub handle_fill: ID2D1SolidColorBrush,
    /// Blue for resize handle border
    pub handle_border: ID2D1SolidColorBrush,
}

/// All Direct2D rendering resources
pub struct D2DResources {
    /// The D2D factory
    pub factory: ID2D1Factory1,
    /// The device context for drawing
    pub context: ID2D1DeviceContext,
    /// All brushes
    pub brushes: Brushes,
    /// Text format for size indicator
    pub text_format: IDWriteTextFormat,
    /// Stroke style for dashed crosshair
    pub crosshair_stroke: ID2D1StrokeStyle1,
}

/// Create D2D factory and device context from a D3D device.
pub fn create_context(d3d_device: &ID3D11Device) -> Result<(ID2D1Factory1, ID2D1DeviceContext)> {
    unsafe {
        let factory: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
        let dxgi_device: IDXGIDevice = d3d_device.cast()?;
        let d2d_device: ID2D1Device = factory.CreateDevice(&dxgi_device)?;
        let context = d2d_device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;

        Ok((factory, context))
    }
}

/// Create all brushes for rendering.
pub fn create_brushes(context: &ID2D1DeviceContext) -> Result<Brushes> {
    let render_target: ID2D1RenderTarget = context.cast()?;
    let props = D2D1_BRUSH_PROPERTIES {
        opacity: 1.0,
        transform: Matrix3x2::identity(),
    };

    unsafe {
        Ok(Brushes {
            overlay: render_target.CreateSolidColorBrush(&colors::OVERLAY, Some(&props))?,
            border: render_target.CreateSolidColorBrush(&colors::BORDER, Some(&props))?,
            crosshair: render_target.CreateSolidColorBrush(&colors::CROSSHAIR, Some(&props))?,
            text: render_target.CreateSolidColorBrush(&colors::TEXT, Some(&props))?,
            text_bg: render_target.CreateSolidColorBrush(&colors::TEXT_BG, Some(&props))?,
            handle_fill: render_target.CreateSolidColorBrush(&colors::HANDLE_FILL, Some(&props))?,
            handle_border: render_target
                .CreateSolidColorBrush(&colors::HANDLE_BORDER, Some(&props))?,
        })
    }
}

/// Create the dashed stroke style for crosshair lines.
pub fn create_crosshair_stroke(factory: &ID2D1Factory1) -> Result<ID2D1StrokeStyle1> {
    let props = D2D1_STROKE_STYLE_PROPERTIES1 {
        startCap: D2D1_CAP_STYLE_FLAT,
        endCap: D2D1_CAP_STYLE_FLAT,
        dashCap: D2D1_CAP_STYLE_FLAT,
        lineJoin: D2D1_LINE_JOIN_MITER,
        miterLimit: 10.0,
        dashStyle: D2D1_DASH_STYLE_CUSTOM,
        dashOffset: 0.0,
        transformType: D2D1_STROKE_TRANSFORM_TYPE_NORMAL,
    };
    // Custom dash pattern: 4px dash, 4px gap
    let dashes: [f32; 2] = [4.0, 4.0];

    unsafe { factory.CreateStrokeStyle(&props, Some(&dashes)) }
}

/// Create text format for the size indicator.
pub fn create_text_format() -> Result<IDWriteTextFormat> {
    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;

        let font: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
        let locale: Vec<u16> = "en-US\0".encode_utf16().collect();

        let format = factory.CreateTextFormat(
            PCWSTR(font.as_ptr()),
            None,
            DWRITE_FONT_WEIGHT_BOLD,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            14.0,
            PCWSTR(locale.as_ptr()),
        )?;

        format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)?;
        format.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;

        Ok(format)
    }
}

/// Create all D2D resources needed for rendering.
pub fn create_resources(d3d_device: &ID3D11Device) -> Result<D2DResources> {
    let (factory, context) = create_context(d3d_device)?;
    let brushes = create_brushes(&context)?;
    let crosshair_stroke = create_crosshair_stroke(&factory)?;
    let text_format = create_text_format()?;

    Ok(D2DResources {
        factory,
        context,
        brushes,
        text_format,
        crosshair_stroke,
    })
}

/// Create a bitmap from a DXGI surface for rendering.
///
/// This is called each frame to get the back buffer as a D2D bitmap.
pub fn create_target_bitmap(
    context: &ID2D1DeviceContext,
    surface: &IDXGISurface,
) -> Result<ID2D1Bitmap1> {
    let bitmap_props = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        colorContext: std::mem::ManuallyDrop::new(None),
    };

    unsafe { context.CreateBitmapFromDxgiSurface(surface, Some(&bitmap_props)) }
}

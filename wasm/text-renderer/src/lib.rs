//! WASM WebGPU Text Renderer
//!
//! Renders text overlays directly in the browser using WebGPU + glyphon.
//! This eliminates the Rust↔Browser round trip for preview rendering.

use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight, cosmic_text::Align,
};
use serde::Deserialize;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use wgpu::{Device, Queue, Surface, SurfaceConfiguration};

// Embedded fallback font - Noto Sans Regular (subset, ~50KB)
// This ensures text always renders even without network
static EMBEDDED_FONT: &[u8] = include_bytes!("../fonts/NotoSans-Regular.ttf");

/// Initialize panic hook and logging for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    console_log::init_with_level(log::Level::Info).ok();
    log::info!("[TextRenderer] WASM module initialized");
}

/// Text segment data passed from JavaScript
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextSegment {
    pub start: f64,
    pub end: f64,
    pub enabled: bool,
    pub content: String,
    pub center_x: f64,
    pub center_y: f64,
    pub size_x: f64,
    pub size_y: f64,
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: f64,
    pub italic: bool,
    pub color: String,
    pub fade_duration: f64,
}

/// Main text renderer that manages WebGPU resources
#[wasm_bindgen]
pub struct WasmTextRenderer {
    device: Arc<Device>,
    queue: Arc<Queue>,
    surface: Surface<'static>,
    surface_config: SurfaceConfiguration,
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    viewport: Viewport,
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl WasmTextRenderer {
    /// Create a new text renderer attached to a canvas element
    #[wasm_bindgen]
    pub async fn create(canvas_id: &str) -> Result<WasmTextRenderer, JsValue> {
        log::info!("[TextRenderer] Creating renderer for canvas: {}", canvas_id);

        // Get canvas element
        let window = web_sys::window().ok_or("No window")?;
        let document = window.document().ok_or("No document")?;
        let canvas = document
            .get_element_by_id(canvas_id)
            .ok_or("Canvas not found")?
            .dyn_into::<web_sys::HtmlCanvasElement>()?;

        let width = canvas.width();
        let height = canvas.height();

        // Create wgpu instance with WebGPU backend (wgpu 28 API: takes reference)
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        // Create surface from canvas
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| format!("Failed to create surface: {}", e))?;

        // Request adapter (wgpu 28: returns Result, not Option)
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .map_err(|e| format!("Failed to get adapter: {}", e))?;

        // Request device with default limits for browser compatibility
        let (device, queue): (wgpu::Device, wgpu::Queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|e| format!("Failed to get device: {}", e))?;

        let device = Arc::new(device);
        let queue = Arc::new(queue);

        // Configure surface
        let surface_caps = surface.get_capabilities(&adapter);
        let format = surface_caps
            .formats
            .iter()
            .find(|f| f.is_srgb())
            .copied()
            .unwrap_or(surface_caps.formats[0]);

        let surface_config = SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::PreMultiplied,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &surface_config);

        // Initialize text rendering with embedded font (WASM has no system fonts)
        let mut font_system = FontSystem::new();
        font_system.db_mut().load_font_data(EMBEDDED_FONT.to_vec());
        log::info!("[TextRenderer] Embedded font loaded ({} bytes)", EMBEDDED_FONT.len());

        let swash_cache = SwashCache::new();
        let cache = Cache::new(&device);
        let viewport = Viewport::new(&device, &cache);
        let mut text_atlas = TextAtlas::new(&device, &queue, &cache, format);
        let text_renderer = TextRenderer::new(&mut text_atlas, &device, wgpu::MultisampleState::default(), None);

        log::info!("[TextRenderer] Renderer created successfully ({}x{})", width, height);

        Ok(WasmTextRenderer {
            device,
            queue,
            surface,
            surface_config,
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            viewport,
            width,
            height,
        })
    }

    /// Resize the renderer when canvas size changes
    #[wasm_bindgen]
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.width = width;
        self.height = height;
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface.configure(&self.device, &self.surface_config);
        log::debug!("[TextRenderer] Resized to {}x{}", width, height);
    }

    /// Render text segments at the given time
    #[wasm_bindgen]
    pub fn render(&mut self, segments_js: JsValue, time_sec: f64) -> Result<(), JsValue> {
        // Parse segments from JS
        let segments: Vec<TextSegment> = serde_wasm_bindgen::from_value(segments_js)
            .map_err(|e| format!("Failed to parse segments: {}", e))?;

        // Filter active segments
        let active_segments: Vec<TextSegment> = segments
            .into_iter()
            .filter(|s| s.enabled && time_sec >= s.start && time_sec <= s.end)
            .collect();

        // Get surface texture
        let output = self.surface.get_current_texture()
            .map_err(|e| format!("Failed to get surface texture: {}", e))?;
        let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Prepare text buffers - collect all data first to avoid aliasing
        let mut buffers: Vec<Buffer> = Vec::with_capacity(active_segments.len());
        let mut text_areas_data: Vec<(TextBounds, f64, f64, Color)> = Vec::with_capacity(active_segments.len());

        for segment in &active_segments {
            let prepared = prepare_text_buffer(
                &mut self.font_system,
                segment,
                time_sec,
                self.width,
                self.height,
            );
            if let Some((buffer, bounds, color)) = prepared {
                text_areas_data.push((bounds, segment.center_x, segment.center_y, color));
                buffers.push(buffer);
            }
        }

        // Update viewport
        self.viewport.update(
            &self.queue,
            Resolution {
                width: self.width,
                height: self.height,
            },
        );

        // Prepare text areas for rendering
        let text_areas: Vec<TextArea> = buffers
            .iter()
            .zip(text_areas_data.iter())
            .map(|(buffer, (bounds, left, top, color))| {
                let left_px = (*left as f32) * self.width as f32 - (bounds.right - bounds.left) as f32 / 2.0;
                let top_px = (*top as f32) * self.height as f32 - (bounds.bottom - bounds.top) as f32 / 2.0;
                TextArea {
                    buffer,
                    left: left_px,
                    top: top_px,
                    scale: 1.0,
                    bounds: *bounds,
                    default_color: *color,
                    custom_glyphs: &[],
                }
            })
            .collect();

        // Prepare glyphs
        if !text_areas.is_empty() {
            self.text_renderer
                .prepare(
                    &self.device,
                    &self.queue,
                    &mut self.font_system,
                    &mut self.text_atlas,
                    &self.viewport,
                    text_areas,
                    &mut self.swash_cache,
                )
                .map_err(|e| format!("Failed to prepare text: {:?}", e))?;
        }

        // Create render pass
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Text Render Encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Text Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            if !buffers.is_empty() {
                self.text_renderer
                    .render(&self.text_atlas, &self.viewport, &mut pass)
                    .map_err(|e| format!("Failed to render text: {:?}", e))?;
            }
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        Ok(())
    }
}

/// Prepare a single text segment for rendering (free function to avoid aliasing)
fn prepare_text_buffer(
    font_system: &mut FontSystem,
    segment: &TextSegment,
    time_sec: f64,
    canvas_width: u32,
    canvas_height: u32,
) -> Option<(Buffer, TextBounds, Color)> {
    const BASE_TEXT_HEIGHT: f64 = 0.2;

    // Calculate scaling (match Rust renderer exactly)
    let size_scale = (segment.size_y / BASE_TEXT_HEIGHT).clamp(0.25, 4.0);
    let height_scale = canvas_height as f64 / 1080.0;
    let font_size = ((segment.font_size * size_scale).max(1.0) * height_scale).min(256.0) as f32;

    // Calculate bounds
    let width = (segment.size_x * canvas_width as f64).max(1.0) as f32;
    let height = (segment.size_y * canvas_height as f64).max(1.0) as f32;
    let half_w = width / 2.0;
    let half_h = height / 2.0;
    let left = (segment.center_x as f32 * canvas_width as f32 - half_w).max(0.0);
    let top = (segment.center_y as f32 * canvas_height as f32 - half_h).max(0.0);

    // Calculate fade opacity
    let opacity = if segment.fade_duration > 0.0 {
        let time_since_start = (time_sec - segment.start).max(0.0);
        let time_until_end = (segment.end - time_sec).max(0.0);
        let fade_in = (time_since_start / segment.fade_duration).min(1.0);
        let fade_out = (time_until_end / segment.fade_duration).min(1.0);
        (fade_in * fade_out) as f32
    } else {
        1.0
    };

    // Parse color
    let color = parse_color(&segment.color, opacity);

    // Create text buffer
    let metrics = Metrics::new(font_size, font_size * 1.2);
    let mut buffer = Buffer::new(font_system, metrics);
    buffer.set_size(font_system, Some(width), Some(height));
    buffer.set_wrap(font_system, glyphon::Wrap::Word);

    // Set font attributes
    let family = match segment.font_family.trim() {
        "" => Family::SansSerif,
        name => match name.to_ascii_lowercase().as_str() {
            "sans" | "sans-serif" | "system sans" => Family::SansSerif,
            "serif" | "system serif" => Family::Serif,
            "mono" | "monospace" | "system mono" => Family::Monospace,
            _ => Family::Name(name),
        },
    };

    let weight = Weight(segment.font_weight.round().clamp(100.0, 900.0) as u16);
    let attrs = Attrs::new()
        .family(family)
        .color(color)
        .weight(weight)
        .style(if segment.italic {
            glyphon::Style::Italic
        } else {
            glyphon::Style::Normal
        });

    // glyphon 0.10 API: set_text takes 5 args (font_system, text, attrs, shaping, align)
    buffer.set_text(font_system, &segment.content, &attrs, Shaping::Advanced, Some(Align::Center));
    buffer.shape_until_scroll(font_system, false);

    let bounds = TextBounds {
        left: left as i32,
        top: top as i32,
        right: (left + width) as i32,
        bottom: (top + height) as i32,
    };

    Some((buffer, bounds, color))
}

/// Parse hex color string to glyphon Color
fn parse_color(hex: &str, opacity: f32) -> Color {
    let color = hex.trim_start_matches('#');
    if color.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&color[0..2], 16),
            u8::from_str_radix(&color[2..4], 16),
            u8::from_str_radix(&color[4..6], 16),
        ) {
            return Color::rgba(r, g, b, (opacity * 255.0) as u8);
        }
    }
    Color::rgba(255, 255, 255, (opacity * 255.0) as u8)
}

/// Load font data from a URL
async fn load_font_from_url(url: &str) -> Result<Vec<u8>, JsValue> {
    let window = web_sys::window().ok_or("No window")?;
    let response = JsFuture::from(window.fetch_with_str(url)).await?;
    let response: web_sys::Response = response.dyn_into()?;

    if !response.ok() {
        return Err(format!("Failed to fetch font: {}", response.status()).into());
    }

    let array_buffer = JsFuture::from(response.array_buffer()?).await?;
    let uint8_array = js_sys::Uint8Array::new(&array_buffer);
    let mut data = vec![0u8; uint8_array.length() as usize];
    uint8_array.copy_to(&mut data);

    Ok(data)
}

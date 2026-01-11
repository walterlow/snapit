//! Frame compositor using wgpu shaders.
//!
//! Composites video frames with zoom, webcam overlay (with circle/squircle mask and shadow).
//! Also supports background rendering (solid colors, gradients, images).
//! Shadow and squircle implementation based on Cap's rendering.

// Allow unused fields - kept for potential future use
#![allow(dead_code)]

use std::sync::Arc;
use wgpu::{Device, Queue};

use super::background::{Background, BackgroundLayer};
use super::renderer::Renderer;
use super::text::PreparedText;
use super::text_layer::TextLayer;
use super::types::{
    BackgroundStyle, BackgroundType, CornerStyle, DecodedFrame, RenderOptions, WebcamShape,
};

/// WGSL shader for video compositing with zoom, padding, rounding, shadow, border, and webcam overlay.
/// Supports circle, squircle (superellipse), and rounded rectangle shapes with drop shadow.
const COMPOSITOR_SHADER: &str = r#"
struct Uniforms {
    video_size: vec4<f32>,      // width, height, 0, 0
    output_size: vec4<f32>,     // width, height, 0, 0
    zoom: vec4<f32>,            // scale, center_x, center_y, 0
    time_flags: vec4<f32>,      // time_ms, flags, 0, 0
    webcam_rect: vec4<f32>,     // x, y, width, height (normalized 0-1)
    webcam_params: vec4<f32>,   // shape(0=none,1=circle,2=squircle,3=rounded), shadow, mirror, radius
    webcam_shadow: vec4<f32>,   // shadow_size, shadow_opacity, shadow_blur, 0
    webcam_tex_size: vec4<f32>, // texture width, height, aspect_ratio, 0
    // Video frame styling
    frame_bounds: vec4<f32>,    // x, y, width, height in pixels (padded frame area)
    frame_rounding: vec4<f32>,  // rounding_px, rounding_type (0=rounded, 1=squircle), 0, 0
    frame_shadow: vec4<f32>,    // enabled, size, opacity, blur
    frame_border: vec4<f32>,    // enabled, width, opacity, 0
    border_color: vec4<f32>,    // r, g, b, a (linear space)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var video_texture: texture_2d<f32>;
@group(0) @binding(2) var video_sampler: sampler;
@group(0) @binding(3) var webcam_texture: texture_2d<f32>;
@group(0) @binding(4) var webcam_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

// Superellipse norm for squircle (iOS-style rounded corners)
// Power of 4.0 gives the classic squircle shape
fn superellipse_norm(p: vec2<f32>, power: f32) -> f32 {
    let x = pow(abs(p.x), power);
    let y = pow(abs(p.y), power);
    return pow(x + y, 1.0 / power);
}

// Signed distance function for rounded rectangle with configurable corner style
fn sdf_rounded_rect_styled(p: vec2<f32>, half_size: vec2<f32>, radius: f32, rounding_type: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    let outside = max(q, vec2<f32>(0.0));

    // rounding_type: 0 = standard rounded, 1 = squircle
    var outside_len: f32;
    if (rounding_type > 0.5) {
        // Squircle (superellipse with power 4)
        outside_len = superellipse_norm(outside, 4.0);
    } else {
        // Standard rounded corners
        outside_len = length(outside);
    }

    return outside_len + min(max(q.x, q.y), 0.0) - radius;
}

// Signed distance function for circle
fn sdf_circle(p: vec2<f32>, radius: f32) -> f32 {
    return length(p) - radius;
}

// Signed distance function for squircle (superellipse)
fn sdf_squircle(p: vec2<f32>, radius: f32) -> f32 {
    return superellipse_norm(p, 4.0) * radius - radius;
}

// Signed distance function for rounded rectangle
fn sdf_rounded_rect(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let d = abs(p) - half_size + vec2<f32>(radius);
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0) - radius;
}

// Calculate SDF based on shape type (for webcam)
fn webcam_sdf(p: vec2<f32>, half_size: vec2<f32>, shape: f32, corner_radius: f32) -> f32 {
    let radius = min(half_size.x, half_size.y);
    let normalized_p = p / radius;

    if (shape < 1.5) {
        return sdf_circle(normalized_p, 1.0) * radius;
    } else if (shape < 2.5) {
        return sdf_squircle(normalized_p, 1.0) * radius;
    } else {
        return sdf_rounded_rect(p, half_size, corner_radius);
    }
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let pixel_pos = input.uv * uniforms.output_size.xy;

    // Frame bounds and styling
    let frame_pos = uniforms.frame_bounds.xy;
    let frame_size = uniforms.frame_bounds.zw;
    let frame_center = frame_pos + frame_size * 0.5;
    let frame_half_size = frame_size * 0.5;

    let rounding_px = uniforms.frame_rounding.x;
    let rounding_type = uniforms.frame_rounding.y;

    // Master shadow strength (0-100) - matches Cap's model where strength modulates all params
    let master_shadow = uniforms.frame_shadow.x;
    let shadow_enabled = master_shadow > 0.0;
    let shadow_size_param = uniforms.frame_shadow.y;
    let shadow_opacity_param = uniforms.frame_shadow.z;
    let shadow_blur_param = uniforms.frame_shadow.w;

    let border_enabled = uniforms.frame_border.x > 0.5;
    let border_width = uniforms.frame_border.y;
    // border_opacity not used - Cap uses border_color.w directly

    // Calculate SDF for video frame
    let rel_pos = pixel_pos - frame_center;
    let frame_dist = sdf_rounded_rect_styled(rel_pos, frame_half_size, rounding_px, rounding_type);

    // Start with transparent (background shows through)
    var color = vec4<f32>(0.0, 0.0, 0.0, 0.0);

    // Render shadow behind video frame (matching Cap's approach)
    // Master strength multiplies all shadow parameters
    if (shadow_enabled) {
        let min_frame_size = min(frame_half_size.x, frame_half_size.y);
        let strength = master_shadow / 100.0;

        // Apply master strength to all shadow parameters (Cap's formula)
        let shadow_spread = strength * (shadow_size_param / 100.0) * min_frame_size;
        let shadow_opacity = strength * (shadow_opacity_param / 100.0);
        let blur_amount = strength * (shadow_blur_param / 100.0) * min_frame_size;

        // Cap's shadow formula: symmetric smoothstep with abs(distance)
        let shadow_strength = smoothstep(shadow_spread + blur_amount, -blur_amount, abs(frame_dist));
        let shadow_alpha = shadow_strength * shadow_opacity;

        if (shadow_alpha > 0.001) {
            color = vec4<f32>(0.0, 0.0, 0.0, shadow_alpha);
        }
    }

    // Render border around video frame
    if (border_enabled && border_width > 0.0) {
        let border_outer_dist = sdf_rounded_rect_styled(
            rel_pos,
            frame_half_size + vec2<f32>(border_width),
            rounding_px + border_width,
            rounding_type
        );

        if (border_outer_dist <= 0.0 && frame_dist > 0.0) {
            // Inside border ring
            let inner_alpha = smoothstep(-0.5, 0.5, frame_dist);
            let outer_alpha = 1.0 - smoothstep(-0.5, 0.5, border_outer_dist);
            let edge_alpha = inner_alpha * outer_alpha;

            let border_alpha = edge_alpha * uniforms.border_color.w;
            let border_rgb = uniforms.border_color.xyz;
            color = mix(color, vec4<f32>(border_rgb, 1.0), border_alpha);
        }
    }

    // Render video frame content
    if (frame_dist <= 0.0) {
        let zoom_scale = uniforms.zoom.x;
        let zoom_center = vec2<f32>(uniforms.zoom.y, uniforms.zoom.z);

        // Calculate UV within the frame bounds
        let frame_uv = (pixel_pos - frame_pos) / frame_size;

        // Apply zoom transformation
        var video_uv = frame_uv;
        if (zoom_scale > 1.0) {
            video_uv = (frame_uv - zoom_center) / zoom_scale + zoom_center;
        }
        video_uv = clamp(video_uv, vec2<f32>(0.0), vec2<f32>(1.0));

        // Sample video
        var video_color = textureSample(video_texture, video_sampler, video_uv);

        // Anti-alias the edges (matching Cap's approach)
        let anti_alias_width = max(fwidth(frame_dist), 0.5);
        let coverage = clamp(1.0 - smoothstep(0.0, anti_alias_width, frame_dist), 0.0, 1.0);
        video_color.a = video_color.a * coverage;

        // Blend video over shadow/border
        color = mix(color, video_color, video_color.a);
    }

    // Webcam overlay (on top of everything)
    let webcam_shape = uniforms.webcam_params.x;
    if (webcam_shape > 0.5) {
        let webcam_pos = uniforms.webcam_rect.xy;
        let webcam_size = uniforms.webcam_rect.zw;
        let webcam_shadow_strength = uniforms.webcam_params.y;
        let mirror = uniforms.webcam_params.z;
        let corner_radius = uniforms.webcam_params.w;

        let webcam_shadow_size = uniforms.webcam_shadow.x;
        let webcam_shadow_opacity = uniforms.webcam_shadow.y;
        let webcam_shadow_blur = uniforms.webcam_shadow.z;

        let webcam_center = webcam_pos + webcam_size * 0.5;
        let webcam_half_size = webcam_size * 0.5;

        let webcam_rel_pos = input.uv - webcam_center;
        let webcam_pixel_pos = webcam_rel_pos * uniforms.output_size.xy;
        let webcam_pixel_half_size = webcam_half_size * uniforms.output_size.xy;
        let min_webcam_size = min(webcam_pixel_half_size.x, webcam_pixel_half_size.y);

        let normalized_webcam_pos = webcam_pixel_pos / min_webcam_size;
        let normalized_webcam_half = vec2<f32>(1.0, 1.0);

        let webcam_dist = webcam_sdf(normalized_webcam_pos, normalized_webcam_half, webcam_shape, corner_radius / min_webcam_size);

        // Webcam shadow
        if (webcam_shadow_strength > 0.0 && webcam_dist > 0.0) {
            let ws_spread = webcam_shadow_size * 0.5;
            let ws_blur = webcam_shadow_blur * 0.5;
            let ws_dist = webcam_dist - ws_spread;
            let ws_alpha = (1.0 - smoothstep(-ws_blur, ws_blur * 2.0, ws_dist)) * webcam_shadow_opacity * webcam_shadow_strength;

            if (ws_alpha > 0.001) {
                color = mix(color, vec4<f32>(0.0, 0.0, 0.0, 1.0), ws_alpha);
            }
        }

        // Webcam content
        let webcam_aa_width = fwidth(webcam_dist) * 2.0;
        if (webcam_dist <= webcam_aa_width) {
            var webcam_uv = (input.uv - webcam_pos) / webcam_size;

            if (mirror > 0.5) {
                webcam_uv.x = 1.0 - webcam_uv.x;
            }

            let aspect = uniforms.webcam_tex_size.z;
            if (aspect > 1.0) {
                let crop_amount = (1.0 - 1.0 / aspect) * 0.5;
                webcam_uv.x = crop_amount + webcam_uv.x * (1.0 / aspect);
            } else if (aspect < 1.0) {
                let crop_amount = (1.0 - aspect) * 0.5;
                webcam_uv.y = crop_amount + webcam_uv.y * aspect;
            }

            webcam_uv = clamp(webcam_uv, vec2<f32>(0.0), vec2<f32>(1.0));

            let webcam_color = textureSample(webcam_texture, webcam_sampler, webcam_uv);
            let webcam_alpha = 1.0 - smoothstep(-webcam_aa_width, webcam_aa_width, webcam_dist);
            color = mix(color, webcam_color, webcam_alpha * webcam_color.a);
        }
    }

    return color;
}
"#;

/// Extended uniforms including webcam and frame styling parameters.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ExtendedUniforms {
    pub video_size: [f32; 4],
    pub output_size: [f32; 4],
    pub zoom: [f32; 4],
    pub time_flags: [f32; 4],
    pub webcam_rect: [f32; 4],
    pub webcam_params: [f32; 4], // shape, shadow_strength, mirror, corner_radius
    pub webcam_shadow: [f32; 4], // shadow_size, shadow_opacity, shadow_blur, 0
    pub webcam_tex_size: [f32; 4],
    // Video frame styling
    pub frame_bounds: [f32; 4],   // x, y, width, height in pixels
    pub frame_rounding: [f32; 4], // rounding_px, rounding_type, 0, 0
    pub frame_shadow: [f32; 4],   // enabled, size, opacity, blur
    pub frame_border: [f32; 4],   // enabled, width, opacity, 0
    pub border_color: [f32; 4],   // r, g, b, a
}

/// Compositor for GPU-accelerated frame rendering.
pub struct Compositor {
    device: Arc<Device>,
    queue: Arc<Queue>,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffer: wgpu::Buffer,
    sampler: wgpu::Sampler,
    // Placeholder texture for when webcam is not used
    placeholder_texture: wgpu::Texture,
    placeholder_view: wgpu::TextureView,
    // Background layer for rendering backgrounds
    background_layer: BackgroundLayer,
    // Text layer for GPU text rendering
    text_layer: TextLayer,
}

impl Compositor {
    /// Create a new compositor.
    pub fn new(renderer: &Renderer) -> Self {
        let device = Arc::clone(renderer.device());
        let queue = Arc::clone(renderer.queue());

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Compositor Shader"),
            source: wgpu::ShaderSource::Wgsl(COMPOSITOR_SHADER.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Compositor Bind Group Layout"),
            entries: &[
                // Uniforms
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // Video texture
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Video sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Webcam texture
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Webcam sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Compositor Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Compositor Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: renderer.format(),
                    // Use alpha blending so background shows through transparent areas
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Compositor Uniforms"),
            size: std::mem::size_of::<ExtendedUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Video Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        // Create 1x1 placeholder texture for when webcam is not used
        let placeholder_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Placeholder Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &placeholder_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[0u8, 0, 0, 0],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let placeholder_view =
            placeholder_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Initialize background layer
        let background_layer = BackgroundLayer::new(&device);

        // Initialize text layer
        let text_layer = TextLayer::new(&device, &queue);

        Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            uniform_buffer,
            sampler,
            placeholder_texture,
            placeholder_view,
            background_layer,
            text_layer,
        }
    }

    /// Convert BackgroundStyle to Background for rendering.
    fn background_from_style(style: &BackgroundStyle) -> Background {
        match &style.background_type {
            BackgroundType::None => Background::None,
            BackgroundType::Solid(color) => Background::Color(*color),
            BackgroundType::Gradient { start, end, angle } => Background::Gradient {
                start: *start,
                end: *end,
                angle: *angle,
            },
            BackgroundType::Wallpaper(path) => Background::Wallpaper { path: path.clone() },
            BackgroundType::Image(path) => Background::Image { path: path.clone() },
        }
    }

    /// Composite a frame with the given options.
    /// Now supports background rendering (solid colors, gradients).
    pub async fn composite(
        &mut self,
        renderer: &Renderer,
        frame: &DecodedFrame,
        options: &RenderOptions,
        time_ms: f32,
    ) -> wgpu::Texture {
        // Prepare background if needed
        let background = Self::background_from_style(&options.background);

        // Log background setup on first frame (time_ms near 0)
        if time_ms < 100.0 && time_ms >= 0.0 {
            match &background {
                Background::None => log::info!("[COMPOSITOR] Background: None"),
                Background::Color(c) => log::info!("[COMPOSITOR] Background: Color {:?}", c),
                Background::Gradient { start, end, angle } => {
                    log::info!(
                        "[COMPOSITOR] Background: Gradient start={:?} end={:?} angle={}",
                        start,
                        end,
                        angle
                    );
                },
                Background::Wallpaper { path } => {
                    log::info!("[COMPOSITOR] Background: Wallpaper {}", path)
                },
                Background::Image { path } => log::info!("[COMPOSITOR] Background: Image {}", path),
            }
        }

        if !matches!(background, Background::None) {
            if let Err(e) = self
                .background_layer
                .prepare(
                    &self.device,
                    &self.queue,
                    options.output_width,
                    options.output_height,
                    background,
                )
                .await
            {
                log::warn!("Failed to prepare background: {}", e);
            }
        }
        // Create video texture
        let video_texture = renderer.create_texture_from_rgba(
            &frame.data,
            frame.width,
            frame.height,
            "Video Frame",
        );
        let video_view = video_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create webcam texture if present
        let webcam_texture_storage: Option<wgpu::Texture>;
        let (webcam_rect, webcam_params, webcam_shadow, webcam_tex_size) =
            if let Some(ref webcam) = options.webcam {
                webcam_texture_storage = Some(renderer.create_texture_from_rgba(
                    &webcam.frame.data,
                    webcam.frame.width,
                    webcam.frame.height,
                    "Webcam Frame",
                ));

                // Shape: 1=Circle, 2=Squircle, 3=RoundedRect
                let shape = match webcam.shape {
                    WebcamShape::Circle => 1.0,
                    WebcamShape::Squircle => 2.0,
                    WebcamShape::Rectangle => 3.0, // Rectangle uses RoundedRect with radius=0
                    WebcamShape::RoundedRect { .. } => 3.0,
                };
                let radius = match webcam.shape {
                    WebcamShape::RoundedRect { radius } => radius as f32,
                    _ => 0.0,
                };

                // Calculate webcam texture aspect ratio for proper cropping
                let webcam_aspect = webcam.frame.width as f32 / webcam.frame.height as f32;

                // Calculate webcam overlay dimensions
                let output_aspect = options.output_width as f32 / options.output_height as f32;
                let (webcam_width_norm, webcam_height_norm) = if webcam.use_source_aspect {
                    // Source shape: preserve native webcam aspect ratio
                    // Like Cap: base size is the smaller dimension
                    if webcam_aspect >= 1.0 {
                        // Landscape webcam: width = size * aspect, height = size (in pixels)
                        (webcam.size * webcam_aspect, webcam.size * output_aspect)
                    } else {
                        // Portrait webcam: width = size, height = size / aspect (in pixels)
                        (webcam.size, webcam.size * output_aspect / webcam_aspect)
                    }
                } else {
                    // Square/Circle/Rectangle: force 1:1 in PIXELS (not normalized coords)
                    (webcam.size, webcam.size * output_aspect)
                };

                (
                    [webcam.x, webcam.y, webcam_width_norm, webcam_height_norm],
                    [
                        shape,
                        webcam.shadow, // shadow_strength
                        if webcam.mirror { 1.0 } else { 0.0 },
                        radius,
                    ],
                    [
                        webcam.shadow_size,
                        webcam.shadow_opacity,
                        webcam.shadow_blur,
                        0.0,
                    ],
                    [
                        webcam.frame.width as f32,
                        webcam.frame.height as f32,
                        webcam_aspect,
                        0.0,
                    ],
                )
            } else {
                webcam_texture_storage = None;
                (
                    [0.0, 0.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0, 0.0], // shape=0 means no webcam
                    [0.0, 0.0, 0.0, 0.0], // no shadow
                    [1.0, 1.0, 1.0, 0.0], // Default 1:1 aspect
                )
            };

        let webcam_view = webcam_texture_storage
            .as_ref()
            .map(|t| t.create_view(&wgpu::TextureViewDescriptor::default()))
            .unwrap_or_else(|| {
                self.placeholder_texture
                    .create_view(&wgpu::TextureViewDescriptor::default())
            });

        // Create output texture
        let output_texture =
            renderer.create_output_texture(options.output_width, options.output_height);
        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Calculate frame bounds based on padding
        let out_w = options.output_width as f32;
        let out_h = options.output_height as f32;
        let padding = options.background.padding;

        // Frame is centered with padding on all sides
        let frame_x = padding;
        let frame_y = padding;
        let frame_w = out_w - padding * 2.0;
        let frame_h = out_h - padding * 2.0;

        // Ensure frame doesn't become negative
        let frame_w = frame_w.max(1.0);
        let frame_h = frame_h.max(1.0);

        // Rounding type: 0 = rounded, 1 = squircle
        let rounding_type = match options.background.rounding_type {
            CornerStyle::Rounded => 0.0,
            CornerStyle::Squircle => 1.0,
        };

        // Frame styling uniforms
        let frame_bounds = [frame_x, frame_y, frame_w, frame_h];
        let frame_rounding = [options.background.rounding, rounding_type, 0.0, 0.0];
        // frame_shadow.x = master strength (0-100, 0 = disabled) - matches Cap's model
        let frame_shadow = [
            if options.background.shadow.enabled {
                options.background.shadow.strength
            } else {
                0.0
            },
            options.background.shadow.size,
            options.background.shadow.opacity,
            options.background.shadow.blur,
        ];
        let frame_border = [
            if options.background.border.enabled {
                1.0
            } else {
                0.0
            },
            options.background.border.width,
            0.0, // unused - border opacity comes from border_color.w
            0.0,
        ];
        let border_color = options.background.border.color;

        // Update uniforms
        let uniforms = ExtendedUniforms {
            video_size: [frame.width as f32, frame.height as f32, 0.0, 0.0],
            output_size: [out_w, out_h, 0.0, 0.0],
            zoom: [
                options.zoom.scale,
                options.zoom.center_x,
                options.zoom.center_y,
                0.0,
            ],
            time_flags: [time_ms, 0.0, 0.0, 0.0],
            webcam_rect,
            webcam_params,
            webcam_shadow,
            webcam_tex_size,
            frame_bounds,
            frame_rounding,
            frame_shadow,
            frame_border,
            border_color,
        };
        self.queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        // Create bind group
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Compositor Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&video_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&webcam_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });

        // Render
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Compositor Encoder"),
            });

        // First pass: Render background (if any)
        if self.background_layer.has_background() {
            let mut bg_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Background Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            self.background_layer.render(&mut bg_pass);
        }

        // Second pass: Render video and webcam overlay
        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Compositor Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // If we have a background, load it; otherwise clear to black
                        load: if self.background_layer.has_background() {
                            wgpu::LoadOp::Load
                        } else {
                            wgpu::LoadOp::Clear(wgpu::Color::BLACK)
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&self.pipeline);
            render_pass.set_bind_group(0, &bind_group, &[]);
            render_pass.draw(0..3, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));

        output_texture
    }

    /// Composite a frame with text overlays.
    ///
    /// This is the main entry point for rendering with text support.
    pub async fn composite_with_text(
        &mut self,
        renderer: &Renderer,
        frame: &DecodedFrame,
        options: &RenderOptions,
        time_ms: f32,
        texts: &[PreparedText],
    ) -> wgpu::Texture {
        // First, do the regular composite (background, video, webcam)
        let output_texture = self.composite(renderer, frame, options, time_ms).await;

        // If there are texts to render, add them on top
        if !texts.is_empty() {
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

            // Prepare text for rendering
            self.text_layer.prepare(
                &self.device,
                &self.queue,
                (options.output_width, options.output_height),
                texts,
            );

            // Render text in a third pass
            if self.text_layer.has_texts() {
                let mut encoder =
                    self.device
                        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                            label: Some("Text Encoder"),
                        });

                {
                    let mut text_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Text Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &output_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    self.text_layer.render(&mut text_pass);
                }

                self.queue.submit(Some(encoder.finish()));
            }
        }

        output_texture
    }

    /// Render only text overlays on a transparent background.
    ///
    /// This is used during playback when HTML video handles the video frame
    /// but we need accurate text rendering via GPU.
    pub fn composite_text_only(
        &mut self,
        output_width: u32,
        output_height: u32,
        texts: &[PreparedText],
    ) -> wgpu::Texture {
        // Create transparent output texture
        // Must use Rgba8UnormSrgb to match glyphon pipeline format
        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Text Only Output"),
            size: wgpu::Extent3d {
                width: output_width,
                height: output_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        if texts.is_empty() {
            // Return empty transparent texture
            return output_texture;
        }

        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Prepare text for rendering
        self.text_layer.prepare(
            &self.device,
            &self.queue,
            (output_width, output_height),
            texts,
        );

        // Render text on transparent background
        if self.text_layer.has_texts() {
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Text Only Encoder"),
                });

            {
                let mut text_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Text Only Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            // Clear to transparent (0, 0, 0, 0)
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                self.text_layer.render(&mut text_pass);
            }

            self.queue.submit(Some(encoder.finish()));
        }

        output_texture
    }
}

//! Background rendering layer for video compositing.
//!
//! Supports solid colors, gradients, and image backgrounds.
//! Adapted from Cap's rendering engine.

use bytemuck::{Pod, Zeroable};
use image::GenericImageView;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use wgpu::util::DeviceExt;

use super::types::BackgroundType as RenderBackgroundType;

/// Background variant for rendering.
/// Matches Cap's Background enum structure.
#[derive(Debug, Clone, PartialEq)]
pub enum Background {
    /// No background (transparent).
    None,
    /// Solid color [R, G, B, A] in linear space.
    Color([f32; 4]),
    /// Linear gradient with start/end colors and angle.
    Gradient {
        start: [f32; 4],
        end: [f32; 4],
        angle: f32,
    },
    /// Built-in wallpaper preset (path relative to assets/backgrounds/).
    Wallpaper { path: String },
    /// Custom image background from file path.
    Image { path: String },
}

impl Default for Background {
    fn default() -> Self {
        Self::None
    }
}

impl Background {
    /// Create a solid color background from RGBA values (0.0-1.0).
    pub fn solid(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self::Color([r, g, b, a])
    }

    /// Create a gradient background.
    pub fn gradient(start: [f32; 4], end: [f32; 4], angle: f32) -> Self {
        Self::Gradient { start, end, angle }
    }

    /// Create from rendering types.
    pub fn from_render_type(bg_type: &RenderBackgroundType) -> Self {
        match bg_type {
            RenderBackgroundType::None => Self::None,
            RenderBackgroundType::Solid(color) => Self::Color(*color),
            RenderBackgroundType::Gradient { start, end, angle } => Self::Gradient {
                start: *start,
                end: *end,
                angle: *angle,
            },
            RenderBackgroundType::Wallpaper(path) => Self::Wallpaper { path: path.clone() },
            RenderBackgroundType::Image(path) => Self::Image { path: path.clone() },
        }
    }
}

/// Convert sRGB (0-255) to linear color space (0.0-1.0).
pub fn srgb_to_linear(value: u8) -> f32 {
    let v = value as f32 / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Parse a hex color string to linear RGBA.
pub fn hex_to_linear_rgba(hex: &str) -> [f32; 4] {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
    let a = if hex.len() >= 8 {
        u8::from_str_radix(&hex[6..8], 16).unwrap_or(255)
    } else {
        255
    };
    [
        srgb_to_linear(r),
        srgb_to_linear(g),
        srgb_to_linear(b),
        a as f32 / 255.0,
    ]
}

/// Internal state for background rendering.
enum BackgroundInner {
    Image {
        path: String,
        bind_group: wgpu::BindGroup,
    },
    ColorOrGradient {
        value: Background,
        #[allow(unused)]
        buffer: wgpu::Buffer,
        bind_group: wgpu::BindGroup,
    },
}

/// Background rendering layer.
pub struct BackgroundLayer {
    inner: Option<BackgroundInner>,
    image_pipeline: ImageBackgroundPipeline,
    color_pipeline: GradientOrColorPipeline,
    image_textures: Arc<RwLock<HashMap<String, wgpu::Texture>>>,
}

impl BackgroundLayer {
    /// Create a new background layer.
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            inner: None,
            image_pipeline: ImageBackgroundPipeline::new(device),
            color_pipeline: GradientOrColorPipeline::new(device),
            image_textures: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Prepare the background for rendering.
    pub async fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        output_width: u32,
        output_height: u32,
        background: Background,
    ) -> Result<(), String> {
        match background {
            Background::None => {
                self.inner = None;
            },
            Background::Image { ref path } => {
                // Check if we already have this image loaded
                match &self.inner {
                    Some(BackgroundInner::Image {
                        path: current_path, ..
                    }) if current_path == path => {
                        // Already prepared
                        return Ok(());
                    },
                    _ => {},
                }

                // Load and cache image texture
                let mut textures = self.image_textures.write().await;
                let texture = match textures.entry(path.clone()) {
                    std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                    std::collections::hash_map::Entry::Vacant(e) => {
                        let img = match image::open(path) {
                            Ok(img) => img,
                            Err(err) => {
                                log::warn!(
                                    "Failed to load background image '{}': {}. Falling back to black.",
                                    path,
                                    err
                                );
                                // Fall back to black color
                                let buffer =
                                    GradientOrColorUniforms::from_color([0.0, 0.0, 0.0, 1.0])
                                        .to_buffer(device);
                                self.inner = Some(BackgroundInner::ColorOrGradient {
                                    value: Background::Color([0.0, 0.0, 0.0, 1.0]),
                                    bind_group: self.color_pipeline.bind_group(device, &buffer),
                                    buffer,
                                });
                                return Ok(());
                            },
                        };
                        let rgba = img.to_rgba8();
                        let dimensions = img.dimensions();

                        let texture = device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("Background Image Texture"),
                            size: wgpu::Extent3d {
                                width: dimensions.0,
                                height: dimensions.1,
                                depth_or_array_layers: 1,
                            },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: wgpu::TextureFormat::Rgba8UnormSrgb,
                            usage: wgpu::TextureUsages::TEXTURE_BINDING
                                | wgpu::TextureUsages::COPY_DST,
                            view_formats: &[],
                        });

                        queue.write_texture(
                            wgpu::TexelCopyTextureInfo {
                                texture: &texture,
                                mip_level: 0,
                                origin: wgpu::Origin3d::ZERO,
                                aspect: wgpu::TextureAspect::All,
                            },
                            &rgba,
                            wgpu::TexelCopyBufferLayout {
                                offset: 0,
                                bytes_per_row: Some(4 * dimensions.0),
                                rows_per_image: Some(dimensions.1),
                            },
                            wgpu::Extent3d {
                                width: dimensions.0,
                                height: dimensions.1,
                                depth_or_array_layers: 1,
                            },
                        );

                        e.insert(texture)
                    },
                };

                // Calculate aspect ratio correction for cover scaling
                let output_ar = output_height as f32 / output_width as f32;
                let image_ar = texture.height() as f32 / texture.width() as f32;

                let y_height = if output_ar < image_ar {
                    ((image_ar - output_ar) / 2.0) / image_ar
                } else {
                    0.0
                };

                let x_width = if output_ar > image_ar {
                    let output_ar_inv = 1.0 / output_ar;
                    let image_ar_inv = 1.0 / image_ar;
                    ((image_ar_inv - output_ar_inv) / 2.0) / image_ar_inv
                } else {
                    0.0
                };

                let image_uniforms = ImageBackgroundUniforms {
                    output_size: [output_width as f32, output_height as f32],
                    padding: 0.0,
                    x_width,
                    y_height,
                    _padding: 0.0,
                };

                let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Image Background Uniforms"),
                    contents: bytemuck::cast_slice(&[image_uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

                let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

                self.inner = Some(BackgroundInner::Image {
                    path: path.clone(),
                    bind_group: self.image_pipeline.bind_group(
                        device,
                        &uniform_buffer,
                        &texture_view,
                    ),
                });
            },
            Background::Color(color) => {
                // Check if we already have this color
                match &self.inner {
                    Some(BackgroundInner::ColorOrGradient {
                        value: Background::Color(current_color),
                        ..
                    }) if current_color == &color => {
                        return Ok(());
                    },
                    _ => {},
                }

                let buffer = GradientOrColorUniforms::from_color(color).to_buffer(device);
                self.inner = Some(BackgroundInner::ColorOrGradient {
                    value: Background::Color(color),
                    bind_group: self.color_pipeline.bind_group(device, &buffer),
                    buffer,
                });
            },
            Background::Gradient { start, end, angle } => {
                // Check if we already have this gradient
                match &self.inner {
                    Some(BackgroundInner::ColorOrGradient {
                        value:
                            Background::Gradient {
                                start: cs,
                                end: ce,
                                angle: ca,
                            },
                        ..
                    }) if cs == &start && ce == &end && (ca - angle).abs() < 0.01 => {
                        return Ok(());
                    },
                    _ => {},
                }

                let buffer =
                    GradientOrColorUniforms::from_gradient(start, end, angle).to_buffer(device);
                self.inner = Some(BackgroundInner::ColorOrGradient {
                    value: Background::Gradient { start, end, angle },
                    bind_group: self.color_pipeline.bind_group(device, &buffer),
                    buffer,
                });
            },
            Background::Wallpaper { ref path } => {
                // Wallpaper is similar to Image but path is relative to assets/backgrounds/
                // For now, treat it the same as Image - the path resolution happens at a higher level
                // Check if we already have this wallpaper loaded
                match &self.inner {
                    Some(BackgroundInner::Image {
                        path: current_path, ..
                    }) if current_path == path => {
                        return Ok(());
                    },
                    _ => {},
                }

                // Load and cache wallpaper texture (same as Image)
                let mut textures = self.image_textures.write().await;
                let texture = match textures.entry(path.clone()) {
                    std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                    std::collections::hash_map::Entry::Vacant(e) => {
                        let img = match image::open(path) {
                            Ok(img) => img,
                            Err(err) => {
                                log::warn!(
                                    "Failed to load wallpaper '{}': {}. Falling back to black.",
                                    path,
                                    err
                                );
                                let buffer =
                                    GradientOrColorUniforms::from_color([0.0, 0.0, 0.0, 1.0])
                                        .to_buffer(device);
                                self.inner = Some(BackgroundInner::ColorOrGradient {
                                    value: Background::Color([0.0, 0.0, 0.0, 1.0]),
                                    bind_group: self.color_pipeline.bind_group(device, &buffer),
                                    buffer,
                                });
                                return Ok(());
                            },
                        };
                        let rgba = img.to_rgba8();
                        let dimensions = img.dimensions();

                        let texture = device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("Wallpaper Texture"),
                            size: wgpu::Extent3d {
                                width: dimensions.0,
                                height: dimensions.1,
                                depth_or_array_layers: 1,
                            },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: wgpu::TextureFormat::Rgba8UnormSrgb,
                            usage: wgpu::TextureUsages::TEXTURE_BINDING
                                | wgpu::TextureUsages::COPY_DST,
                            view_formats: &[],
                        });

                        queue.write_texture(
                            wgpu::TexelCopyTextureInfo {
                                texture: &texture,
                                mip_level: 0,
                                origin: wgpu::Origin3d::ZERO,
                                aspect: wgpu::TextureAspect::All,
                            },
                            &rgba,
                            wgpu::TexelCopyBufferLayout {
                                offset: 0,
                                bytes_per_row: Some(4 * dimensions.0),
                                rows_per_image: Some(dimensions.1),
                            },
                            wgpu::Extent3d {
                                width: dimensions.0,
                                height: dimensions.1,
                                depth_or_array_layers: 1,
                            },
                        );

                        e.insert(texture)
                    },
                };

                // Calculate aspect ratio correction for cover scaling
                let output_ar = output_height as f32 / output_width as f32;
                let image_ar = texture.height() as f32 / texture.width() as f32;

                let y_height = if output_ar < image_ar {
                    ((image_ar - output_ar) / 2.0) / image_ar
                } else {
                    0.0
                };

                let x_width = if output_ar > image_ar {
                    let output_ar_inv = 1.0 / output_ar;
                    let image_ar_inv = 1.0 / image_ar;
                    ((image_ar_inv - output_ar_inv) / 2.0) / image_ar_inv
                } else {
                    0.0
                };

                let image_uniforms = ImageBackgroundUniforms {
                    output_size: [output_width as f32, output_height as f32],
                    padding: 0.0,
                    x_width,
                    y_height,
                    _padding: 0.0,
                };

                let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Wallpaper Uniforms"),
                    contents: bytemuck::cast_slice(&[image_uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

                let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

                self.inner = Some(BackgroundInner::Image {
                    path: path.clone(),
                    bind_group: self.image_pipeline.bind_group(
                        device,
                        &uniform_buffer,
                        &texture_view,
                    ),
                });
            },
        }

        Ok(())
    }

    /// Render the background to the given render pass.
    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        match &self.inner {
            Some(BackgroundInner::Image { bind_group, .. }) => {
                pass.set_pipeline(&self.image_pipeline.render_pipeline);
                pass.set_bind_group(0, bind_group, &[]);
                pass.draw(0..4, 0..1);
            },
            Some(BackgroundInner::ColorOrGradient { bind_group, .. }) => {
                pass.set_pipeline(&self.color_pipeline.render_pipeline);
                pass.set_bind_group(0, bind_group, &[]);
                pass.draw(0..4, 0..1);
            },
            None => {
                // No background to render
            },
        }
    }

    /// Check if a background is configured.
    pub fn has_background(&self) -> bool {
        self.inner.is_some()
    }
}

// =============================================================================
// Image Background Pipeline
// =============================================================================

struct ImageBackgroundPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct ImageBackgroundUniforms {
    output_size: [f32; 2],
    padding: f32,
    x_width: f32,
    y_height: f32,
    _padding: f32,
}

impl ImageBackgroundPipeline {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ImageBackgroundBindGroupLayout"),
            entries: &[
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
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let shader_source = include_str!("shaders/image-background.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Image Background Shader"),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ImageBackgroundPipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("ImageBackgroundPipelineLayout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
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
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn bind_group(
        &self,
        device: &wgpu::Device,
        uniforms: &wgpu::Buffer,
        texture: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ImageBackgroundBindGroup"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(texture),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        })
    }
}

// =============================================================================
// Gradient or Color Pipeline
// =============================================================================

struct GradientOrColorPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
struct GradientOrColorUniforms {
    start: [f32; 4],
    end: [f32; 4],
    angle: f32,
    _padding: [f32; 3],
}

impl GradientOrColorUniforms {
    fn from_color(color: [f32; 4]) -> Self {
        // Pre-multiply alpha for correct blending
        let premul = [
            color[0] * color[3],
            color[1] * color[3],
            color[2] * color[3],
            color[3],
        ];
        Self {
            start: premul,
            end: premul,
            angle: 0.0,
            _padding: [0.0; 3],
        }
    }

    fn from_gradient(start: [f32; 4], end: [f32; 4], angle: f32) -> Self {
        // Pre-multiply alpha for correct blending
        let start_premul = [
            start[0] * start[3],
            start[1] * start[3],
            start[2] * start[3],
            start[3],
        ];
        let end_premul = [end[0] * end[3], end[1] * end[3], end[2] * end[3], end[3]];
        Self {
            start: start_premul,
            end: end_premul,
            angle,
            _padding: [0.0; 3],
        }
    }

    fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("GradientOrColorUniforms Buffer"),
            contents: bytemuck::cast_slice(&[self]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        })
    }
}

impl GradientOrColorPipeline {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("GradientOrColorBindGroupLayout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let shader_source = include_str!("shaders/gradient-or-color.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Gradient or Color Shader"),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("GradientOrColorPipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("GradientOrColorPipelineLayout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
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
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn bind_group(&self, device: &wgpu::Device, uniforms: &wgpu::Buffer) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
            label: Some("GradientOrColorBindGroup"),
        })
    }
}

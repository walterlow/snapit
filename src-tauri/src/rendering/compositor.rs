//! Frame compositor using wgpu shaders.
//!
//! Composites video frames with zoom, webcam overlay (with circle mask), and effects.

use std::sync::Arc;
use wgpu::{Device, Queue};

use super::renderer::Renderer;
use super::types::{CompositorUniforms, DecodedFrame, RenderOptions, WebcamShape};

/// WGSL shader for video compositing with zoom and webcam overlay.
const COMPOSITOR_SHADER: &str = r#"
struct Uniforms {
    video_size: vec4<f32>,    // width, height, 0, 0
    output_size: vec4<f32>,   // width, height, 0, 0
    zoom: vec4<f32>,          // scale, center_x, center_y, 0
    time_flags: vec4<f32>,    // time_ms, flags, 0, 0
    webcam_rect: vec4<f32>,   // x, y, width, height (normalized 0-1)
    webcam_params: vec4<f32>, // shape(0=none,1=circle,2=rect,3=rounded), border_width, mirror, radius
    webcam_border: vec4<f32>, // r, g, b, a
    webcam_tex_size: vec4<f32>, // texture width, height, aspect_ratio, 0
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

// Signed distance function for circle with aspect ratio correction
fn sdf_circle(p: vec2<f32>, center: vec2<f32>, radius: f32, aspect: f32) -> f32 {
    // Scale X by aspect ratio to make the circle round in pixel space
    let scaled_p = vec2<f32>(p.x * aspect, p.y);
    let scaled_center = vec2<f32>(center.x * aspect, center.y);
    return length(scaled_p - scaled_center) - radius * aspect;
}

// Signed distance function for rounded rectangle  
fn sdf_rounded_rect(p: vec2<f32>, center: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let d = abs(p - center) - half_size + vec2<f32>(radius);
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0) - radius;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let zoom_scale = uniforms.zoom.x;
    let zoom_center = vec2<f32>(uniforms.zoom.y, uniforms.zoom.z);
    
    // Apply zoom transformation to get video UV
    var video_uv = input.uv;
    if (zoom_scale > 1.0) {
        video_uv = (input.uv - zoom_center) / zoom_scale + zoom_center;
    }
    video_uv = clamp(video_uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
    // Sample video texture
    var color = textureSample(video_texture, video_sampler, video_uv);
    
    // Webcam overlay
    let webcam_shape = uniforms.webcam_params.x;
    if (webcam_shape > 0.5) {
        let webcam_pos = uniforms.webcam_rect.xy;
        let webcam_size = uniforms.webcam_rect.zw;
        let border_width = uniforms.webcam_params.y;
        let mirror = uniforms.webcam_params.z;
        let corner_radius = uniforms.webcam_params.w;
        
        // Check if current pixel is within webcam area (including border)
        let border_pixels = border_width / uniforms.output_size.x;
        let expanded_pos = webcam_pos - vec2<f32>(border_pixels);
        let expanded_size = webcam_size + vec2<f32>(border_pixels * 2.0);
        
        if (input.uv.x >= expanded_pos.x && input.uv.x <= expanded_pos.x + expanded_size.x &&
            input.uv.y >= expanded_pos.y && input.uv.y <= expanded_pos.y + expanded_size.y) {
            
            // Calculate position within webcam area
            let webcam_center = webcam_pos + webcam_size * 0.5;
            let half_size = webcam_size * 0.5;
            
            // Calculate distance for masking
            var dist: f32;
            var border_dist: f32;
            
            // Webcam rect aspect ratio for proper circle rendering
            // webcam_rect is square in PIXELS, so we use its own aspect for correction
            let webcam_rect_aspect = webcam_size.x / webcam_size.y;
            
            if (webcam_shape < 1.5) {
                // Circle - use webcam rect aspect for correction (makes circle round in pixels)
                let radius = half_size.x;  // Use x-radius as reference
                dist = sdf_circle(input.uv, webcam_center, radius, 1.0 / webcam_rect_aspect);
                border_dist = sdf_circle(input.uv, webcam_center, radius + border_pixels, 1.0 / webcam_rect_aspect);
            } else if (webcam_shape < 2.5) {
                // Rectangle
                dist = sdf_rounded_rect(input.uv, webcam_center, half_size, 0.0);
                border_dist = sdf_rounded_rect(input.uv, webcam_center, half_size + vec2<f32>(border_pixels), 0.0);
            } else {
                // Rounded rectangle
                let radius_norm = corner_radius / uniforms.output_size.x;
                dist = sdf_rounded_rect(input.uv, webcam_center, half_size, radius_norm);
                border_dist = sdf_rounded_rect(input.uv, webcam_center, half_size + vec2<f32>(border_pixels), radius_norm);
            }
            
            // Anti-aliased edge using screen-space derivatives for smooth edges
            // fwidth gives the rate of change across the pixel - adapts to resolution
            let aa_width = fwidth(dist) * 3.0;  // 3 pixels of smooth transition
            
            // Border
            if (border_width > 0.0 && dist > 0.0 && border_dist <= 0.0) {
                let border_alpha = 1.0 - smoothstep(-aa_width, aa_width, border_dist);
                color = mix(color, uniforms.webcam_border, border_alpha);
            }
            
            // Webcam content (sample when inside or within AA zone)
            if (dist <= aa_width) {
                // Calculate UV within webcam overlay area
                var webcam_uv = (input.uv - webcam_pos) / webcam_size;
                
                // Mirror if enabled
                if (mirror > 0.5) {
                    webcam_uv.x = 1.0 - webcam_uv.x;
                }
                
                // Crop webcam to square for circle display
                // Aspect > 1 means wide video (e.g., 16:9 = 1.78)
                // We crop the sides to show center portion
                let aspect = uniforms.webcam_tex_size.z;
                if (aspect > 1.0) {
                    // Wide video: crop sides, keep full height
                    // Map UV from [0,1] to [crop_start, crop_end]
                    let crop_amount = (1.0 - 1.0 / aspect) * 0.5;
                    webcam_uv.x = crop_amount + webcam_uv.x * (1.0 / aspect);
                } else if (aspect < 1.0) {
                    // Tall video: crop top/bottom, keep full width
                    let crop_amount = (1.0 - aspect) * 0.5;
                    webcam_uv.y = crop_amount + webcam_uv.y * aspect;
                }
                
                // Clamp to valid range
                webcam_uv = clamp(webcam_uv, vec2<f32>(0.0), vec2<f32>(1.0));
                
                let webcam_color = textureSample(webcam_texture, webcam_sampler, webcam_uv);
                let alpha = 1.0 - smoothstep(-aa_width, aa_width, dist);
                color = mix(color, webcam_color, alpha * webcam_color.a);
            }
        }
    }
    
    return color;
}
"#;

/// Extended uniforms including webcam parameters.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ExtendedUniforms {
    pub video_size: [f32; 4],
    pub output_size: [f32; 4],
    pub zoom: [f32; 4],
    pub time_flags: [f32; 4],
    pub webcam_rect: [f32; 4],
    pub webcam_params: [f32; 4],
    pub webcam_border: [f32; 4],
    pub webcam_tex_size: [f32; 4],
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
                    blend: Some(wgpu::BlendState::REPLACE),
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
            wgpu::ImageCopyTexture {
                texture: &placeholder_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[0u8, 0, 0, 0],
            wgpu::ImageDataLayout {
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

        Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            uniform_buffer,
            sampler,
            placeholder_texture,
            placeholder_view,
        }
    }

    /// Composite a frame with the given options.
    pub fn composite(
        &self,
        renderer: &Renderer,
        frame: &DecodedFrame,
        options: &RenderOptions,
        time_ms: f32,
    ) -> wgpu::Texture {
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
        let (webcam_rect, webcam_params, webcam_border, webcam_tex_size) =
            if let Some(ref webcam) = options.webcam {
                webcam_texture_storage = Some(renderer.create_texture_from_rgba(
                    &webcam.frame.data,
                    webcam.frame.width,
                    webcam.frame.height,
                    "Webcam Frame",
                ));

                let shape = match webcam.shape {
                    WebcamShape::Circle => 1.0,
                    WebcamShape::Rectangle => 2.0,
                    WebcamShape::RoundedRect { .. } => 3.0,
                };
                let radius = match webcam.shape {
                    WebcamShape::RoundedRect { radius } => radius as f32,
                    _ => 0.0,
                };

                // Calculate webcam texture aspect ratio for proper cropping
                let webcam_aspect = webcam.frame.width as f32 / webcam.frame.height as f32;

                // Make webcam overlay square in PIXELS (not normalized coords)
                // webcam.size is width as fraction of output width
                // To get square pixels: height_norm = width_norm * (out_w / out_h)
                let output_aspect = options.output_width as f32 / options.output_height as f32;
                let webcam_width_norm = webcam.size;
                let webcam_height_norm = webcam.size * output_aspect;

                // Position is now calculated correctly in build_webcam_overlay (pixel-based, then normalized)
                // No adjustment needed - x,y are already correct normalized positions

                (
                    [webcam.x, webcam.y, webcam_width_norm, webcam_height_norm], // Square in pixels
                    [
                        shape,
                        webcam.border_width,
                        if webcam.mirror { 1.0 } else { 0.0 },
                        radius,
                    ],
                    webcam.border_color,
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
                    [0.0, 0.0, 0.0, 0.0],
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

        // Update uniforms
        let uniforms = ExtendedUniforms {
            video_size: [frame.width as f32, frame.height as f32, 0.0, 0.0],
            output_size: [
                options.output_width as f32,
                options.output_height as f32,
                0.0,
                0.0,
            ],
            zoom: [
                options.zoom.scale,
                options.zoom.center_x,
                options.zoom.center_y,
                0.0,
            ],
            time_flags: [time_ms, 0.0, 0.0, 0.0],
            webcam_rect,
            webcam_params,
            webcam_border,
            webcam_tex_size,
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

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Compositor Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
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
}

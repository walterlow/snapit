//! Webcam preview shader with GPU-based YUV→RGB conversion.
//!
//! Accepts raw YUV data (NV12 or YUYV) and converts to RGB on the GPU.
//! This is much faster than CPU conversion as GPUs are optimized for this.

struct StateUniforms {
    shape: f32,      // 0 = Circle, 1 = Rectangle
    size: f32,       // Normalized size (0-1)
    mirrored: f32,   // 1.0 if mirrored, 0.0 otherwise
    yuv_format: f32, // 0 = NV12, 1 = YUYV422, 2 = RGBA (pass-through)
}

struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    tex_width: f32,  // Texture width for YUYV decoding
    tex_height: f32, // Texture height
}

struct CameraUniforms {
    camera_aspect_ratio: f32,
    _padding: f32,
}

@group(1) @binding(0)
var<uniform> uniforms: StateUniforms;

@group(1) @binding(1)
var<uniform> window_uniforms: WindowUniforms;

@group(1) @binding(2)
var<uniform> camera_uniforms: CameraUniforms;

// For NV12: Y plane (R8) and UV plane (RG8)
// For YUYV: Single texture with packed data (RGBA8)
@group(0) @binding(0)
var t_y: texture_2d<f32>;  // Y plane or YUYV packed data

@group(0) @binding(1)
var t_uv: texture_2d<f32>; // UV plane (NV12 only)

@group(0) @binding(2)
var s_camera: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    var out: VertexOutput;

    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
    );

    var uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    out.position = vec4<f32>(positions[idx], 0.0, 1.0);
    out.uv = uvs[idx];
    return out;
}

// YUV to RGB conversion (BT.601 standard)
fn yuv_to_rgb(y: f32, u: f32, v: f32) -> vec3<f32> {
    let y_adj = y;
    let u_adj = u - 0.5;
    let v_adj = v - 0.5;

    let r = y_adj + 1.402 * v_adj;
    let g = y_adj - 0.344 * u_adj - 0.714 * v_adj;
    let b = y_adj + 1.772 * u_adj;

    return clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let window_aspect = window_uniforms.window_width / window_uniforms.window_height;
    let camera_aspect = camera_uniforms.camera_aspect_ratio;

    // Calculate UV coordinates for "cover" behavior
    var final_uv = in.uv;

    if (camera_aspect > window_aspect) {
        let scale = window_aspect / camera_aspect;
        let offset = (1.0 - scale) * 0.5;
        final_uv.x = final_uv.x * scale + offset;
    } else {
        let scale = camera_aspect / window_aspect;
        let offset = (1.0 - scale) * 0.5;
        final_uv.y = final_uv.y * scale + offset;
    }

    // Apply horizontal mirroring if enabled
    if (uniforms.mirrored == 1.0) {
        final_uv.x = 1.0 - final_uv.x;
    }

    // Convert UV to center-based coordinates for masking
    let center_uv = (in.uv - 0.5) * 2.0;

    var mask = 1.0;
    let shape = uniforms.shape;

    if (shape == 0.0) {
        // Circle shape
        let distance = length(center_uv);
        let pixel_size = length(fwidth(center_uv));
        let aa_width = max(pixel_size, 0.003);
        let edge_distance = distance - 1.0;
        mask = 1.0 - smoothstep(-aa_width, aa_width, edge_distance);
    } else if (shape == 1.0) {
        // Rectangle with rounded corners
        let corner_radius = mix(0.10, 0.14, uniforms.size);
        let abs_uv = abs(center_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);
        let corner_dist = length(max(corner_pos, vec2<f32>(0.0, 0.0)));
        let pixel_size = length(fwidth(center_uv));
        let aa_width = max(pixel_size, 0.002);
        let edge_distance = corner_dist - corner_radius;
        mask = 1.0 - smoothstep(-aa_width, aa_width, edge_distance);
    }

    if (mask < 0.05) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Sample and convert based on format
    var rgb: vec3<f32>;

    if (uniforms.yuv_format == 0.0) {
        // NV12: Y plane + interleaved UV plane
        let y = textureSample(t_y, s_camera, final_uv).r;
        let uv = textureSample(t_uv, s_camera, final_uv).rg;
        rgb = yuv_to_rgb(y, uv.r, uv.g);
    } else if (uniforms.yuv_format == 1.0) {
        // YUYV422: Packed as RGBA where each 4 bytes = 2 pixels
        // Each texel stores (Y0, U, Y1, V) for two horizontal pixels
        let tex_width = window_uniforms.tex_width;
        let pixel_x = final_uv.x * tex_width;

        // Find the pair this pixel belongs to
        let pair_index = floor(pixel_x / 2.0);

        // Sample the YUYV texel (texture is half width, UV auto-scales)
        let yuyv = textureSample(t_y, s_camera, final_uv);

        // Determine if we're the first (even) or second (odd) pixel in the pair
        // fract(pixel_x / 2.0) >= 0.5 means odd pixel (second in pair)
        let is_second = fract(pixel_x / 2.0) >= 0.5;
        let y = select(yuyv.r, yuyv.b, is_second);
        let u = yuyv.g;
        let v = yuyv.a;

        rgb = yuv_to_rgb(y, u, v);
    } else {
        // RGBA pass-through (format 2): already RGB, just sample
        rgb = textureSample(t_y, s_camera, final_uv).rgb;
    }

    let final_alpha = select(1.0, mask, mask < 0.95);
    return vec4<f32>(rgb, final_alpha);
}

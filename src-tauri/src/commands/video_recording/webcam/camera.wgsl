//! Webcam preview shader - renders camera texture with shape masking.
//!
//! Adapted from Cap's camera.wgsl for SnapIt's webcam preview window.
//! Supports circle and rectangle shapes with anti-aliased edges.

struct StateUniforms {
    shape: f32,      // 0 = Circle, 1 = Rectangle
    size: f32,       // Normalized size (0-1)
    mirrored: f32,   // 1.0 if mirrored, 0.0 otherwise
    _padding: f32,
}

struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    _padding1: f32,
    _padding2: f32,
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

@group(0) @binding(0)
var t_camera: texture_2d<f32>;

@group(0) @binding(1)
var s_camera: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    var out: VertexOutput;

    // Fullscreen quad using 6 vertices (2 triangles)
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), // Bottom-left triangle
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),  // Top-right triangle
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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let window_aspect = window_uniforms.window_width / window_uniforms.window_height;
    let camera_aspect = camera_uniforms.camera_aspect_ratio;

    // Calculate UV coordinates for "cover" behavior (fill entire area, crop excess)
    var final_uv = in.uv;

    if (camera_aspect > window_aspect) {
        // Camera is wider than window - crop horizontally
        let scale = window_aspect / camera_aspect;
        let offset = (1.0 - scale) * 0.5;
        final_uv.x = final_uv.x * scale + offset;
    } else {
        // Camera is taller than window - crop vertically
        let scale = camera_aspect / window_aspect;
        let offset = (1.0 - scale) * 0.5;
        final_uv.y = final_uv.y * scale + offset;
    }

    // Apply horizontal mirroring if enabled
    if (uniforms.mirrored == 1.0) {
        final_uv.x = 1.0 - final_uv.x;
    }

    // Convert UV to center-based coordinates [-1, 1]
    let center_uv = (in.uv - 0.5) * 2.0;

    var mask = 1.0;
    let shape = uniforms.shape;

    if (shape == 0.0) {
        // Circle shape with anti-aliasing
        let distance = length(center_uv);
        let radius = 1.0;

        // Anti-aliasing width based on screen-space derivatives
        let pixel_size = length(fwidth(center_uv));
        let aa_width = max(pixel_size, 0.003);

        let edge_distance = distance - radius;
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

    // Early discard for fully transparent pixels
    if (mask < 0.05) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Sample the camera texture
    let camera_color = textureSample(t_camera, s_camera, final_uv);

    // Apply mask with clean alpha handling
    let final_alpha = select(1.0, mask, mask < 0.95);
    return vec4<f32>(camera_color.rgb, final_alpha);
}

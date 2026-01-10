// Shader for rendering solid colors or linear gradients as background.
// Adapted from Cap's rendering engine.

struct Uniforms {
    start: vec4<f32>,
    end: vec4<f32>,
    angle: f32,
    _padding1: f32,
    _padding2: f32,
    _padding3: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    // Generate fullscreen triangle (vertices 0,1,2 cover the whole screen)
    let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index & 2u) * 2 - 1);
    out.tex_coords = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    return out;
}

fn gradient(uv: vec2<f32>) -> vec4<f32> {
    // Convert angle to radians and offset by 270 degrees for CSS-like behavior
    let angle_rad = radians(u.angle + 270.0);

    // Calculate gradient direction
    let dir = vec2<f32>(cos(angle_rad), sin(angle_rad));

    // Project UV onto gradient direction
    let proj = dot(uv - 0.5, dir) + 0.5;

    // Clamp and interpolate
    let t = clamp(proj, 0.0, 1.0);

    return mix(u.start, u.end, t);
}

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    return gradient(tex_coords);
}

# Rendering - wgpu GPU Pipeline

GPU-accelerated video rendering with wgpu for 60fps playback and export.

## Structure

```
rendering/
├── mod.rs                # Module index + public API
├── renderer.rs           # wgpu device/queue setup
├── compositor.rs         # Frame compositing shader pipeline
├── editor_instance.rs    # Playback state management
├── decoder.rs            # Async video decoding + prefetch
├── types.rs              # ts-rs exported types (RenderedFrame, PlaybackState)
└── exporter/
    ├── mod.rs            # Export orchestration
    ├── encoder.rs        # Video encoding
    ├── webcam.rs         # Webcam overlay compositing
    └── cursor.rs         # Cursor overlay rendering
```

## Where to Look

| Task | File | Notes |
|------|------|-------|
| Add shader effect | `compositor.rs` | WGSL shaders |
| New overlay type | `exporter/` | Follow webcam pattern |
| Playback control | `editor_instance.rs` | Frame timing |
| Decode optimization | `decoder.rs` | Prefetch tuning |
| Export format | `exporter/encoder.rs` | FFmpeg integration |

## Patterns

### wgpu Device Setup
```rust
// renderer.rs
let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
    backends: wgpu::Backends::all(),
    ..Default::default()
});

let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
    power_preference: wgpu::PowerPreference::HighPerformance,
    ..Default::default()
}).await?;

let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
    required_features: wgpu::Features::empty(),
    required_limits: wgpu::Limits::default(),
    ..Default::default()
}).await?;
```

### Shader Pipeline
```rust
// compositor.rs
let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
    label: Some("compositor_shader"),
    source: wgpu::ShaderSource::Wgsl(include_str!("compositor.wgsl").into()),
});

let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
    layout: Some(&pipeline_layout),
    vertex: wgpu::VertexState {
        module: &shader,
        entry_point: Some("vs_main"),
        buffers: &[vertex_buffer_layout],
        compilation_options: Default::default(),
    },
    fragment: Some(wgpu::FragmentState {
        module: &shader,
        entry_point: Some("fs_main"),
        targets: &[Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        })],
        compilation_options: Default::default(),
    }),
    // ...
});
```

### Render Pass
```rust
let mut encoder = device.create_command_encoder(&Default::default());

{
    let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("compositor_pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &output_view,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })],
        ..Default::default()
    });

    render_pass.set_pipeline(&pipeline);
    render_pass.set_bind_group(0, &bind_group, &[]);
    render_pass.draw(0..6, 0..1); // Fullscreen quad
}

queue.submit(std::iter::once(encoder.finish()));
```

### Type Generation
```rust
// types.rs
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct RenderedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub timestamp_ms: u64,
}
```

### Editor Instance Lifecycle
```rust
// Tauri command creates instance
pub fn create_editor_instance(project: VideoProject) -> SnapItResult<EditorInstanceInfo> {
    let instance = EditorInstance::new(project)?;
    let id = generate_id();
    INSTANCES.lock()?.insert(id.clone(), instance);
    Ok(EditorInstanceInfo { instance_id: id, ... })
}

// Frame rendering
pub fn editor_render_frame(instance_id: String, timestamp_ms: u64) -> SnapItResult<RenderedFrame> {
    let instances = INSTANCES.lock()?;
    let instance = instances.get(&instance_id)?;
    instance.render_frame(timestamp_ms)
}
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Create device per frame | Reuse device/queue |
| Block on GPU operations | Use async properly |
| Skip error context | Use `.context()` extension |
| Hardcode texture formats | Use constants |
| Ignore prefetching | Decode ahead for smooth playback |

## Performance Notes

- **60fps target**: Frame budget ~16ms
- **Prefetching**: Decoder prefetches 5-10 frames ahead
- **Texture caching**: Reuse textures when possible
- **Zero-copy**: Map buffers directly when supported
- **Async decoding**: Separate thread for video decode

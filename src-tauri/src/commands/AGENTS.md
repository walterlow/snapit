# Commands - Tauri IPC Handlers

70+ Tauri commands organized by domain, all returning `SnapItResult<T>`.

## Structure

```
commands/
├── mod.rs                    # Module index + re-exports
├── capture/                  # Screen capture (region, fullscreen, fast)
│   ├── mod.rs               # 615 lines - xcap + BitBlt fallback
│   └── utils.rs
├── capture_overlay/          # DirectComposition overlay (999 lines)
│   ├── mod.rs               # Win32 message loop
│   ├── render.rs            # D2D rendering
│   ├── state.rs             # Selection state machine
│   └── graphics/            # D3D11/DirectComposition
├── storage/                  # Project persistence
│   ├── mod.rs
│   └── types.rs             # ts-rs exported types
├── video_recording/          # Recording + webcam + GPU editor
│   ├── mod.rs               # Recording commands
│   ├── recorder/            # Video capture pipeline
│   ├── cursor/              # Cursor event capture
│   ├── webcam/              # Webcam device handling
│   └── video_project/       # Project file management
├── window/                   # Window management
│   └── mod.rs               # Toolbar, overlay positioning
└── capture_settings.rs      # Settings with ts-rs exports
```

## Where to Look

| Task | Directory | Notes |
|------|-----------|-------|
| Add capture variant | `capture/mod.rs` | Follow existing patterns |
| Screen selection UI | `capture_overlay/` | DirectComposition overlay |
| Recording feature | `video_recording/` | Uses windows-capture |
| File operations | `storage/` | Project save/load |
| Window positioning | `window/mod.rs` | Multi-monitor aware |

## Patterns

### Command Signature
```rust
use crate::error::{SnapItError, SnapItResult};

#[tauri::command]
pub async fn my_command(
    app: tauri::AppHandle,
    param: ParamType,
) -> SnapItResult<ReturnType> {
    // Implementation
    Ok(result)
}
```

### Error Handling
```rust
use crate::error::{SnapItError, ResultExt};

// Convert any error with context
let data = fs::read(&path)
    .context(format!("Failed to read {}", path.display()))?;

// Specific error variants
return Err(SnapItError::CaptureError("Monitor not found".into()));

// Lock poisoning recovery
let guard = mutex.lock_or_recover()?;
```

### Type Generation (ts-rs)
```rust
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct CaptureResult {
    pub id: String,
    pub path: String,
    #[ts(type = "number")]
    pub width: u32,
}
```

### State Management
```rust
// Store state in app handle
app.manage(Mutex::new(RecordingState::default()));

// Access in command
let state = app.state::<Mutex<RecordingState>>();
let mut guard = state.lock_or_recover()?;
guard.is_recording = true;
```

### Async Commands
```rust
#[tauri::command]
pub async fn start_recording(app: tauri::AppHandle) -> SnapItResult<()> {
    // Spawn blocking for CPU-intensive work
    let result = tokio::task::spawn_blocking(|| {
        // Heavy computation
    }).await?;
    
    Ok(())
}
```

## Registration

Commands registered in `lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // capture
    commands::capture::capture_region,
    commands::capture::capture_fullscreen_fast,
    // storage
    commands::storage::save_capture,
    commands::storage::load_capture,
    // ... 70+ more
])
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Return `Result<T, String>` | Use `SnapItResult<T>` |
| Panic in commands | Return `SnapItError` variant |
| Block async without spawn_blocking | Use `tokio::task::spawn_blocking` |
| Skip ts-rs on shared types | Add `#[derive(TS)]` for frontend types |
| Hardcode paths | Use `app.path()` API |

## Testing

Rust tests in `src-tauri/src/tests/`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capture_region() {
        // Unit test
    }
}
```

Run: `cargo test --lib`

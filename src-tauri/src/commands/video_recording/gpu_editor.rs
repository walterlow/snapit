//! Tauri commands for GPU-accelerated video editor.
//!
//! These commands manage EditorInstance lifecycle and playback control.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

use crate::commands::video_recording::video_project::VideoProject;
use crate::rendering::{EditorInstance, EditorInstanceInfo, PlaybackState, RenderedFrame};

/// Global state for managing editor instances.
pub struct EditorState {
    instances: Mutex<HashMap<String, Arc<tokio::sync::Mutex<EditorInstance>>>>,
}

impl EditorState {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for EditorState {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a new editor instance for a video project.
#[tauri::command]
pub async fn create_editor_instance(
    app_handle: AppHandle,
    project: VideoProject,
    state: State<'_, EditorState>,
) -> Result<EditorInstanceInfo, String> {
    log::info!(
        "[GPU_EDITOR] Creating editor instance for project: {}",
        project.id
    );

    // Get resource directory for wallpaper path resolution
    let resource_dir = app_handle.path().resource_dir().ok();

    // Create the editor instance
    let mut instance = EditorInstance::new(project, resource_dir).await?;
    let info = instance.info();
    let instance_id = info.instance_id.clone();

    // Start the playback loop
    instance.start_playback(app_handle)?;

    // Store in global state
    {
        let mut instances = state.instances.lock();
        instances.insert(
            instance_id.clone(),
            Arc::new(tokio::sync::Mutex::new(instance)),
        );
    }

    log::info!("[GPU_EDITOR] Created editor instance: {}", instance_id);
    Ok(info)
}

/// Destroy an editor instance.
#[tauri::command]
pub async fn destroy_editor_instance(
    instance_id: String,
    state: State<'_, EditorState>,
) -> Result<(), String> {
    log::info!("[GPU_EDITOR] Destroying editor instance: {}", instance_id);

    let instance = {
        let mut instances = state.instances.lock();
        instances.remove(&instance_id)
    };

    if let Some(instance) = instance {
        let mut inst = instance.lock().await;
        inst.stop().await?;
    }

    Ok(())
}

/// Start playback.
#[tauri::command]
pub async fn editor_play(instance_id: String, state: State<'_, EditorState>) -> Result<(), String> {
    let instance = get_instance(&instance_id, &state)?;
    let inst = instance.lock().await;
    inst.play().await
}

/// Pause playback.
#[tauri::command]
pub async fn editor_pause(
    instance_id: String,
    state: State<'_, EditorState>,
) -> Result<(), String> {
    let instance = get_instance(&instance_id, &state)?;
    let inst = instance.lock().await;
    inst.pause().await
}

/// Seek to a specific timestamp.
#[tauri::command]
pub async fn editor_seek(
    instance_id: String,
    timestamp_ms: u64,
    state: State<'_, EditorState>,
) -> Result<(), String> {
    let instance = get_instance(&instance_id, &state)?;
    let inst = instance.lock().await;
    inst.seek(timestamp_ms).await
}

/// Set playback speed.
#[tauri::command]
pub async fn editor_set_speed(
    instance_id: String,
    speed: f32,
    state: State<'_, EditorState>,
) -> Result<(), String> {
    let instance = get_instance(&instance_id, &state)?;
    let inst = instance.lock().await;
    inst.set_speed(speed).await
}

/// Get current playback state.
#[tauri::command]
pub async fn editor_get_state(
    instance_id: String,
    state: State<'_, EditorState>,
) -> Result<PlaybackState, String> {
    let instance = get_instance(&instance_id, &state)?;
    let inst = instance.lock().await;
    Ok(inst.get_state())
}

/// Render a single frame at the given timestamp.
/// Returns the frame as base64-encoded RGBA data.
#[tauri::command]
pub async fn editor_render_frame(
    instance_id: String,
    timestamp_ms: u64,
    state: State<'_, EditorState>,
) -> Result<RenderedFrame, String> {
    let instance = get_instance(&instance_id, &state)?;
    let mut inst = instance.lock().await;
    inst.render_frame(timestamp_ms).await
}

/// Get current timestamp.
#[tauri::command]
pub async fn editor_get_timestamp(
    instance_id: String,
    state: State<'_, EditorState>,
) -> Result<u64, String> {
    let instance = get_instance(&instance_id, &state)?;
    let inst = instance.lock().await;
    Ok(inst.get_current_timestamp())
}

/// Helper to get an instance from state.
fn get_instance(
    instance_id: &str,
    state: &State<'_, EditorState>,
) -> Result<Arc<tokio::sync::Mutex<EditorInstance>>, String> {
    let instances = state.instances.lock();
    instances
        .get(instance_id)
        .cloned()
        .ok_or_else(|| format!("Editor instance not found: {}", instance_id))
}

use super::{
    import,
    models::{ImportProgress, SceneOrientation, SceneRecord},
    validate_uuid, SceneError, SceneState,
};
use std::fs;
use tauri::{ipc::Channel, State};

async fn run_blocking<T, F>(operation: F) -> Result<T, SceneError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, SceneError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| SceneError::internal())?
}

#[tauri::command]
pub async fn scene_list(state: State<'_, SceneState>) -> Result<Vec<SceneRecord>, SceneError> {
    let state = state.inner().clone();
    run_blocking(move || state.database.list_ready()).await
}

#[tauri::command]
pub async fn scene_current(
    state: State<'_, SceneState>,
) -> Result<Option<SceneRecord>, SceneError> {
    let state = state.inner().clone();
    run_blocking(move || state.database.current()).await
}

#[tauri::command]
pub async fn scene_import(
    state: State<'_, SceneState>,
    source_path: String,
    operation_id: String,
    progress: Channel<ImportProgress>,
) -> Result<SceneRecord, SceneError> {
    let state = state.inner().clone();
    run_blocking(move || import::import_scene(&state, source_path, operation_id, progress)).await
}

#[tauri::command]
pub fn scene_cancel_import(
    state: State<'_, SceneState>,
    operation_id: String,
) -> Result<(), SceneError> {
    state.cancel_import(&operation_id)
}

#[tauri::command]
pub async fn scene_set_current(
    state: State<'_, SceneState>,
    scene_id: String,
) -> Result<SceneRecord, SceneError> {
    validate_uuid(&scene_id)?;
    let state = state.inner().clone();
    run_blocking(move || state.database.set_current(&scene_id)).await
}

#[tauri::command]
pub async fn scene_update_orientation(
    state: State<'_, SceneState>,
    scene_id: String,
    quaternion: [f64; 4],
) -> Result<SceneRecord, SceneError> {
    validate_uuid(&scene_id)?;
    let orientation = SceneOrientation { quaternion }.normalized()?;
    let state = state.inner().clone();
    run_blocking(move || state.database.update_orientation(&scene_id, orientation)).await
}

#[tauri::command]
pub async fn scene_delete(
    state: State<'_, SceneState>,
    scene_id: String,
) -> Result<(), SceneError> {
    validate_uuid(&scene_id)?;
    let state = state.inner().clone();
    run_blocking(move || {
        state.database.begin_delete(&scene_id)?;
        let directory = state.scenes_root.join(&scene_id);
        if directory.exists() {
            let metadata = fs::symlink_metadata(&directory).map_err(|_| SceneError::internal())?;
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(SceneError::internal());
            }
            fs::remove_dir_all(&directory).map_err(|_| SceneError::internal())?;
        }
        state.database.finish_delete(&scene_id)
    })
    .await
}

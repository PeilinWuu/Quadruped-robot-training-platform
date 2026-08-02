pub mod commands;
mod database;
mod error;
mod import;
mod models;
pub mod protocol;

use database::SceneDatabase;
pub use error::SceneError;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SceneState {
    pub(crate) database: SceneDatabase,
    pub(crate) scenes_root: PathBuf,
    pub(crate) staging_root: PathBuf,
    pub(crate) cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub(crate) import_gate: Arc<Mutex<()>>,
}

impl SceneState {
    pub fn initialize(app_data_dir: PathBuf) -> Result<Self, SceneError> {
        fs::create_dir_all(&app_data_dir).map_err(|_| SceneError::internal())?;
        let scenes_root = app_data_dir.join("scenes");
        let staging_root = scenes_root.join(".staging");
        fs::create_dir_all(&staging_root).map_err(|_| SceneError::internal())?;
        let database = SceneDatabase::initialize(app_data_dir.join("scenes.sqlite"))?;
        cleanup_staging(&staging_root)?;
        database.recover(&scenes_root)?;
        Ok(Self {
            database,
            scenes_root,
            staging_root,
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            import_gate: Arc::new(Mutex::new(())),
        })
    }

    pub(crate) fn register_import(
        &self,
        operation_id: &str,
    ) -> Result<Arc<AtomicBool>, SceneError> {
        validate_uuid(operation_id)?;
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| SceneError::internal())?;
        if cancellations.contains_key(operation_id) {
            return Err(SceneError::scene_busy());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        cancellations.insert(operation_id.to_owned(), Arc::clone(&cancel));
        Ok(cancel)
    }

    pub(crate) fn finish_import(&self, operation_id: &str) {
        if let Ok(mut cancellations) = self.cancellations.lock() {
            cancellations.remove(operation_id);
        }
    }

    pub(crate) fn cancel_import(&self, operation_id: &str) -> Result<(), SceneError> {
        validate_uuid(operation_id)?;
        let cancellations = self
            .cancellations
            .lock()
            .map_err(|_| SceneError::internal())?;
        let cancel = cancellations
            .get(operation_id)
            .ok_or_else(SceneError::scene_not_found)?;
        cancel.store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}

pub(crate) fn validate_uuid(value: &str) -> Result<Uuid, SceneError> {
    if value.len() != 36 || !value.is_ascii() {
        return Err(SceneError::invalid_input());
    }
    let uuid = Uuid::parse_str(value).map_err(|_| SceneError::invalid_input())?;
    if uuid.hyphenated().to_string() != value {
        return Err(SceneError::invalid_input());
    }
    Ok(uuid)
}

fn cleanup_staging(staging_root: &Path) -> Result<(), SceneError> {
    for entry in fs::read_dir(staging_root).map_err(|_| SceneError::internal())? {
        let entry = entry.map_err(|_| SceneError::internal())?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(operation_id) = file_name.strip_suffix(".part") else {
            continue;
        };
        if validate_uuid(operation_id).is_err() {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| SceneError::internal())?;
        if metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            fs::remove_file(entry.path()).map_err(|_| SceneError::internal())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

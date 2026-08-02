use super::{
    error::SimulationError,
    manager::{PingResult, SimulationManager, SimulationStatus},
};
use tauri::{AppHandle, Manager, State};

async fn run_blocking<T, F>(operation: F) -> Result<T, SimulationError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, SimulationError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| SimulationError::internal())?
}

#[tauri::command]
pub async fn simulation_sidecar_start(
    app: AppHandle,
    manager: State<'_, SimulationManager>,
) -> Result<SimulationStatus, SimulationError> {
    let resource_dir = app.path().resource_dir().map_err(|_| {
        SimulationError::new(
            "SIDECAR_RESOURCE_MISSING",
            "The bundled simulation sidecar is unavailable.",
        )
    })?;
    let manager = manager.inner().clone();
    run_blocking(move || manager.start_from_resource_dir(&resource_dir)).await
}

#[tauri::command]
pub fn simulation_sidecar_status(manager: State<'_, SimulationManager>) -> SimulationStatus {
    manager.status()
}

#[tauri::command]
pub async fn simulation_sidecar_ping(
    manager: State<'_, SimulationManager>,
) -> Result<PingResult, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.ping()).await
}

#[tauri::command]
pub async fn simulation_sidecar_stop(
    manager: State<'_, SimulationManager>,
) -> Result<SimulationStatus, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.stop()).await
}

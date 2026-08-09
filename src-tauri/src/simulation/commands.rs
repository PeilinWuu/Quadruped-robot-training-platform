use super::{
    error::SimulationError,
    manager::{PingResult, SimulationManager, SimulationStatus},
    protocol::{
        CollisionEvent, CollisionTelemetry, EnvironmentId, EnvironmentMetadata, ModelLoadedPayload,
        MotionCommand, MotionCommandStatus, RobotPose, RobotTelemetry, SimulationEvent,
        SimulationState, TelemetryConfig,
    },
};
use crate::input::NativeKeyboardController;
use tauri::{ipc::Channel, AppHandle, Manager, State};

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
    keyboard: State<'_, NativeKeyboardController>,
) -> Result<SimulationStatus, SimulationError> {
    keyboard.disarm();
    let manager = manager.inner().clone();
    run_blocking(move || manager.stop()).await
}

#[tauri::command]
pub async fn simulation_load_model(
    model_id: String,
    environment_id: Option<String>,
    manager: State<'_, SimulationManager>,
    keyboard: State<'_, NativeKeyboardController>,
) -> Result<ModelLoadedPayload, SimulationError> {
    keyboard.disarm();
    let environment = match environment_id.as_deref().unwrap_or("flat-ground-v1") {
        "flat-ground-v1" => EnvironmentId::FlatGroundV1,
        _ => {
            return Err(SimulationError::new(
                "UNKNOWN_ENVIRONMENT",
                "The simulation environment is not allowed.",
            ))
        }
    };
    let manager = manager.inner().clone();
    run_blocking(move || manager.load_model_in_environment(&model_id, environment)).await
}

#[tauri::command]
pub fn simulation_list_environments() -> Vec<EnvironmentMetadata> {
    vec![EnvironmentMetadata {
        id: EnvironmentId::FlatGroundV1,
        display_name: "纯平地演示场景".into(),
        floor_height: 0.0,
        half_extent: 10.0,
        demo_boundary_half_extent: 8.0,
        spawn_position: [0.0, 0.0, 0.0],
        spawn_orientation: [0.0, 0.0, 0.0, 1.0],
        friction: [0.9, 0.1, 0.01],
        solref: [0.02, 1.0],
        solimp: [0.9, 0.95, 0.001],
    }]
}

#[tauri::command]
pub fn simulation_current_environment(
    manager: State<'_, SimulationManager>,
) -> Option<EnvironmentMetadata> {
    manager.current_environment()
}

#[tauri::command]
pub fn simulation_latest_collision(
    manager: State<'_, SimulationManager>,
) -> Option<CollisionTelemetry> {
    manager.latest_collision()
}

#[tauri::command]
pub fn simulation_latest_collision_event(
    manager: State<'_, SimulationManager>,
) -> Option<CollisionEvent> {
    manager.latest_collision_event()
}
#[tauri::command]
pub async fn simulation_run_start(
    manager: State<'_, SimulationManager>,
) -> Result<SimulationState, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.run_start()).await
}
#[tauri::command]
pub async fn simulation_run_pause(
    manager: State<'_, SimulationManager>,
) -> Result<SimulationState, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.run_pause()).await
}
#[tauri::command]
pub async fn simulation_run_step(
    steps: u16,
    manager: State<'_, SimulationManager>,
) -> Result<RobotPose, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.run_step(steps)).await
}
#[tauri::command]
pub async fn simulation_run_reset(
    manager: State<'_, SimulationManager>,
    keyboard: State<'_, NativeKeyboardController>,
) -> Result<SimulationState, SimulationError> {
    keyboard.prepare_reset();
    let manager = manager.inner().clone();
    let result = run_blocking(move || manager.run_reset()).await;
    keyboard.finish_reset();
    result
}
#[tauri::command]
pub async fn simulation_run_stop(
    manager: State<'_, SimulationManager>,
    keyboard: State<'_, NativeKeyboardController>,
) -> Result<SimulationState, SimulationError> {
    keyboard.disarm();
    let manager = manager.inner().clone();
    run_blocking(move || manager.run_stop()).await
}
#[tauri::command]
pub async fn simulation_set_speed(
    speed: f64,
    manager: State<'_, SimulationManager>,
) -> Result<f64, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.set_speed(speed)).await
}
#[tauri::command]
pub fn simulation_latest_pose(manager: State<'_, SimulationManager>) -> Option<RobotPose> {
    manager.latest_pose()
}
#[tauri::command]
pub async fn simulation_set_motion_command(
    command: MotionCommand,
    manager: State<'_, SimulationManager>,
) -> Result<MotionCommandStatus, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.set_motion_command(command)).await
}
#[tauri::command]
pub async fn simulation_clear_motion_command(
    manager: State<'_, SimulationManager>,
) -> Result<MotionCommandStatus, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.clear_motion_command()).await
}
#[tauri::command]
pub async fn simulation_set_telemetry_rate(
    rate_hz: u16,
    manager: State<'_, SimulationManager>,
) -> Result<TelemetryConfig, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.set_telemetry_rate(rate_hz)).await
}
#[tauri::command]
pub async fn simulation_latest_telemetry(
    manager: State<'_, SimulationManager>,
) -> Result<RobotTelemetry, SimulationError> {
    let manager = manager.inner().clone();
    run_blocking(move || manager.get_latest_telemetry()).await
}
#[tauri::command]
pub fn simulation_subscribe(
    subscription_id: String,
    channel: Channel<SimulationEvent>,
    manager: State<'_, SimulationManager>,
) -> Result<(), SimulationError> {
    manager.subscribe(subscription_id, channel)
}

#[tauri::command]
pub fn simulation_unsubscribe(
    subscription_id: String,
    manager: State<'_, SimulationManager>,
) -> Result<(), SimulationError> {
    manager.unsubscribe(&subscription_id)
}

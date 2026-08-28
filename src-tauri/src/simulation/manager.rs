use super::{
    error::SimulationError,
    process::{self, ProcessGuard},
    protocol::{
        parse_response_line, sequence_is_newer, CollisionEvent, CollisionTelemetry, EnvironmentId,
        EnvironmentMetadata, LocomotionAvailability, LocomotionState, ModelLoadedPayload,
        MotionCommand, MotionCommandStatus, ProtocolCommand, ProtocolResponse, RobotPose,
        RobotTelemetry, SimulationEvent, SimulationState, TelemetryConfig, MAX_LINE_BYTES,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin},
    sync::{mpsc, Arc, Mutex, Weak},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
#[cfg(all(target_os = "linux", debug_assertions))]
use std::os::unix::process::ExitStatusExt;

const START_TIMEOUT: Duration = Duration::from_secs(8);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const PING_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const TELEMETRY_WEBVIEW_INTERVAL: Duration = Duration::from_millis(50);
const STDERR_MAX_LINES: usize = 100;
const STDERR_MAX_BYTES: usize = 64 * 1024;
const MAX_CONSECUTIVE_PROTOCOL_ERRORS: u8 = 3;
#[cfg(windows)]
const SIDECAR_FILE_NAME: &str = "quadruped-simulation-sidecar.exe";
#[cfg(target_os = "linux")]
const SIDECAR_FILE_NAME: &str = "quadruped-simulation-sidecar";
#[cfg(windows)]
const MUJOCO_RUNTIME_FILE_NAME: &str = "mujoco.dll";
#[cfg(target_os = "linux")]
const MUJOCO_RUNTIME_FILE_NAME: &str = "libmujoco.so.3.11.0";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Idle,
    Starting,
    Ready,
    Stopping,
    Failed,
    Crashed,
    Unresponsive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlSource {
    Manual,
    Ros,
}
impl LifecycleState {
    fn can_start(self) -> bool {
        matches!(self, Self::Idle | Self::Failed | Self::Crashed)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SimulationStatus {
    pub state: LifecycleState,
    pub simulation_state: SimulationState,
    pub sidecar_version: Option<String>,
    pub model: Option<ModelLoadedPayload>,
    pub speed: f64,
    pub started_at: Option<i64>,
    pub error: Option<SimulationError>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub latency_ms: u64,
    pub nonce_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProtocolFailureDiagnostic {
    frame_type: String,
    controller_state: Option<String>,
    fault_reason: Option<String>,
    simulation_state: SimulationState,
    sequence: Option<u64>,
    timestamp: Option<i64>,
    validator_field: String,
    frame_bytes: usize,
    sample: String,
}

#[derive(Debug, Clone)]
struct ProtocolFrameSummary {
    frame_type: String,
    controller_state: Option<String>,
    fault_reason: Option<String>,
    sequence: Option<u64>,
    timestamp: Option<i64>,
    validator_field: String,
    frame_bytes: usize,
    sample: String,
}

struct ProcessRuntime {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    guard: Arc<ProcessGuard>,
    #[cfg(target_os = "linux")]
    _parent_keeper: process::ParentKeeper,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
}
type PendingSender = mpsc::Sender<Result<ProtocolResponse, SimulationError>>;

struct ManagerInner {
    state: LifecycleState,
    simulation_state: SimulationState,
    generation: u64,
    request_counter: u64,
    runtime: Option<ProcessRuntime>,
    pending: HashMap<String, PendingSender>,
    subscribers: HashMap<String, Channel<SimulationEvent>>,
    stderr_lines: VecDeque<String>,
    stderr_bytes: usize,
    sidecar_version: Option<String>,
    model: Option<ModelLoadedPayload>,
    latest_pose: Option<RobotPose>,
    latest_telemetry: Option<RobotTelemetry>,
    last_telemetry_webview_at: Option<Instant>,
    latest_collision_event: Option<CollisionEvent>,
    latest_motion_command: Option<MotionCommandStatus>,
    telemetry_config: TelemetryConfig,
    speed: f64,
    started_at: Option<i64>,
    error: Option<SimulationError>,
    protocol_errors: u8,
    protocol_error_total: u64,
    first_protocol_failure: Option<ProtocolFailureDiagnostic>,
    control_source: ControlSource,
}
struct ManagerCore {
    inner: Mutex<ManagerInner>,
}

#[derive(Clone)]
pub struct SimulationManager {
    core: Arc<ManagerCore>,
}

impl Default for SimulationManager {
    fn default() -> Self {
        Self::new()
    }
}
impl SimulationManager {
    pub fn new() -> Self {
        Self {
            core: Arc::new(ManagerCore {
                inner: Mutex::new(ManagerInner {
                    state: LifecycleState::Idle,
                    simulation_state: SimulationState::Unloaded,
                    generation: 0,
                    request_counter: 0,
                    runtime: None,
                    pending: HashMap::new(),
                    subscribers: HashMap::new(),
                    stderr_lines: VecDeque::new(),
                    stderr_bytes: 0,
                    sidecar_version: None,
                    model: None,
                    latest_pose: None,
                    latest_telemetry: None,
                    last_telemetry_webview_at: None,
                    latest_collision_event: None,
                    latest_motion_command: None,
                    telemetry_config: TelemetryConfig { rate_hz: 50 },
                    speed: 1.0,
                    started_at: None,
                    error: None,
                    protocol_errors: 0,
                    protocol_error_total: 0,
                    first_protocol_failure: None,
                    control_source: ControlSource::Manual,
                }),
            }),
        }
    }

    pub fn status(&self) -> SimulationStatus {
        let inner = self.core.inner.lock().unwrap_or_else(|p| p.into_inner());
        SimulationStatus {
            state: inner.state,
            simulation_state: inner.simulation_state,
            sidecar_version: inner.sidecar_version.clone(),
            model: inner.model.clone(),
            speed: inner.speed,
            started_at: inner.started_at,
            error: inner.error.clone(),
        }
    }

    pub(crate) fn native_motion_available(&self) -> bool {
        let inner = self.core.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.control_source == ControlSource::Manual
            && inner.state == LifecycleState::Ready
            && inner.simulation_state == SimulationState::Running
            && inner
                .model
                .as_ref()
                .is_some_and(|model| model.model_id == "unitree-go2-menagerie")
            && inner.latest_telemetry.as_ref().is_some_and(|telemetry| {
                telemetry.locomotion.availability == LocomotionAvailability::Available
                    && telemetry.locomotion.state != LocomotionState::Fault
                    && !telemetry.collision.is_fallen
                    && !telemetry.collision.is_out_of_bounds
            })
    }

    pub fn start_from_resource_dir(
        &self,
        resource_dir: &Path,
    ) -> Result<SimulationStatus, SimulationError> {
        let (path, root) = resolve_sidecar_resources(resource_dir)?;
        self.start_path(path, root)
    }

    fn start_path(
        &self,
        path: PathBuf,
        resource_root: PathBuf,
    ) -> Result<SimulationStatus, SimulationError> {
        let generation = {
            let mut inner = self
                .core
                .inner
                .lock()
                .map_err(|_| SimulationError::internal())?;
            if !inner.state.can_start() {
                return Err(SimulationError::new(
                    "ALREADY_RUNNING",
                    "The simulation sidecar is already running.",
                ));
            }
            inner.generation = inner.generation.wrapping_add(1);
            inner.state = LifecycleState::Starting;
            inner.simulation_state = SimulationState::Unloaded;
            inner.model = None;
            inner.latest_pose = None;
            inner.latest_telemetry = None;
            inner.last_telemetry_webview_at = None;
            inner.latest_collision_event = None;
            inner.latest_motion_command = None;
            inner.telemetry_config = TelemetryConfig { rate_hz: 50 };
            inner.error = None;
            inner.protocol_errors = 0;
            inner.protocol_error_total = 0;
            inner.first_protocol_failure = None;
            inner.generation
        };
        let spawned = match process::spawn(&path, &resource_root) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.set_failed(generation, error.clone());
                return Err(error);
            }
        };
        let child = Arc::new(Mutex::new(spawned.child));
        let guard = Arc::new(spawned.guard);
        let (stdin, stdout, stderr) = {
            let mut guard = child.lock().map_err(|_| SimulationError::internal())?;
            (guard.stdin.take(), guard.stdout.take(), guard.stderr.take())
        };
        let stdin = Arc::new(Mutex::new(stdin.ok_or_else(SimulationError::internal)?));
        let stdout = stdout.ok_or_else(SimulationError::internal)?;
        let stderr = stderr.ok_or_else(SimulationError::internal)?;
        let stdout_thread = spawn_stdout_reader(
            Arc::downgrade(&self.core),
            generation,
            stdout,
            Arc::clone(&guard),
        );
        let stderr_thread = spawn_stderr_reader(Arc::downgrade(&self.core), generation, stderr);
        {
            let mut inner = self
                .core
                .inner
                .lock()
                .map_err(|_| SimulationError::internal())?;
            inner.runtime = Some(ProcessRuntime {
                child,
                stdin,
                guard,
                #[cfg(target_os = "linux")]
                _parent_keeper: spawned.parent_keeper,
                stdout_thread: Some(stdout_thread),
                stderr_thread: Some(stderr_thread),
            });
        }
        match self.request(ProtocolCommand::Hello, START_TIMEOUT) {
            Ok(ProtocolResponse::Ready(payload)) => {
                let mut inner = self
                    .core
                    .inner
                    .lock()
                    .map_err(|_| SimulationError::internal())?;
                inner.state = LifecycleState::Ready;
                inner.sidecar_version = Some(payload.sidecar_version);
                inner.started_at = Some(unix_milliseconds());
                Ok(self.status_unlocked(&inner))
            }
            Ok(_) => {
                let error = SimulationError::protocol();
                self.set_failed(generation, error.clone());
                self.cleanup_process(false);
                Err(error)
            }
            Err(error) => {
                self.set_failed(generation, error.clone());
                self.cleanup_process(false);
                Err(error)
            }
        }
    }

    fn status_unlocked(&self, inner: &ManagerInner) -> SimulationStatus {
        SimulationStatus {
            state: inner.state,
            simulation_state: inner.simulation_state,
            sidecar_version: inner.sidecar_version.clone(),
            model: inner.model.clone(),
            speed: inner.speed,
            started_at: inner.started_at,
            error: inner.error.clone(),
        }
    }

    pub fn ping(&self) -> Result<PingResult, SimulationError> {
        if self.status().state != LifecycleState::Ready {
            return Err(SimulationError::invalid_state());
        }
        let nonce = format!("nonce-{}", unix_milliseconds());
        let started = Instant::now();
        let response = match self.request(
            ProtocolCommand::Ping {
                nonce: nonce.clone(),
            },
            PING_TIMEOUT,
        ) {
            Ok(response) => response,
            Err(error) => {
                if error.code == "SIDECAR_REQUEST_TIMEOUT" {
                    if let Ok(mut inner) = self.core.inner.lock() {
                        inner.state = LifecycleState::Unresponsive;
                        inner.error = Some(error.clone());
                    }
                }
                return Err(error);
            }
        };
        match response {
            ProtocolResponse::Pong(payload) if payload.nonce == Some(nonce) => Ok(PingResult {
                latency_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
                nonce_verified: true,
            }),
            ProtocolResponse::Error(error) => Err(SimulationError::new(
                &error.code,
                "The simulation sidecar rejected the ping request.",
            )),
            _ => Err(SimulationError::protocol()),
        }
    }

    #[cfg(test)]
    pub fn load_model(&self, model_id: &str) -> Result<ModelLoadedPayload, SimulationError> {
        self.load_model_in_environment(model_id, EnvironmentId::FlatGroundV1)
    }
    pub fn load_model_in_environment(
        &self,
        model_id: &str,
        environment_id: EnvironmentId,
    ) -> Result<ModelLoadedPayload, SimulationError> {
        self.require_ready()?;
        match self.request(
            ProtocolCommand::LoadModel {
                model_id: model_id.to_owned(),
                environment_id,
            },
            COMMAND_TIMEOUT,
        )? {
            ProtocolResponse::ModelLoaded(value) => Ok(value),
            other => response_error(other),
        }
    }
    pub fn current_environment(&self) -> Option<EnvironmentMetadata> {
        self.core
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.model.as_ref().map(|model| model.environment.clone()))
    }
    pub fn latest_collision(&self) -> Option<CollisionTelemetry> {
        self.core.inner.lock().ok().and_then(|inner| {
            inner
                .latest_telemetry
                .as_ref()
                .map(|value| value.collision.clone())
        })
    }
    pub fn latest_collision_event(&self) -> Option<CollisionEvent> {
        self.core
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.latest_collision_event.clone())
    }
    pub fn run_start(&self) -> Result<SimulationState, SimulationError> {
        self.state_command(ProtocolCommand::Start)
    }
    pub fn run_pause(&self) -> Result<SimulationState, SimulationError> {
        self.state_command(ProtocolCommand::Pause)
    }
    pub fn run_reset(&self) -> Result<SimulationState, SimulationError> {
        let state = self.state_command(ProtocolCommand::Reset)?;
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        while Instant::now() < deadline {
            if self
                .latest_pose()
                .is_some_and(|pose| pose.sequence == 0 && pose.simulation_time == 0.0)
            {
                return Ok(state);
            }
            thread::sleep(Duration::from_millis(2));
        }
        Err(SimulationError::timeout("SIDECAR_RESET_POSE_TIMEOUT"))
    }
    #[cfg(test)]
    pub(crate) fn reset_preserving_run_state(&self) -> Result<SimulationState, SimulationError> {
        let resume_after_reset = self.status().simulation_state == SimulationState::Running;
        if resume_after_reset {
            self.run_pause()?;
        }
        let state = self.run_reset()?;
        if resume_after_reset {
            self.run_start()
        } else {
            Ok(state)
        }
    }
    pub fn run_stop(&self) -> Result<SimulationState, SimulationError> {
        self.state_command(ProtocolCommand::Stop)
    }
    pub fn run_step(&self, steps: u16) -> Result<RobotPose, SimulationError> {
        self.require_ready()?;
        if !(1..=1000).contains(&steps) {
            return Err(SimulationError::new(
                "INVALID_STEPS",
                "Simulation steps must be between 1 and 1000.",
            ));
        }
        match self.request(ProtocolCommand::Step { steps }, COMMAND_TIMEOUT)? {
            ProtocolResponse::Pose(pose) => Ok(pose),
            other => response_error(other),
        }
    }
    pub fn set_speed(&self, speed: f64) -> Result<f64, SimulationError> {
        self.require_ready()?;
        match self.request(ProtocolCommand::SetSpeed { speed }, COMMAND_TIMEOUT)? {
            ProtocolResponse::StateChanged(payload) => Ok(payload.speed.unwrap_or(speed)),
            other => response_error(other),
        }
    }
    pub fn set_motion_command(
        &self,
        command: MotionCommand,
    ) -> Result<MotionCommandStatus, SimulationError> {
        self.set_motion_command_for_source(command, ControlSource::Manual)
    }
    pub(crate) fn set_ros_motion_command(
        &self,
        command: MotionCommand,
    ) -> Result<MotionCommandStatus, SimulationError> {
        self.set_motion_command_for_source(command, ControlSource::Ros)
    }
    fn set_motion_command_for_source(
        &self,
        command: MotionCommand,
        source: ControlSource,
    ) -> Result<MotionCommandStatus, SimulationError> {
        if self.control_source() != source {
            return Err(SimulationError::new(
                "CONTROL_SOURCE_MISMATCH",
                "The motion command does not own the active control source.",
            ));
        }
        self.require_ready()?;
        command.validate()?;
        match self.request(ProtocolCommand::SetMotionCommand(command), COMMAND_TIMEOUT)? {
            ProtocolResponse::MotionCommandChanged(value) => Ok(value),
            other => response_error(other),
        }
    }
    pub fn clear_motion_command(&self) -> Result<MotionCommandStatus, SimulationError> {
        self.require_ready()?;
        match self.request(ProtocolCommand::ClearMotionCommand, COMMAND_TIMEOUT)? {
            ProtocolResponse::MotionCommandChanged(value) => Ok(value),
            other => response_error(other),
        }
    }
    pub fn set_telemetry_rate(&self, rate_hz: u16) -> Result<TelemetryConfig, SimulationError> {
        self.require_ready()?;
        match self.request(
            ProtocolCommand::SetTelemetryRate { rate_hz },
            COMMAND_TIMEOUT,
        )? {
            ProtocolResponse::TelemetryConfigChanged(value) => Ok(value),
            other => response_error(other),
        }
    }
    pub(crate) fn latest_telemetry(&self) -> Option<RobotTelemetry> {
        self.core
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.latest_telemetry.clone())
    }
    pub fn control_source(&self) -> ControlSource {
        self.core
            .inner
            .lock()
            .map(|inner| inner.control_source)
            .unwrap_or(ControlSource::Manual)
    }
    pub(crate) fn set_control_source(&self, source: ControlSource) {
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.control_source = source;
        }
    }
    pub fn get_latest_telemetry(&self) -> Result<RobotTelemetry, SimulationError> {
        self.require_ready()?;
        match self.request(ProtocolCommand::GetLatestTelemetry, COMMAND_TIMEOUT)? {
            ProtocolResponse::Telemetry(value) => Ok(*value),
            other => response_error(other),
        }
    }
    fn state_command(&self, command: ProtocolCommand) -> Result<SimulationState, SimulationError> {
        self.require_ready()?;
        match self.request(command, COMMAND_TIMEOUT)? {
            ProtocolResponse::StateChanged(payload) => Ok(payload.state),
            other => response_error(other),
        }
    }
    fn require_ready(&self) -> Result<(), SimulationError> {
        if self.status().state == LifecycleState::Ready {
            Ok(())
        } else {
            Err(SimulationError::invalid_state())
        }
    }
    pub fn latest_pose(&self) -> Option<RobotPose> {
        self.core
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.latest_pose.clone())
    }
    pub fn subscribe(
        &self,
        subscription_id: String,
        channel: Channel<SimulationEvent>,
    ) -> Result<(), SimulationError> {
        if subscription_id.is_empty()
            || subscription_id.len() > 64
            || !subscription_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(SimulationError::new(
                "INVALID_SUBSCRIPTION_ID",
                "The simulation subscription identifier is invalid.",
            ));
        }
        let mut inner = self
            .core
            .inner
            .lock()
            .map_err(|_| SimulationError::internal())?;
        if inner.subscribers.contains_key(&subscription_id) {
            return Err(SimulationError::new(
                "DUPLICATE_SUBSCRIPTION",
                "The simulation subscription already exists.",
            ));
        }
        inner.subscribers.insert(subscription_id, channel);
        Ok(())
    }

    pub fn unsubscribe(&self, subscription_id: &str) -> Result<(), SimulationError> {
        let mut inner = self
            .core
            .inner
            .lock()
            .map_err(|_| SimulationError::internal())?;
        inner.subscribers.remove(subscription_id);
        Ok(())
    }

    pub fn stop(&self) -> Result<SimulationStatus, SimulationError> {
        let state = self.status().state;
        if state == LifecycleState::Idle {
            return Ok(self.status());
        }
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.state = LifecycleState::Stopping;
        }
        if matches!(state, LifecycleState::Ready | LifecycleState::Starting) {
            let _ = self.request(ProtocolCommand::Shutdown, STOP_TIMEOUT);
        }
        self.cleanup_process(true);
        let mut inner = self
            .core
            .inner
            .lock()
            .map_err(|_| SimulationError::internal())?;
        inner.state = LifecycleState::Idle;
        inner.simulation_state = SimulationState::Unloaded;
        inner.error = None;
        inner.started_at = None;
        inner.sidecar_version = None;
        inner.model = None;
        inner.latest_pose = None;
        inner.latest_telemetry = None;
        inner.last_telemetry_webview_at = None;
        inner.latest_collision_event = None;
        inner.latest_motion_command = None;
        inner.telemetry_config = TelemetryConfig { rate_hz: 50 };
        inner.speed = 1.0;
        Ok(self.status_unlocked(&inner))
    }
    pub fn shutdown_for_exit(&self) {
        let _ = self.stop();
    }

    fn request(
        &self,
        command: ProtocolCommand,
        timeout: Duration,
    ) -> Result<ProtocolResponse, SimulationError> {
        let (id, receiver, stdin) = {
            let mut inner = self
                .core
                .inner
                .lock()
                .map_err(|_| SimulationError::internal())?;
            inner.request_counter = inner.request_counter.wrapping_add(1);
            let id = format!("request-{}-{}", inner.generation, inner.request_counter);
            let stdin = inner
                .runtime
                .as_ref()
                .map(|r| Arc::clone(&r.stdin))
                .ok_or_else(SimulationError::invalid_state)?;
            let (sender, receiver) = mpsc::channel();
            inner.pending.insert(id.clone(), sender);
            (id, receiver, stdin)
        };
        let line = command.to_line(id.clone(), unix_milliseconds())?;
        let write = stdin
            .lock()
            .map_err(|_| SimulationError::internal())
            .and_then(|mut writer| {
                writer
                    .write_all(line.as_bytes())
                    .and_then(|_| writer.write_all(b"\n"))
                    .and_then(|_| writer.flush())
                    .map_err(|_| {
                        SimulationError::new(
                            "SIDECAR_WRITE_FAILED",
                            "The sidecar command could not be sent.",
                        )
                    })
            });
        if let Err(error) = write {
            if let Ok(mut inner) = self.core.inner.lock() {
                inner.pending.remove(&id);
            }
            return Err(error);
        }
        let received = receiver.recv_timeout(timeout);
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.pending.remove(&id);
        }
        match received {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(SimulationError::timeout("SIDECAR_REQUEST_TIMEOUT"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(SimulationError::new(
                "SIDECAR_DISCONNECTED",
                "The simulation sidecar disconnected.",
            )),
        }
    }

    fn cleanup_process(&self, graceful: bool) {
        let snapshot = self.core.inner.lock().ok().and_then(|inner| {
            inner
                .runtime
                .as_ref()
                .map(|r| (Arc::clone(&r.child), Arc::clone(&r.guard)))
        });
        if let Some((child, guard)) = snapshot {
            let deadline = Instant::now()
                + if graceful {
                    STOP_TIMEOUT
                } else {
                    Duration::ZERO
                };
            let mut exited = false;
            loop {
                if let Ok(mut child) = child.lock() {
                    if child.try_wait().ok().flatten().is_some() {
                        exited = true;
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            if !exited {
                let _ = guard.terminate();
            }
            if let Ok(mut child) = child.lock() {
                let _ = child.wait();
            }
        }
        let mut runtime = self.core.inner.lock().ok().and_then(|mut inner| {
            inner.pending.clear();
            inner.runtime.take()
        });
        if let Some(runtime) = runtime.as_mut() {
            if let Some(handle) = runtime.stdout_thread.take() {
                let _ = handle.join();
            }
            if let Some(handle) = runtime.stderr_thread.take() {
                let _ = handle.join();
            }
        }
    }
    fn set_failed(&self, generation: u64, error: SimulationError) {
        if let Ok(mut inner) = self.core.inner.lock() {
            if inner.generation == generation {
                inner.state = LifecycleState::Failed;
                inner.error = Some(error);
            }
        }
    }
    #[cfg(test)]
    fn force_terminate_for_test(&self) {
        if let Ok(inner) = self.core.inner.lock() {
            if let Some(runtime) = &inner.runtime {
                let _ = runtime.guard.terminate();
            }
        }
    }
}

impl Drop for SimulationManager {
    fn drop(&mut self) {
        if Arc::strong_count(&self.core) == 1 {
            self.cleanup_process(false);
        }
    }
}

fn response_error<T>(response: ProtocolResponse) -> Result<T, SimulationError> {
    match response {
        ProtocolResponse::Error(error) => Err(SimulationError::new(
            &error.code,
            "The simulation command was rejected.",
        )),
        _ => Err(SimulationError::protocol()),
    }
}

pub fn resolve_sidecar_resources(
    resource_dir: &Path,
) -> Result<(PathBuf, PathBuf), SimulationError> {
    let root = fs::canonicalize(resource_dir).map_err(|_| {
        SimulationError::new(
            "SIDECAR_RESOURCE_MISSING",
            "The bundled simulation sidecar is unavailable.",
        )
    })?;
    let candidate = root
        .join("resources")
        .join("sidecar")
        .join(SIDECAR_FILE_NAME);
    let path = fs::canonicalize(candidate).map_err(|_| {
        SimulationError::new(
            "SIDECAR_RESOURCE_MISSING",
            "The bundled simulation sidecar is unavailable.",
        )
    })?;
    #[cfg(windows)]
    let platform_valid = path.extension().and_then(|value| value.to_str()) == Some("exe");
    #[cfg(target_os = "linux")]
    let platform_valid = path
        .metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false);
    if !path.starts_with(&root) || !path.is_file() || !platform_valid {
        return Err(SimulationError::new(
            "SIDECAR_RESOURCE_INVALID",
            "The bundled simulation sidecar is invalid.",
        ));
    }
    let required: &[&[&str]] = &[
        &["resources", "sidecar", MUJOCO_RUNTIME_FILE_NAME],
        &[
            "resources",
            "simulation",
            "models",
            "minimal-quadruped-v1.xml",
        ],
        &[
            "resources",
            "simulation",
            "models",
            "unitree-go2-menagerie",
            "unitree-go2-scene.xml",
        ],
        &[
            "resources",
            "simulation",
            "models",
            "unitree-go2-flat-ground-v1.xml",
        ],
        &[
            "resources",
            "simulation",
            "models",
            "unitree-go2-menagerie",
            "upstream",
            "go2.xml",
        ],
        &[
            "resources",
            "simulation",
            "models",
            "unitree-go2-menagerie",
            "upstream",
            "LICENSE",
        ],
        &[
            "resources",
            "simulation",
            "models",
            "unitree-go2-menagerie",
            "SOURCE.md",
        ],
        &[
            "resources",
            "simulation",
            "models",
            "unitree-go2-menagerie",
            "menagerie.lock.json",
        ],
        &["resources", "licenses", "MuJoCo-Apache-2.0.txt"],
    ];
    for relative in required {
        let file = relative
            .iter()
            .fold(root.clone(), |path, segment| path.join(segment));
        let canonical = fs::canonicalize(file).map_err(|_| {
            SimulationError::new(
                "SIDECAR_RESOURCE_MISSING",
                "A bundled simulation resource is unavailable.",
            )
        })?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(SimulationError::new(
                "SIDECAR_RESOURCE_INVALID",
                "A bundled simulation resource is invalid.",
            ));
        }
    }
    Ok((path, root))
}

fn spawn_stdout_reader(
    core: Weak<ManagerCore>,
    generation: u64,
    stdout: impl Read + Send + 'static,
    guard: Arc<ProcessGuard>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader
                .by_ref()
                .take((MAX_LINE_BYTES + 2) as u64)
                .read_until(b'\n', &mut buffer)
            {
                Ok(0) => {
                    mark_crashed(&core, generation, "SIDECAR_EXITED");
                    break;
                }
                Ok(_) => {
                    if buffer.last() == Some(&b'\n') {
                        buffer.pop();
                    }
                    if buffer.last() == Some(&b'\r') {
                        buffer.pop();
                    }
                    if buffer.len() > MAX_LINE_BYTES {
                        mark_crashed(&core, generation, "MESSAGE_TOO_LARGE");
                        let _ = guard.terminate();
                        break;
                    }
                    match parse_response_line(&buffer) {
                        Ok(message) => {
                            handle_message(&core, generation, message.request_id, message.response)
                        }
                        Err(error) => {
                            let summary = summarize_protocol_failure(&buffer);
                            let should_terminate =
                                record_protocol_error(&core, generation, error, summary);
                            if should_terminate {
                                let _ = guard.terminate();
                                break;
                            }
                        }
                    }
                }
                Err(_) => {
                    mark_crashed(&core, generation, "SIDECAR_READ_FAILED");
                    let _ = guard.terminate();
                    break;
                }
            }
        }
    })
}

fn telemetry_safety_changed(previous: Option<&RobotTelemetry>, next: &RobotTelemetry) -> bool {
    previous.map_or(true, |current| {
        current.collision.is_fallen != next.collision.is_fallen
            || current.collision.is_out_of_bounds != next.collision.is_out_of_bounds
            || current.locomotion.availability != next.locomotion.availability
            || current.locomotion.state != next.locomotion.state
            || current.locomotion.fault_reason != next.locomotion.fault_reason
            || current.command.timed_out != next.command.timed_out
            || current.command.controller_availability != next.command.controller_availability
    })
}

fn handle_message(
    core: &Weak<ManagerCore>,
    generation: u64,
    request_id: Option<String>,
    response: ProtocolResponse,
) {
    let Some(core) = core.upgrade() else { return };
    let mut event = None;
    let sender = {
        let Ok(mut inner) = core.inner.lock() else {
            return;
        };
        if inner.generation != generation {
            return;
        }
        inner.protocol_errors = 0;
        match &response {
            ProtocolResponse::ModelLoaded(model) => {
                inner.model = Some(model.clone());
                inner.simulation_state = SimulationState::Loaded;
                inner.latest_pose = None;
                inner.latest_telemetry = None;
                inner.last_telemetry_webview_at = None;
                inner.latest_collision_event = None;
                inner.latest_motion_command = None;
                event = Some(SimulationEvent::ModelLoaded(model.clone()));
            }
            ProtocolResponse::StateChanged(state) => {
                inner.simulation_state = state.state;
                if state.state == SimulationState::Loaded
                    && !inner
                        .latest_pose
                        .as_ref()
                        .is_some_and(|pose| pose.sequence == 0 && pose.simulation_time == 0.0)
                {
                    inner.latest_pose = None;
                    inner.latest_telemetry = None;
                    inner.last_telemetry_webview_at = None;
                    inner.latest_collision_event = None;
                }
                if let Some(speed) = state.speed {
                    inner.speed = speed;
                }
                event = Some(SimulationEvent::StateChanged(state.clone()));
            }
            ProtocolResponse::Pose(pose) => {
                let matches_model = inner
                    .model
                    .as_ref()
                    .is_some_and(|model| pose.has_model_joints(&model.model_id));
                let accept = matches_model
                    && match inner.latest_pose.as_ref() {
                        Some(current) => {
                            (pose.sequence == 0 && pose.simulation_time == 0.0)
                                || sequence_is_newer(pose.sequence, current.sequence)
                        }
                        None => true,
                    };
                if accept {
                    inner.latest_pose = Some(pose.clone());
                    event = Some(SimulationEvent::Pose(pose.clone()));
                }
            }
            ProtocolResponse::Telemetry(telemetry) => {
                let matches_model = inner
                    .model
                    .as_ref()
                    .is_some_and(|model| telemetry.model_id == model.model_id);
                let accept = matches_model
                    && match inner.latest_telemetry.as_ref() {
                        Some(current) => {
                            (telemetry.sequence == 0 && telemetry.simulation_time == 0.0)
                                || sequence_is_newer(telemetry.sequence, current.sequence)
                        }
                        None => true,
                    };
                if accept {
                    let safety_transition = telemetry_safety_changed(
                        inner.latest_telemetry.as_ref(),
                        telemetry.as_ref(),
                    );
                    let now = Instant::now();
                    let publish_to_webview = safety_transition
                        || inner.last_telemetry_webview_at.map_or(true, |last| {
                            now.duration_since(last) >= TELEMETRY_WEBVIEW_INTERVAL
                        });
                    inner.latest_motion_command = Some(telemetry.command.clone());
                    inner.latest_telemetry = Some(telemetry.as_ref().clone());
                    if publish_to_webview {
                        inner.last_telemetry_webview_at = Some(now);
                        event = Some(SimulationEvent::Telemetry(telemetry.clone()));
                    }
                }
            }
            ProtocolResponse::MotionCommandChanged(command) => {
                inner.latest_motion_command = Some(command.clone());
                if request_id.is_none() {
                    event = Some(SimulationEvent::MotionCommandChanged(command.clone()));
                }
            }
            ProtocolResponse::TelemetryConfigChanged(config) => {
                inner.telemetry_config = config.clone();
                event = Some(SimulationEvent::TelemetryConfigChanged(config.clone()));
            }
            ProtocolResponse::Collision(collision) => {
                inner.latest_collision_event = Some(collision.clone());
                event = Some(SimulationEvent::Collision(collision.clone()));
            }
            ProtocolResponse::Warning(warning) => {
                event = Some(SimulationEvent::Warning(warning.clone()))
            }
            ProtocolResponse::Error(error) if request_id.is_none() => {
                event = Some(SimulationEvent::Error(error.clone()))
            }
            _ => {}
        }
        request_id.as_ref().and_then(|id| inner.pending.remove(id))
    };
    if let Some(sender) = sender {
        let _ = sender.send(Ok(response));
    }
    if let Some(event) = event {
        dispatch_event(&core, event);
    }
}

fn dispatch_event(core: &Arc<ManagerCore>, event: SimulationEvent) {
    let subscribers = core
        .inner
        .lock()
        .ok()
        .map(|inner| {
            inner
                .subscribers
                .iter()
                .map(|(id, channel)| (id.clone(), channel.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let dead = subscribers
        .into_iter()
        .filter_map(|(id, channel)| channel.send(event.clone()).err().map(|_| id))
        .collect::<Vec<_>>();
    if !dead.is_empty() {
        if let Ok(mut inner) = core.inner.lock() {
            for id in dead {
                inner.subscribers.remove(&id);
            }
        }
    }
}

fn record_protocol_error(
    core: &Weak<ManagerCore>,
    generation: u64,
    error: SimulationError,
    summary: ProtocolFrameSummary,
) -> bool {
    let Some(core) = core.upgrade() else {
        return true;
    };
    let Ok(mut inner) = core.inner.lock() else {
        return true;
    };
    if inner.generation != generation {
        return false;
    }
    inner.protocol_error_total = inner.protocol_error_total.saturating_add(1);
    if inner.first_protocol_failure.is_none() {
        let diagnostic = ProtocolFailureDiagnostic {
            frame_type: summary.frame_type,
            controller_state: summary.controller_state,
            fault_reason: summary.fault_reason,
            simulation_state: inner.simulation_state,
            sequence: summary.sequence,
            timestamp: summary.timestamp,
            validator_field: summary.validator_field,
            frame_bytes: summary.frame_bytes,
            sample: summary.sample,
        };
        #[cfg(debug_assertions)]
        eprintln!(
            "SIDECAR_FIRST_PROTOCOL_FAILURE type={} controller_state={} fault_reason={} simulation_state={:?} sequence={} timestamp={} validator_field={} frame_bytes={} sample={:?}",
            diagnostic.frame_type,
            diagnostic.controller_state.as_deref().unwrap_or("null"),
            diagnostic.fault_reason.as_deref().unwrap_or("null"),
            diagnostic.simulation_state,
            diagnostic.sequence.map_or_else(|| "null".into(), |value| value.to_string()),
            diagnostic.timestamp.map_or_else(|| "null".into(), |value| value.to_string()),
            diagnostic.validator_field,
            diagnostic.frame_bytes,
            diagnostic.sample,
        );
        inner.first_protocol_failure = Some(diagnostic);
    }
    inner.protocol_errors = inner.protocol_errors.saturating_add(1);
    inner.error = Some(error);
    if inner.protocol_errors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS {
        inner.state = LifecycleState::Failed;
        true
    } else {
        false
    }
}

fn summarize_protocol_failure(buffer: &[u8]) -> ProtocolFrameSummary {
    let sample = bounded_protocol_sample(buffer);
    let value = match serde_json::from_slice::<serde_json::Value>(buffer) {
        Ok(value) => value,
        Err(error) => {
            return ProtocolFrameSummary {
                frame_type: "invalid-json".into(),
                controller_state: None,
                fault_reason: None,
                sequence: None,
                timestamp: None,
                validator_field: format!("json-line-{}-column-{}", error.line(), error.column()),
                frame_bytes: buffer.len(),
                sample,
            };
        }
    };
    let frame_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .chars()
        .take(64)
        .collect::<String>();
    let locomotion = value.pointer("/payload/locomotion");
    let controller_state = locomotion
        .and_then(|item| item.get("state"))
        .and_then(serde_json::Value::as_str)
        .map(|item| item.chars().take(64).collect::<String>());
    let fault_reason = locomotion
        .and_then(|item| item.get("faultReason"))
        .and_then(serde_json::Value::as_str)
        .map(|item| item.chars().take(128).collect::<String>());
    let state_is_fault = controller_state.as_deref() == Some("fault");
    let validator_field = if locomotion.is_some() && state_is_fault != fault_reason.is_some() {
        "locomotion.state/faultReason"
    } else {
        "response-schema-or-semantics"
    };
    ProtocolFrameSummary {
        frame_type,
        controller_state,
        fault_reason,
        sequence: value
            .pointer("/payload/sequence")
            .and_then(serde_json::Value::as_u64),
        timestamp: value.get("timestamp").and_then(serde_json::Value::as_i64),
        validator_field: validator_field.into(),
        frame_bytes: buffer.len(),
        sample,
    }
}

fn bounded_protocol_sample(buffer: &[u8]) -> String {
    const EDGE_BYTES: usize = 160;
    let sanitize = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .chars()
            .filter(|value| !value.is_control())
            .collect::<String>()
    };
    if buffer.len() <= EDGE_BYTES * 2 {
        sanitize(buffer)
    } else {
        format!(
            "{}…{}",
            sanitize(&buffer[..EDGE_BYTES]),
            sanitize(&buffer[buffer.len() - EDGE_BYTES..])
        )
    }
}

fn spawn_stderr_reader(
    core: Weak<ManagerCore>,
    generation: u64,
    stderr: impl Read + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            let Ok(read) = reader.by_ref().take(1026).read_line(&mut line) else {
                break;
            };
            if read == 0 {
                break;
            }
            let sanitized: String = line
                .chars()
                .filter(|c| !c.is_control())
                .take(1024)
                .collect();
            let Some(core) = core.upgrade() else { break };
            let Ok(mut inner) = core.inner.lock() else {
                break;
            };
            if inner.generation != generation {
                break;
            }
            inner.stderr_bytes += sanitized.len();
            inner.stderr_lines.push_back(sanitized);
            while inner.stderr_lines.len() > STDERR_MAX_LINES
                || inner.stderr_bytes > STDERR_MAX_BYTES
            {
                if let Some(removed) = inner.stderr_lines.pop_front() {
                    inner.stderr_bytes -= removed.len();
                } else {
                    break;
                }
            }
        }
    })
}

fn mark_crashed(core: &Weak<ManagerCore>, generation: u64, code: &str) {
    let Some(core) = core.upgrade() else { return };
    let error = SimulationError::new(code, "The simulation sidecar exited unexpectedly.");
    let pending = core
        .inner
        .lock()
        .ok()
        .map(|mut inner| {
            if inner.generation != generation
                || matches!(inner.state, LifecycleState::Idle | LifecycleState::Stopping)
            {
                return Vec::new();
            }
            #[cfg(debug_assertions)]
            {
                let exit = inner
                    .runtime
                    .as_ref()
                    .and_then(|runtime| runtime.child.lock().ok())
                    .and_then(|mut child| child.try_wait().ok().flatten());
                #[cfg(target_os = "linux")]
                let exit_detail = exit.map_or_else(
                    || "pending".into(),
                    |status| {
                        status.code().map_or_else(
                            || format!("signal-{}", status.signal().unwrap_or_default()),
                            |value| format!("exit-{value}"),
                        )
                    },
                );
                #[cfg(windows)]
                let exit_detail = exit.map_or_else(
                    || "pending".into(),
                    |status| {
                        status
                            .code()
                            .map_or_else(|| "unknown".into(), |value| format!("exit-{value}"))
                    },
                );
                let stderr = inner
                    .stderr_lines
                    .iter()
                    .rev()
                    .take(3)
                    .rev()
                    .map(|line| line.chars().take(256).collect::<String>())
                    .collect::<Vec<_>>()
                    .join(" | ");
                eprintln!(
                    "SIDECAR_CRASH code={} exit={} protocol_error_total={} stderr={:?}",
                    code, exit_detail, inner.protocol_error_total, stderr
                );
            }
            inner.state = LifecycleState::Crashed;
            inner.simulation_state = SimulationState::Unloaded;
            inner.model = None;
            inner.latest_pose = None;
            inner.latest_telemetry = None;
            inner.last_telemetry_webview_at = None;
            inner.latest_motion_command = None;
            inner.telemetry_config = TelemetryConfig { rate_hz: 50 };
            inner.error = Some(error.clone());
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in pending {
        let _ = sender.send(Err(error.clone()));
    }
}

fn unix_milliseconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile_root(profile: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(profile)
    }
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }
    fn wait_state(manager: &SimulationManager, state: LifecycleState) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if manager.status().state == state {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("state timeout");
    }

    #[test]
    fn actual_sidecar_full_lifecycle_and_no_orphan() {
        let _guard = guard();
        let manager = SimulationManager::new();
        let sidecar_started = Instant::now();
        assert_eq!(
            manager
                .start_from_resource_dir(&profile_root("debug"))
                .unwrap()
                .state,
            LifecycleState::Ready
        );
        let sidecar_start_ms = sidecar_started.elapsed().as_millis();
        assert!(manager.ping().unwrap().nonce_verified);
        let model_started = Instant::now();
        let metadata = manager
            .load_model(super::super::protocol::MINIMAL_MODEL_ID)
            .unwrap();
        let model_load_ms = model_started.elapsed().as_millis();
        assert_eq!(metadata.joint_count, 12);
        let run_started = Instant::now();
        assert_eq!(manager.run_start().unwrap(), SimulationState::Running);
        let start_response_ms = run_started.elapsed().as_millis();
        let deadline = Instant::now() + Duration::from_secs(2);
        while manager.latest_pose().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(manager.latest_pose().is_some());
        while manager.latest_telemetry().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let initial_telemetry = manager.latest_telemetry().unwrap();
        assert_eq!(initial_telemetry.joints.len(), 12);
        assert_eq!(initial_telemetry.feet.len(), 4);
        assert_eq!(initial_telemetry.source.kind, "mujoco-simulation");
        assert!(!initial_telemetry.source.connected_to_physical_robot);
        assert_eq!(manager.set_telemetry_rate(10).unwrap().rate_hz, 10);
        assert_eq!(manager.set_telemetry_rate(100).unwrap().rate_hz, 100);
        assert!(manager.set_telemetry_rate(9).is_err());
        let unavailable = manager
            .set_motion_command(super::super::protocol::MotionCommand {
                sequence: 7,
                mode: super::super::protocol::MotionCommandMode::Locomotion,
                forward_velocity: 0.2,
                lateral_velocity: 0.0,
                yaw_rate: 0.1,
                body_height: 0.3,
                valid_for_ms: 100,
            })
            .unwrap_err();
        assert_eq!(unavailable.code, "LOCOMOTION_UNAVAILABLE");
        let cleared = manager.clear_motion_command().unwrap();
        assert_eq!(
            cleared.mode,
            super::super::protocol::MotionCommandMode::Stand
        );
        assert!(cleared.applied_by_controller);
        assert_eq!(manager.set_telemetry_rate(50).unwrap().rate_hz, 50);
        let frequency_base = manager.latest_pose().unwrap();
        let frequency_started = Instant::now();
        thread::sleep(Duration::from_millis(500));
        let frequency_elapsed = frequency_started.elapsed().as_secs_f64();
        let frequency_pose = manager.latest_pose().unwrap();
        let pose_hz = f64::from(
            frequency_pose
                .sequence
                .wrapping_sub(frequency_base.sequence),
        ) / frequency_elapsed;
        let sim_rate =
            (frequency_pose.simulation_time - frequency_base.simulation_time) / frequency_elapsed;
        println!("D4C_POSE_HZ_OBSERVED={pose_hz:.2} D4C_SIM_RATE={sim_rate:.3}");
        assert!((50.0..=65.0).contains(&pose_hz));
        thread::sleep(Duration::from_millis(550));
        let performance_sample = manager.get_latest_telemetry().unwrap();
        let performance = &performance_sample.performance;
        assert!((400.0..=600.0).contains(&performance.physics_frequency_hz));
        assert!((80.0..=120.0).contains(&performance.control_frequency_hz));
        assert!((50.0..=65.0).contains(&performance.pose_publish_frequency_hz));
        assert!((40.0..=60.0).contains(&performance.telemetry_publish_frequency_hz));
        assert!((0.7..=1.3).contains(&performance.real_time_factor));
        let telemetry_json_bytes = serde_json::to_vec(&performance_sample).unwrap().len();
        let mean_foot_normal = performance_sample
            .feet
            .iter()
            .map(|foot| foot.normal_force)
            .sum::<f64>()
            / 4.0;
        println!("D5VA_METRICS physics_hz={:.2} control_hz={:.2} pose_hz={:.2} telemetry_hz={:.2} real_time_factor={:.3} physics_mean_ms={:.5} physics_max_ms={:.5} control_mean_ms={:.5} control_max_ms={:.5} dropped_pose={} dropped_telemetry={} catch_up={} telemetry_json_bytes={} mean_foot_normal_n={:.2}", performance.physics_frequency_hz, performance.control_frequency_hz, performance.pose_publish_frequency_hz, performance.telemetry_publish_frequency_hz, performance.real_time_factor, performance.physics_step_mean_ms, performance.physics_step_max_ms, performance.control_step_mean_ms, performance.control_step_max_ms, performance.dropped_pose_events, performance.dropped_telemetry_events, performance.catch_up_step_count, telemetry_json_bytes, mean_foot_normal);
        assert_eq!(manager.run_pause().unwrap(), SimulationState::Paused);
        // A final pose already queued by the sidecar may arrive after the pause response.
        thread::sleep(Duration::from_millis(40));
        let paused = manager.latest_pose().unwrap().simulation_time;
        thread::sleep(Duration::from_millis(40));
        assert_eq!(manager.latest_pose().unwrap().simulation_time, paused);
        let stepped = manager.run_step(10).unwrap();
        assert!((stepped.simulation_time - paused - 0.02).abs() < 1e-8);
        manager.run_reset().unwrap();
        let deterministic_a = manager.run_step(100).unwrap();
        manager.run_reset().unwrap();
        let deterministic_b = manager.run_step(100).unwrap();
        assert_eq!(deterministic_a.root_position, deterministic_b.root_position);
        assert_eq!(deterministic_a.joints, deterministic_b.joints);
        assert_eq!(manager.run_reset().unwrap(), SimulationState::Loaded);
        assert_eq!(manager.latest_pose().unwrap().simulation_time, 0.0);
        assert_eq!(manager.set_speed(2.0).unwrap(), 2.0);
        assert_eq!(manager.run_stop().unwrap(), SimulationState::Stopped);
        let go2 = manager
            .load_model(super::super::protocol::GO2_MODEL_ID)
            .unwrap();
        assert_eq!(go2.model_id, super::super::protocol::GO2_MODEL_ID);
        assert_eq!(go2.joint_count, 12);
        assert_eq!(go2.actuator_count, 12);
        let go2_pose = manager.run_step(10).unwrap();
        assert!(go2_pose.has_model_joints(super::super::protocol::GO2_MODEL_ID));
        assert!(go2_pose.root_position.iter().all(|value| value.is_finite()));
        assert_eq!(manager.run_reset().unwrap(), SimulationState::Loaded);
        assert_eq!(manager.run_start().unwrap(), SimulationState::Running);
        let go2_simulation_started = manager.get_latest_telemetry().unwrap().simulation_time;
        let go2_performance_started = Instant::now();
        for sequence in 20..55 {
            let target = manager
                .set_motion_command(super::super::protocol::MotionCommand {
                    sequence,
                    mode: super::super::protocol::MotionCommandMode::Locomotion,
                    forward_velocity: 0.18,
                    lateral_velocity: 0.0,
                    yaw_rate: 0.0,
                    body_height: 0.3,
                    valid_for_ms: 250,
                })
                .unwrap();
            assert_eq!(
                target.controller_availability,
                super::super::protocol::ControllerAvailability::Go2KinematicAnimationV1
            );
            thread::sleep(Duration::from_millis(60));
        }
        let gait = manager.get_latest_telemetry().unwrap();
        let go2_wall_elapsed = go2_performance_started.elapsed().as_secs_f64();
        let go2_simulation_elapsed = gait.simulation_time - go2_simulation_started;
        let raw_go2_rtf = go2_simulation_elapsed / go2_wall_elapsed;
        assert!(go2_wall_elapsed >= 2.0);
        assert!((400.0..=600.0).contains(&gait.performance.physics_frequency_hz));
        assert!((0.8..=1.2).contains(&gait.performance.real_time_factor));
        assert!((0.8..=1.2).contains(&raw_go2_rtf));
        assert!((gait.performance.real_time_factor - raw_go2_rtf).abs() <= 0.2);
        assert_eq!(gait.locomotion.controller_id, "go2-kinematic-animation-v1");
        assert_eq!(
            gait.locomotion.availability,
            super::super::protocol::LocomotionAvailability::Available
        );
        assert!(matches!(
            gait.locomotion.state,
            super::super::protocol::LocomotionState::Locomotion
        ));
        println!(
            "D6_ARCH1_GO2_KINEMATIC_METRICS physics_hz={:.2} rtf={:.3} raw_rtf={raw_go2_rtf:.3} wall_seconds={go2_wall_elapsed:.3} simulation_seconds={go2_simulation_elapsed:.3} gait_hz={:.2} integrated_forward={:.3} integrated_lateral={:.3} integrated_yaw={:.3}",
            gait.performance.physics_frequency_hz,
            gait.performance.real_time_factor,
            gait.locomotion.gait_frequency_hz,
            gait.locomotion.integrated_forward_velocity,
            gait.locomotion.integrated_lateral_velocity,
            gait.locomotion.integrated_yaw_rate,
        );
        manager.clear_motion_command().unwrap();
        assert_eq!(manager.run_pause().unwrap(), SimulationState::Paused);
        assert_eq!(manager.run_reset().unwrap(), SimulationState::Loaded);
        assert_eq!(manager.latest_pose().unwrap().simulation_time, 0.0);
        assert_eq!(manager.run_stop().unwrap(), SimulationState::Stopped);
        assert!(manager.ping().unwrap().nonce_verified);
        let stop_started = Instant::now();
        assert_eq!(manager.stop().unwrap().state, LifecycleState::Idle);
        let stop_ms = stop_started.elapsed().as_millis();
        println!("D4C_METRICS sidecar_start_ms={sidecar_start_ms} model_load_ms={model_load_ms} start_response_ms={start_response_ms} pose_hz={pose_hz:.2} normal_stop_ms={stop_ms} deterministic_time={}", deterministic_a.simulation_time);
    }

    #[test]
    fn sustained_go2_kinematic_animation_stays_protocol_valid() {
        let _guard = guard();
        let manager = SimulationManager::new();
        manager
            .start_from_resource_dir(&profile_root("debug"))
            .unwrap();
        manager
            .load_model(super::super::protocol::GO2_MODEL_ID)
            .unwrap();
        assert_eq!(manager.run_start().unwrap(), SimulationState::Running);

        let started = Instant::now();
        let mut sequence = 1_000_u32;
        while started.elapsed() < Duration::from_secs(10) {
            let phase = started.elapsed().as_secs_f64();
            let (forward_velocity, yaw_rate) = if phase < 2.0 {
                (0.12, 0.0)
            } else if phase < 4.0 {
                (0.12, 0.24)
            } else if phase < 6.0 {
                (0.12, -0.24)
            } else if phase < 8.0 {
                (-0.08, 0.24)
            } else {
                (-0.08, -0.24)
            };
            let result = manager.set_motion_command(super::super::protocol::MotionCommand {
                sequence,
                mode: super::super::protocol::MotionCommandMode::Locomotion,
                forward_velocity,
                lateral_velocity: 0.0,
                yaw_rate,
                body_height: 0.3,
                valid_for_ms: 250,
            });
            sequence = sequence.wrapping_add(1);
            if result.is_err() || manager.status().state != LifecycleState::Ready {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        let (protocol_error_total, first_failure) = manager
            .core
            .inner
            .lock()
            .map(|inner| {
                (
                    inner.protocol_error_total,
                    inner.first_protocol_failure.clone(),
                )
            })
            .unwrap();
        println!(
            "D6_FAULT1_SUSTAINED status={:?} protocol_errors={} first_failure={:?}",
            manager.status().state,
            protocol_error_total,
            first_failure
        );

        assert_eq!(protocol_error_total, 0);
        assert_eq!(manager.status().state, LifecycleState::Ready);
        assert!(manager.ping().unwrap().nonce_verified);
        assert!(manager.latest_telemetry().is_some_and(|telemetry| {
            telemetry.locomotion.state != LocomotionState::Fault
                && telemetry.locomotion.fault_reason.is_none()
        }));
        assert_eq!(
            manager.reset_preserving_run_state().unwrap(),
            SimulationState::Running
        );
        assert!(manager
            .latest_pose()
            .is_some_and(|pose| pose.simulation_time < 0.1));
        assert!(manager.ping().unwrap().nonce_verified);
        manager.stop().unwrap();
    }

    #[test]
    fn duplicate_start_crash_cleanup_and_restart() {
        let _guard = guard();
        let manager = SimulationManager::new();
        manager
            .start_from_resource_dir(&profile_root("debug"))
            .unwrap();
        assert_eq!(
            manager
                .start_from_resource_dir(&profile_root("debug"))
                .unwrap_err()
                .code,
            "ALREADY_RUNNING"
        );
        let forced_started = Instant::now();
        manager.force_terminate_for_test();
        wait_state(&manager, LifecycleState::Crashed);
        manager.stop().unwrap();
        println!("D4C_FORCE_STOP_MS={}", forced_started.elapsed().as_millis());
        manager
            .start_from_resource_dir(&profile_root("debug"))
            .unwrap();
        manager.shutdown_for_exit();
        assert_eq!(manager.status().state, LifecycleState::Idle);
    }

    #[test]
    fn fixed_resources_and_safe_errors() {
        for profile in ["debug", "release"] {
            let (path, root) = resolve_sidecar_resources(&profile_root(profile)).unwrap();
            assert!(path.starts_with(root));
        }
        let error = resolve_sidecar_resources(Path::new("Z:/private/missing")).unwrap_err();
        assert!(!error.message.contains("Z:"));
    }

    #[test]
    fn closed_channel_subscriber_is_removed() {
        let manager = SimulationManager::new();
        let channel = Channel::new(|_| Err(std::io::Error::other("closed").into()));
        manager
            .subscribe("test-subscription".into(), channel)
            .unwrap();
        dispatch_event(
            &manager.core,
            SimulationEvent::StateChanged(super::super::protocol::StateChangedPayload {
                state: SimulationState::Loaded,
                speed: Some(1.0),
            }),
        );
        assert!(manager.core.inner.lock().unwrap().subscribers.is_empty());
    }

    #[test]
    fn explicit_unsubscribe_drops_channel_and_is_idempotent() {
        let manager = SimulationManager::new();
        let channel = Channel::new(|_| Ok(()));
        manager
            .subscribe("test-subscription".into(), channel)
            .unwrap();
        manager.unsubscribe("test-subscription").unwrap();
        manager.unsubscribe("test-subscription").unwrap();
        assert!(manager.core.inner.lock().unwrap().subscribers.is_empty());
    }

    #[test]
    fn true_protocol_corruption_still_terminates_at_existing_threshold() {
        let manager = SimulationManager::new();
        let corrupt = ProtocolFrameSummary {
            frame_type: "invalid-json".into(),
            controller_state: None,
            fault_reason: None,
            sequence: None,
            timestamp: None,
            validator_field: "json-line-1-column-2".into(),
            frame_bytes: 2,
            sample: "{{".into(),
        };
        assert!(!record_protocol_error(
            &Arc::downgrade(&manager.core),
            0,
            SimulationError::protocol(),
            corrupt.clone(),
        ));
        assert!(!record_protocol_error(
            &Arc::downgrade(&manager.core),
            0,
            SimulationError::protocol(),
            corrupt.clone(),
        ));
        assert!(record_protocol_error(
            &Arc::downgrade(&manager.core),
            0,
            SimulationError::protocol(),
            corrupt,
        ));
        let inner = manager.core.inner.lock().unwrap();
        assert_eq!(inner.protocol_error_total, 3);
        assert_eq!(inner.protocol_errors, MAX_CONSECUTIVE_PROTOCOL_ERRORS);
        assert_eq!(inner.state, LifecycleState::Failed);
        assert_eq!(
            inner
                .first_protocol_failure
                .as_ref()
                .map(|failure| failure.validator_field.as_str()),
            Some("json-line-1-column-2")
        );
    }

    #[test]
    fn bounded_diagnostic_identifies_fault_state_reason_mismatch() {
        let frame = serde_json::json!({
            "protocolVersion": 1,
            "requestId": null,
            "type": "telemetry",
            "timestamp": 1_700_000_000_000_i64,
            "payload": {
                "sequence": 42,
                "locomotion": {
                    "state": "locomotion",
                    "faultReason": "fall-detected"
                }
            }
        });
        let summary = summarize_protocol_failure(&serde_json::to_vec(&frame).unwrap());
        assert_eq!(summary.frame_type, "telemetry");
        assert_eq!(summary.controller_state.as_deref(), Some("locomotion"));
        assert_eq!(summary.fault_reason.as_deref(), Some("fall-detected"));
        assert_eq!(summary.sequence, Some(42));
        assert_eq!(summary.validator_field, "locomotion.state/faultReason");
        assert!(summary.sample.len() <= 323);
    }
}

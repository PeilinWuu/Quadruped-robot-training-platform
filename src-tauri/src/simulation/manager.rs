use super::{
    error::SimulationError,
    process::{self, JobObject},
    protocol::{
        parse_response_line, sequence_is_newer, CollisionEvent, CollisionTelemetry, EnvironmentId,
        EnvironmentMetadata, ModelLoadedPayload, MotionCommand, MotionCommandStatus,
        ProtocolCommand, ProtocolResponse, RobotPose, RobotTelemetry, SimulationEvent,
        SimulationState, TelemetryConfig, MAX_LINE_BYTES,
    },
};
use serde::Serialize;
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

const START_TIMEOUT: Duration = Duration::from_secs(8);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const PING_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_MAX_LINES: usize = 100;
const STDERR_MAX_BYTES: usize = 64 * 1024;
const MAX_CONSECUTIVE_PROTOCOL_ERRORS: u8 = 3;
const SIDECAR_RELATIVE_PATH: [&str; 3] =
    ["resources", "sidecar", "quadruped-simulation-sidecar.exe"];

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

struct ProcessRuntime {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    job: Arc<JobObject>,
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
    latest_collision_event: Option<CollisionEvent>,
    latest_motion_command: Option<MotionCommandStatus>,
    telemetry_config: TelemetryConfig,
    speed: f64,
    started_at: Option<i64>,
    error: Option<SimulationError>,
    protocol_errors: u8,
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
                    latest_collision_event: None,
                    latest_motion_command: None,
                    telemetry_config: TelemetryConfig { rate_hz: 50 },
                    speed: 1.0,
                    started_at: None,
                    error: None,
                    protocol_errors: 0,
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
            inner.latest_collision_event = None;
            inner.latest_motion_command = None;
            inner.telemetry_config = TelemetryConfig { rate_hz: 50 };
            inner.error = None;
            inner.protocol_errors = 0;
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
        let job = Arc::new(spawned.job);
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
            Arc::clone(&job),
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
                job,
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
    #[cfg(test)]
    pub fn latest_telemetry(&self) -> Option<RobotTelemetry> {
        self.core
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.latest_telemetry.clone())
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
                .map(|r| (Arc::clone(&r.child), Arc::clone(&r.job)))
        });
        if let Some((child, job)) = snapshot {
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
                let _ = job.terminate();
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
                let _ = runtime.job.terminate();
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
    let candidate = SIDECAR_RELATIVE_PATH
        .iter()
        .fold(root.clone(), |path, segment| path.join(segment));
    let path = fs::canonicalize(candidate).map_err(|_| {
        SimulationError::new(
            "SIDECAR_RESOURCE_MISSING",
            "The bundled simulation sidecar is unavailable.",
        )
    })?;
    if !path.starts_with(&root)
        || !path.is_file()
        || path.extension().and_then(|v| v.to_str()) != Some("exe")
    {
        return Err(SimulationError::new(
            "SIDECAR_RESOURCE_INVALID",
            "The bundled simulation sidecar is invalid.",
        ));
    }
    let required: &[&[&str]] = &[
        &["resources", "sidecar", "mujoco.dll"],
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
    job: Arc<JobObject>,
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
                        let _ = job.terminate();
                        break;
                    }
                    match parse_response_line(&buffer) {
                        Ok(message) => {
                            handle_message(&core, generation, message.request_id, message.response)
                        }
                        Err(error) => {
                            let should_terminate = record_protocol_error(&core, generation, error);
                            if should_terminate {
                                let _ = job.terminate();
                                break;
                            }
                        }
                    }
                }
                Err(_) => {
                    mark_crashed(&core, generation, "SIDECAR_READ_FAILED");
                    let _ = job.terminate();
                    break;
                }
            }
        }
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
                    inner.latest_motion_command = Some(telemetry.command.clone());
                    inner.latest_telemetry = Some(telemetry.as_ref().clone());
                    event = Some(SimulationEvent::Telemetry(telemetry.clone()));
                }
            }
            ProtocolResponse::MotionCommandChanged(command) => {
                inner.latest_motion_command = Some(command.clone());
                event = Some(SimulationEvent::MotionCommandChanged(command.clone()));
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
    inner.protocol_errors = inner.protocol_errors.saturating_add(1);
    inner.error = Some(error);
    if inner.protocol_errors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS {
        inner.state = LifecycleState::Failed;
        true
    } else {
        false
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
            inner.state = LifecycleState::Crashed;
            inner.simulation_state = SimulationState::Unloaded;
            inner.model = None;
            inner.latest_pose = None;
            inner.latest_telemetry = None;
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
        for sequence in 20..30 {
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
                super::super::protocol::ControllerAvailability::Go2ConvexMpcV1
            );
            thread::sleep(Duration::from_millis(60));
        }
        let gait = manager.get_latest_telemetry().unwrap();
        assert_eq!(gait.locomotion.controller_id, "go2-convex-mpc-v1");
        assert_eq!(
            gait.locomotion.availability,
            super::super::protocol::LocomotionAvailability::Available
        );
        assert!(matches!(
            gait.locomotion.state,
            super::super::protocol::LocomotionState::EnteringTrot
                | super::super::protocol::LocomotionState::Locomotion
        ));
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
}

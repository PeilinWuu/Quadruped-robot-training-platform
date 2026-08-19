use crate::simulation::process::{self, ProcessGuard};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, Weak},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RealRobotState {
    Unavailable,
    Starting,
    Ready,
    Running,
    Fault,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealRobotStatus {
    state: RealRobotState,
    available: bool,
    live: bool,
    control_enabled: bool,
    active_move: bool,
    gateway_version: Option<String>,
    last_action: Option<String>,
    robot_online: bool,
    telemetry_age_ms: Option<u64>,
    telemetry: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealMoveCommand {
    forward_velocity: f64,
    lateral_velocity: f64,
    yaw_rate: f64,
    duration_ms: u32,
}

fn validate_velocity(
    forward_velocity: f64,
    lateral_velocity: f64,
    yaw_rate: f64,
) -> Result<(), String> {
    for (name, value, limit) in [
        ("forwardVelocity", forward_velocity, 0.30),
        ("lateralVelocity", lateral_velocity, 0.30),
        ("yawRate", yaw_rate, 0.50),
    ] {
        if !value.is_finite() || value.abs() > limit {
            return Err(format!(
                "{name} exceeds the real-robot safety limit {limit}"
            ));
        }
    }
    Ok(())
}

impl RealMoveCommand {
    fn validate(&self) -> Result<(), String> {
        validate_velocity(self.forward_velocity, self.lateral_velocity, self.yaw_rate)?;
        if !(1..=3000).contains(&self.duration_ms) {
            return Err("durationMs must be between 1 and 3000".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealKeyboardMotionCommand {
    forward_velocity: f64,
    lateral_velocity: f64,
    yaw_rate: f64,
}

impl RealKeyboardMotionCommand {
    fn validate(&self) -> Result<(), String> {
        validate_velocity(self.forward_velocity, self.lateral_velocity, self.yaw_rate)
    }
}

struct Runtime {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    guard: Arc<ProcessGuard>,
    #[cfg(target_os = "linux")]
    _parent_keeper: process::ParentKeeper,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
}

struct Inner {
    generation: u64,
    state: RealRobotState,
    runtime: Option<Runtime>,
    live: bool,
    control_enabled: bool,
    active_move: bool,
    gateway_version: Option<String>,
    last_action: Option<String>,
    last_telemetry_at: Option<Instant>,
    telemetry: Option<Value>,
    error: Option<String>,
}

struct Core {
    inner: Mutex<Inner>,
    app: AppHandle,
}

#[derive(Clone)]
pub struct RealRobotManager {
    core: Arc<Core>,
}

impl RealRobotManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            core: Arc::new(Core {
                inner: Mutex::new(Inner {
                    generation: 0,
                    state: RealRobotState::Unavailable,
                    runtime: None,
                    live: false,
                    control_enabled: false,
                    active_move: false,
                    gateway_version: None,
                    last_action: None,
                    last_telemetry_at: None,
                    telemetry: None,
                    error: None,
                }),
                app,
            }),
        }
    }

    pub fn status(&self) -> RealRobotStatus {
        status_from_core(&self.core)
    }

    pub fn start_optional(&self) {
        #[cfg(target_os = "linux")]
        {
            let Some(path) = gateway_executable() else {
                self.set_unavailable("Go2 real-robot gateway is unavailable");
                return;
            };
            let live = env::var_os("QUADRUPED_GO2_GATEWAY_LIVE").is_some_and(|value| value == "1");
            if let Err(error) = self.start_path(&path, live) {
                self.set_unavailable(&error);
            }
        }
        #[cfg(not(target_os = "linux"))]
        self.set_unavailable("Go2 real-robot gateway is supported on Linux only");
    }

    #[cfg(target_os = "linux")]
    fn start_path(&self, path: &Path, live: bool) -> Result<(), String> {
        let generation = {
            let mut inner = self
                .core
                .inner
                .lock()
                .map_err(|_| "real gateway lock failed")?;
            inner.generation = inner.generation.wrapping_add(1);
            inner.state = RealRobotState::Starting;
            inner.live = live;
            inner.error = None;
            inner.generation
        };
        let mut command = Command::new(path);
        if live {
            command.arg("--live").env("GO2_REAL_GATEWAY_LIVE", "1");
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let spawned = process::spawn_guarded(command).map_err(|error| error.code)?;
        let child = Arc::new(Mutex::new(spawned.child));
        let (stdin, stdout, stderr) = {
            let mut child_lock = child.lock().map_err(|_| "real gateway child lock failed")?;
            (
                child_lock
                    .stdin
                    .take()
                    .ok_or("real gateway stdin unavailable")?,
                child_lock
                    .stdout
                    .take()
                    .ok_or("real gateway stdout unavailable")?,
                child_lock
                    .stderr
                    .take()
                    .ok_or("real gateway stderr unavailable")?,
            )
        };
        let stdin = Arc::new(Mutex::new(stdin));
        let guard = Arc::new(spawned.guard);
        let stdout_thread = spawn_stdout_reader(
            Arc::downgrade(&self.core),
            generation,
            stdout,
            Arc::clone(&guard),
        );
        let stderr_thread = spawn_stderr_reader(Arc::downgrade(&self.core), generation, stderr);
        self.core
            .inner
            .lock()
            .map_err(|_| "real gateway lock failed")?
            .runtime = Some(Runtime {
            child,
            stdin,
            guard,
            _parent_keeper: spawned.parent_keeper,
            stdout_thread: Some(stdout_thread),
            stderr_thread: Some(stderr_thread),
        });
        self.send("configure", json!({"controlEnabled":false}))?;
        emit_status(&self.core);
        Ok(())
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<RealRobotStatus, String> {
        if enabled {
            self.require_live_ready()?;
        }
        self.send("control_enable", json!({"enabled":enabled}))?;
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.control_enabled = enabled;
            inner.active_move = false;
            inner.state = if enabled {
                RealRobotState::Running
            } else {
                RealRobotState::Ready
            };
        }
        emit_status(&self.core);
        Ok(self.status())
    }

    pub fn move_once(&self, command: RealMoveCommand) -> Result<RealRobotStatus, String> {
        command.validate()?;
        self.require_enabled()?;
        self.send(
            "move_once",
            json!({
                "forwardVelocity": command.forward_velocity,
                "lateralVelocity": command.lateral_velocity,
                "yawRate": command.yaw_rate,
                "durationMs": command.duration_ms,
            }),
        )?;
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.active_move = true;
            inner.last_action = Some("move_started".into());
        }
        emit_status(&self.core);
        Ok(self.status())
    }

    pub fn keyboard_motion(
        &self,
        command: RealKeyboardMotionCommand,
    ) -> Result<RealRobotStatus, String> {
        command.validate()?;
        if command.forward_velocity == 0.0
            && command.lateral_velocity == 0.0
            && command.yaw_rate == 0.0
        {
            return Err("zero keyboard motion must use StopMove".into());
        }
        self.require_enabled()?;
        self.send(
            "keyboard_motion",
            json!({
                "forwardVelocity": command.forward_velocity,
                "lateralVelocity": command.lateral_velocity,
                "yawRate": command.yaw_rate,
            }),
        )?;
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.active_move = true;
            inner.last_action = Some("keyboard_move_started".into());
        }
        emit_status(&self.core);
        Ok(self.status())
    }

    pub fn stop(&self) -> Result<RealRobotStatus, String> {
        self.require_runtime()?;
        self.send("stop", json!({}))?;
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.active_move = false;
            inner.last_action = Some("stopped".into());
        }
        emit_status(&self.core);
        Ok(self.status())
    }

    pub fn simple_action(&self, action: &str) -> Result<RealRobotStatus, String> {
        self.require_enabled()?;
        if !matches!(action, "stand_up" | "stand_down") {
            return Err("unsupported real-robot action".into());
        }
        self.send(action, json!({}))?;
        Ok(self.status())
    }

    pub fn lidar(&self, enabled: bool) -> Result<RealRobotStatus, String> {
        self.require_live_ready()?;
        if self
            .core
            .inner
            .lock()
            .map_err(|_| "real gateway lock failed")?
            .active_move
        {
            return Err("LiDAR switching is blocked while a real move is active".into());
        }
        self.send("lidar", json!({"enabled":enabled}))?;
        Ok(self.status())
    }

    fn require_runtime(&self) -> Result<(), String> {
        let inner = self
            .core
            .inner
            .lock()
            .map_err(|_| "real gateway lock failed")?;
        if inner.runtime.is_none()
            || matches!(
                inner.state,
                RealRobotState::Unavailable | RealRobotState::Fault
            )
        {
            return Err("Go2 real-robot gateway is unavailable".into());
        }
        Ok(())
    }

    fn require_live_ready(&self) -> Result<(), String> {
        self.require_runtime()?;
        let inner = self
            .core
            .inner
            .lock()
            .map_err(|_| "real gateway lock failed")?;
        if !inner.live {
            return Err(
                "Go2 gateway is in dry-run mode; restart with QUADRUPED_GO2_GATEWAY_LIVE=1".into(),
            );
        }
        if !inner
            .last_telemetry_at
            .is_some_and(|time| time.elapsed() <= Duration::from_secs(2))
        {
            return Err(
                "Go2 telemetry is unavailable or stale; real control remains locked".into(),
            );
        }
        Ok(())
    }

    fn require_enabled(&self) -> Result<(), String> {
        self.require_live_ready()?;
        if !self
            .core
            .inner
            .lock()
            .map_err(|_| "real gateway lock failed")?
            .control_enabled
        {
            return Err("Go2 real-robot control is disabled".into());
        }
        Ok(())
    }

    fn send(&self, kind: &str, payload: Value) -> Result<(), String> {
        let stdin = self
            .core
            .inner
            .lock()
            .map_err(|_| "real gateway lock failed")?
            .runtime
            .as_ref()
            .map(|runtime| Arc::clone(&runtime.stdin))
            .ok_or_else(|| "Go2 real-robot gateway is unavailable".to_owned())?;
        let mut frame =
            serde_json::to_vec(&json!({"protocolVersion":1,"type":kind,"payload":payload}))
                .map_err(|_| "real gateway command serialization failed".to_owned())?;
        if frame.len() > MAX_FRAME_BYTES {
            return Err("real gateway command is too large".into());
        }
        frame.push(b'\n');
        let mut writer = stdin.lock().map_err(|_| "real gateway stdin lock failed")?;
        writer
            .write_all(&frame)
            .and_then(|_| writer.flush())
            .map_err(|_| "real gateway write failed".into())
    }

    fn set_unavailable(&self, error: &str) {
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.state = RealRobotState::Unavailable;
            inner.error = Some(error.into());
        }
        emit_status(&self.core);
    }

    pub fn shutdown_for_exit(&self) {
        let _ = self.send("control_enable", json!({"enabled":false}));
        let _ = self.send("stop", json!({}));
        let _ = self.send("shutdown", json!({}));
        let runtime = self
            .core
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.runtime.take());
        let Some(mut runtime) = runtime else { return };
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if runtime
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten())
                .is_some()
            {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = runtime.guard.terminate();
        if let Ok(mut child) = runtime.child.lock() {
            let _ = child.wait();
        }
        if let Some(handle) = runtime.stdout_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = runtime.stderr_thread.take() {
            let _ = handle.join();
        }
    }
}

fn gateway_executable() -> Option<PathBuf> {
    let default_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/go2_real_gateway/go2_real_gateway.py");
    let path = env::var_os("QUADRUPED_GO2_GATEWAY_PATH")
        .map(PathBuf::from)
        .unwrap_or(default_path);
    path.is_file().then_some(path)
}

fn spawn_stdout_reader(
    core: Weak<Core>,
    generation: u64,
    stdout: impl Read + Send + 'static,
    guard: Arc<ProcessGuard>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("go2-real-gateway-stdout".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > MAX_FRAME_BYTES {
                    mark_fault(&core, generation, "real gateway output frame is too large");
                    let _ = guard.terminate();
                    return;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => handle_frame(&core, generation, value),
                    Err(_) => {
                        mark_fault(&core, generation, "invalid real gateway output");
                        let _ = guard.terminate();
                        return;
                    }
                }
            }
            if let Some(core) = core.upgrade() {
                if core
                    .inner
                    .lock()
                    .is_ok_and(|inner| inner.generation == generation && inner.runtime.is_some())
                {
                    mark_fault(&Arc::downgrade(&core), generation, "real gateway exited");
                }
            }
        })
        .expect("real gateway stdout thread must start")
}

fn spawn_stderr_reader(
    core: Weak<Core>,
    generation: u64,
    stderr: impl Read + Send + 'static,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("go2-real-gateway-stderr".into())
        .spawn(move || {
            let mut last = None;
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    last = Some(line);
                }
            }
            if let (Some(core), Some(error)) = (core.upgrade(), last) {
                if let Ok(mut inner) = core.inner.lock() {
                    if inner.generation == generation {
                        inner.error = Some(error);
                    }
                }
                emit_status(&core);
            }
        })
        .expect("real gateway stderr thread must start")
}

fn handle_frame(core: &Weak<Core>, generation: u64, value: Value) {
    let Some(core) = core.upgrade() else { return };
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        mark_fault(
            &Arc::downgrade(&core),
            generation,
            "unsupported real gateway protocol",
        );
        return;
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let payload = value.get("payload").and_then(Value::as_object);
    let Ok(mut inner) = core.inner.lock() else {
        return;
    };
    if inner.generation != generation {
        return;
    }
    match kind {
        "ready" => {
            inner.gateway_version = payload
                .and_then(|p| p.get("bridgeVersion"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let reported_live = payload
                .and_then(|p| p.get("live"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if reported_live != inner.live {
                inner.state = RealRobotState::Fault;
                inner.error = Some("real gateway live-mode mismatch".into());
            } else {
                inner.state = RealRobotState::Ready;
                inner.error = None;
            }
        }
        "status" => {
            inner.control_enabled = payload
                .and_then(|p| p.get("controlEnabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            inner.active_move = payload
                .and_then(|p| p.get("activeMove"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            inner.state = if inner.control_enabled {
                RealRobotState::Running
            } else {
                RealRobotState::Ready
            };
        }
        "action" => {
            if let Some(action) = payload
                .and_then(|p| p.get("action"))
                .and_then(Value::as_str)
            {
                inner.last_action = Some(action.to_owned());
                inner.active_move = matches!(action, "move_started" | "keyboard_move_started");
            }
        }
        "telemetry" => {
            let Some(payload) = payload else {
                inner.state = RealRobotState::Fault;
                inner.error = Some("invalid real gateway telemetry".into());
                drop(inner);
                emit_status(&core);
                return;
            };
            inner.last_telemetry_at = Some(Instant::now());
            inner.telemetry = Some(Value::Object(payload.clone()));
        }
        "protocol_error" => {
            inner.error = payload
                .and_then(|p| p.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        _ => {
            inner.state = RealRobotState::Fault;
            inner.error = Some("unknown real gateway frame".into());
        }
    }
    drop(inner);
    emit_status(&core);
}

fn mark_fault(core: &Weak<Core>, generation: u64, error: &str) {
    let Some(core) = core.upgrade() else { return };
    if let Ok(mut inner) = core.inner.lock() {
        if inner.generation != generation {
            return;
        }
        inner.state = RealRobotState::Fault;
        inner.control_enabled = false;
        inner.active_move = false;
        inner.error = Some(error.into());
    }
    emit_status(&core);
}

fn status_from_core(core: &Arc<Core>) -> RealRobotStatus {
    let inner = core
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let telemetry_age_ms = inner
        .last_telemetry_at
        .map(|time| time.elapsed().as_millis() as u64);
    RealRobotStatus {
        state: inner.state,
        available: matches!(inner.state, RealRobotState::Ready | RealRobotState::Running),
        live: inner.live,
        control_enabled: inner.control_enabled,
        active_move: inner.active_move,
        gateway_version: inner.gateway_version.clone(),
        last_action: inner.last_action.clone(),
        robot_online: telemetry_age_ms.is_some_and(|age| age <= 2000),
        telemetry_age_ms,
        telemetry: inner.telemetry.clone(),
        error: inner.error.clone(),
    }
}

fn emit_status(core: &Arc<Core>) {
    let _ = core
        .app
        .emit("real-robot-status-changed", status_from_core(core));
}

#[tauri::command]
pub fn real_robot_status(manager: State<'_, RealRobotManager>) -> RealRobotStatus {
    manager.status()
}
#[tauri::command]
pub fn real_robot_set_enabled(
    enabled: bool,
    manager: State<'_, RealRobotManager>,
) -> Result<RealRobotStatus, String> {
    manager.set_enabled(enabled)
}
#[tauri::command]
pub fn real_robot_move_once(
    command: RealMoveCommand,
    manager: State<'_, RealRobotManager>,
) -> Result<RealRobotStatus, String> {
    manager.move_once(command)
}
#[tauri::command]
pub fn real_robot_keyboard_motion(
    command: RealKeyboardMotionCommand,
    manager: State<'_, RealRobotManager>,
) -> Result<RealRobotStatus, String> {
    manager.keyboard_motion(command)
}
#[tauri::command]
pub fn real_robot_stop(manager: State<'_, RealRobotManager>) -> Result<RealRobotStatus, String> {
    manager.stop()
}
#[tauri::command]
pub fn real_robot_stand_up(
    manager: State<'_, RealRobotManager>,
) -> Result<RealRobotStatus, String> {
    manager.simple_action("stand_up")
}
#[tauri::command]
pub fn real_robot_stand_down(
    manager: State<'_, RealRobotManager>,
) -> Result<RealRobotStatus, String> {
    manager.simple_action("stand_down")
}
#[tauri::command]
pub fn real_robot_lidar(
    enabled: bool,
    manager: State<'_, RealRobotManager>,
) -> Result<RealRobotStatus, String> {
    manager.lidar(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn move_limits_are_fail_closed() {
        let valid = RealMoveCommand {
            forward_velocity: 0.05,
            lateral_velocity: 0.0,
            yaw_rate: 0.1,
            duration_ms: 500,
        };
        assert!(valid.validate().is_ok());
        assert!(RealMoveCommand {
            forward_velocity: 0.31,
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(RealMoveCommand {
            duration_ms: 3001,
            ..valid
        }
        .validate()
        .is_err());

        let keyboard = RealKeyboardMotionCommand {
            forward_velocity: 0.05,
            lateral_velocity: 0.0,
            yaw_rate: -0.1,
        };
        assert!(keyboard.validate().is_ok());
        assert!(RealKeyboardMotionCommand {
            yaw_rate: 0.51,
            ..keyboard
        }
        .validate()
        .is_err());
    }
}

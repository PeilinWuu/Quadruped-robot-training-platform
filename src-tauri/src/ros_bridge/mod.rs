mod protocol;

use crate::{
    input::NativeKeyboardController,
    simulation::{
        process::{self, ProcessGuard},
        ControlSource, SimulationManager,
    },
};
use protocol::{
    configure_frame, control_frame, parse_bridge_frame, shutdown_frame, telemetry_frame,
    BridgeMessage, MAX_FRAME_BYTES,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

const TELEMETRY_INTERVAL: Duration = Duration::from_millis(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_MAX_LINES: usize = 50;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BridgeState {
    Unavailable,
    Ready,
    Running,
    Fault,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RosBridgeStatus {
    pub state: BridgeState,
    pub available: bool,
    pub control_source: ControlSource,
    pub bridge_version: Option<String>,
    pub last_cmd_vel_age_ms: Option<u64>,
    pub watchdog_state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransitionStep {
    DisarmKeyboard,
    ClearMotion,
    SetSource(ControlSource),
    SetBridgeEnabled(bool),
}

fn transition_steps(source: ControlSource) -> &'static [TransitionStep] {
    const TO_ROS: &[TransitionStep] = &[
        TransitionStep::DisarmKeyboard,
        TransitionStep::ClearMotion,
        TransitionStep::SetSource(ControlSource::Ros),
        TransitionStep::SetBridgeEnabled(true),
    ];
    const TO_MANUAL: &[TransitionStep] = &[
        TransitionStep::SetBridgeEnabled(false),
        TransitionStep::ClearMotion,
        TransitionStep::SetSource(ControlSource::Manual),
        TransitionStep::DisarmKeyboard,
    ];
    match source {
        ControlSource::Manual => TO_MANUAL,
        ControlSource::Ros => TO_ROS,
    }
}

struct BridgeRuntime {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    guard: Arc<ProcessGuard>,
    #[cfg(target_os = "linux")]
    _parent_keeper: process::ParentKeeper,
    stop: Arc<AtomicBool>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    telemetry_thread: Option<JoinHandle<()>>,
}

struct BridgeInner {
    generation: u64,
    state: BridgeState,
    runtime: Option<BridgeRuntime>,
    bridge_version: Option<String>,
    last_cmd_vel_age_ms: Option<u64>,
    watchdog_state: String,
    error: Option<String>,
    stderr_lines: VecDeque<String>,
}

struct BridgeCore {
    inner: Mutex<BridgeInner>,
    simulation: SimulationManager,
    keyboard: NativeKeyboardController,
    app: AppHandle,
}

#[derive(Clone)]
pub struct RosBridgeManager {
    core: Arc<BridgeCore>,
}

impl RosBridgeManager {
    pub fn new(
        simulation: SimulationManager,
        keyboard: NativeKeyboardController,
        app: AppHandle,
    ) -> Self {
        Self {
            core: Arc::new(BridgeCore {
                inner: Mutex::new(BridgeInner {
                    generation: 0,
                    state: BridgeState::Unavailable,
                    runtime: None,
                    bridge_version: None,
                    last_cmd_vel_age_ms: None,
                    watchdog_state: "idle".into(),
                    error: None,
                    stderr_lines: VecDeque::new(),
                }),
                simulation,
                keyboard,
                app,
            }),
        }
    }

    pub fn status(&self) -> RosBridgeStatus {
        status_from_core(&self.core)
    }

    pub fn start_optional(&self) {
        #[cfg(target_os = "linux")]
        {
            let Some(path) = bridge_executable() else {
                self.set_unavailable("ROS bridge executable is unavailable");
                return;
            };
            if let Err(error) = self.start_path(&path) {
                self.set_unavailable(&error);
            }
        }
        #[cfg(not(target_os = "linux"))]
        self.set_unavailable("ROS 2 bridge is supported on Linux only");
    }

    #[cfg(target_os = "linux")]
    fn start_path(&self, path: &Path) -> Result<(), String> {
        let generation = {
            let mut inner = self.core.inner.lock().map_err(|_| "bridge lock failed")?;
            if inner.runtime.is_some() {
                return Ok(());
            }
            inner.generation = inner.generation.wrapping_add(1);
            inner.state = BridgeState::Unavailable;
            inner.error = None;
            inner.generation
        };
        let mut command = Command::new(path);
        configure_ros_environment(&mut command, path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let spawned = process::spawn_guarded(command).map_err(|error| error.code)?;
        let child = Arc::new(Mutex::new(spawned.child));
        let (stdin, stdout, stderr) = {
            let mut child_lock = child.lock().map_err(|_| "bridge child lock failed")?;
            (
                child_lock.stdin.take().ok_or("bridge stdin unavailable")?,
                child_lock
                    .stdout
                    .take()
                    .ok_or("bridge stdout unavailable")?,
                child_lock
                    .stderr
                    .take()
                    .ok_or("bridge stderr unavailable")?,
            )
        };
        let stdin = Arc::new(Mutex::new(stdin));
        let guard = Arc::new(spawned.guard);
        let stop = Arc::new(AtomicBool::new(false));
        let stdout_thread = spawn_stdout_reader(
            Arc::downgrade(&self.core),
            generation,
            stdout,
            Arc::clone(&guard),
        );
        let stderr_thread = spawn_stderr_reader(Arc::downgrade(&self.core), generation, stderr);
        let telemetry_thread = spawn_telemetry_writer(
            Arc::downgrade(&self.core),
            generation,
            Arc::clone(&stdin),
            Arc::clone(&stop),
        );
        {
            let mut inner = self.core.inner.lock().map_err(|_| "bridge lock failed")?;
            inner.runtime = Some(BridgeRuntime {
                child,
                stdin,
                guard,
                _parent_keeper: spawned.parent_keeper,
                stop,
                stdout_thread: Some(stdout_thread),
                stderr_thread: Some(stderr_thread),
                telemetry_thread: Some(telemetry_thread),
            });
        }
        if let Err(error) = self.send(&configure_frame(false)?) {
            self.shutdown_for_exit();
            return Err(error);
        }
        Ok(())
    }

    pub fn set_control_source(&self, source: ControlSource) -> Result<RosBridgeStatus, String> {
        if source == ControlSource::Ros {
            let available = {
                let inner = self.core.inner.lock().map_err(|_| "bridge lock failed")?;
                inner.runtime.is_some()
                    && matches!(inner.state, BridgeState::Ready | BridgeState::Running)
            };
            if !available {
                return Err("ROS bridge is unavailable".into());
            }
        }
        for step in transition_steps(source) {
            match *step {
                TransitionStep::DisarmKeyboard => {
                    self.core.keyboard.disarm();
                }
                TransitionStep::ClearMotion => {
                    let _ = self.core.simulation.clear_motion_command();
                }
                TransitionStep::SetSource(value) => {
                    self.core.simulation.set_control_source(value);
                }
                TransitionStep::SetBridgeEnabled(enabled) => {
                    let result = control_frame(enabled).and_then(|frame| self.send(&frame));
                    if let Err(error) = result {
                        if source == ControlSource::Ros {
                            let _ = self.core.simulation.clear_motion_command();
                            self.mark_fault(&error);
                            return Err(error);
                        }
                    }
                }
            }
        }
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.state = match source {
                ControlSource::Ros => BridgeState::Running,
                ControlSource::Manual if inner.state == BridgeState::Fault => BridgeState::Fault,
                ControlSource::Manual if inner.runtime.is_some() => BridgeState::Ready,
                ControlSource::Manual => BridgeState::Unavailable,
            };
            inner.last_cmd_vel_age_ms = None;
            inner.watchdog_state = "idle".into();
        }
        emit_status(&self.core);
        Ok(self.status())
    }

    pub fn shutdown_for_exit(&self) {
        self.core.keyboard.disarm();
        let _ = self.core.simulation.clear_motion_command();
        self.core
            .simulation
            .set_control_source(ControlSource::Manual);
        let runtime = self
            .core
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.runtime.take());
        let Some(mut runtime) = runtime else { return };
        runtime.stop.store(true, Ordering::Release);
        if let Ok(frame) = shutdown_frame() {
            let _ = write_bytes(&runtime.stdin, &frame);
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            let exited = runtime
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten())
                .is_some();
            if exited {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = runtime.guard.terminate();
        if let Ok(mut child) = runtime.child.lock() {
            let _ = child.wait();
        }
        for handle in [
            runtime.stdout_thread.take(),
            runtime.stderr_thread.take(),
            runtime.telemetry_thread.take(),
        ]
        .into_iter()
        .flatten()
        {
            let _ = handle.join();
        }
    }

    fn send(&self, frame: &[u8]) -> Result<(), String> {
        let stdin = self
            .core
            .inner
            .lock()
            .map_err(|_| "bridge lock failed")?
            .runtime
            .as_ref()
            .map(|runtime| Arc::clone(&runtime.stdin))
            .ok_or_else(|| "ROS bridge is unavailable".to_owned())?;
        write_bytes(&stdin, frame)
    }

    fn set_unavailable(&self, error: &str) {
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.state = BridgeState::Unavailable;
            inner.error = Some(error.to_owned());
        }
        emit_status(&self.core);
    }

    fn mark_fault(&self, error: &str) {
        mark_fault(&self.core, None, error);
    }
}

fn bridge_executable() -> Option<PathBuf> {
    let default_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../ros2_ws/install/quadruped_ros_bridge/lib/quadruped_ros_bridge/quadruped_ros_bridge",
    );
    resolve_bridge_executable(
        env::var_os("QUADRUPED_ROS_BRIDGE_PATH").map(PathBuf::from),
        default_path,
    )
}

fn resolve_bridge_executable(
    override_path: Option<PathBuf>,
    default_path: PathBuf,
) -> Option<PathBuf> {
    match override_path {
        Some(path) => path.is_file().then_some(path),
        None => default_path.is_file().then_some(default_path),
    }
}

#[cfg(target_os = "linux")]
fn configure_ros_environment(command: &mut Command, executable: &Path) {
    let install_prefix = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("/opt/ros/humble"));
    let append = |prefix: &str, current: Option<std::ffi::OsString>| {
        current.map_or_else(
            || prefix.to_owned(),
            |value| format!("{prefix}:{}", value.to_string_lossy()),
        )
    };
    command
        .env("RMW_IMPLEMENTATION", "rmw_cyclonedds_cpp")
        .env("ROS_LOCALHOST_ONLY", "1")
        .env("ROS_DISTRO", "humble")
        .env("ROS_VERSION", "2")
        .env(
            "AMENT_PREFIX_PATH",
            format!("{}:/opt/ros/humble", install_prefix.display()),
        )
        .env(
            "LD_LIBRARY_PATH",
            append(
                "/opt/ros/humble/lib:/opt/ros/humble/lib/x86_64-linux-gnu",
                env::var_os("LD_LIBRARY_PATH"),
            ),
        )
        .env("PATH", append("/opt/ros/humble/bin", env::var_os("PATH")));
}

fn write_bytes(stdin: &Arc<Mutex<ChildStdin>>, frame: &[u8]) -> Result<(), String> {
    let mut writer = stdin
        .lock()
        .map_err(|_| "ROS bridge stdin lock failed".to_owned())?;
    writer
        .write_all(frame)
        .and_then(|_| writer.flush())
        .map_err(|_| "ROS bridge write failed".to_owned())
}

fn spawn_stdout_reader(
    core: Weak<BridgeCore>,
    generation: u64,
    stdout: impl Read + Send + 'static,
    guard: Arc<ProcessGuard>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("ros-bridge-stdout".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader
                    .by_ref()
                    .take((MAX_FRAME_BYTES + 2) as u64)
                    .read_until(b'\n', &mut buffer)
                {
                    Ok(0) => {
                        if let Some(core) = core.upgrade() {
                            mark_fault(&core, Some(generation), "ROS bridge exited");
                        }
                        break;
                    }
                    Ok(_) => {
                        while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                            buffer.pop();
                        }
                        if buffer.len() > MAX_FRAME_BYTES {
                            let _ = guard.terminate();
                            if let Some(core) = core.upgrade() {
                                mark_fault(
                                    &core,
                                    Some(generation),
                                    "ROS bridge frame is oversized",
                                );
                            }
                            break;
                        }
                        match parse_bridge_frame(&buffer) {
                            Ok(message) => {
                                if let Some(core) = core.upgrade() {
                                    handle_message(&core, generation, message);
                                }
                            }
                            Err(error) => {
                                let _ = guard.terminate();
                                if let Some(core) = core.upgrade() {
                                    mark_fault(&core, Some(generation), &error);
                                }
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        let _ = guard.terminate();
                        if let Some(core) = core.upgrade() {
                            mark_fault(&core, Some(generation), "ROS bridge stdout read failed");
                        }
                        break;
                    }
                }
            }
        })
        .expect("ROS bridge stdout thread must start")
}

fn spawn_stderr_reader(
    core: Weak<BridgeCore>,
    generation: u64,
    stderr: impl Read + Send + 'static,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("ros-bridge-stderr".into())
        .spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let Some(core) = core.upgrade() else { break };
                if diagnostic_enabled() && line.starts_with("D6_ROS_PERF_DIAGNOSTIC") {
                    eprintln!("{line}");
                }
                let Ok(mut inner) = core.inner.lock() else {
                    break;
                };
                if inner.generation != generation {
                    break;
                }
                if inner.stderr_lines.len() == STDERR_MAX_LINES {
                    inner.stderr_lines.pop_front();
                }
                inner
                    .stderr_lines
                    .push_back(line.chars().take(512).collect());
            }
        })
        .expect("ROS bridge stderr thread must start")
}

fn spawn_telemetry_writer(
    core: Weak<BridgeCore>,
    generation: u64,
    stdin: Arc<Mutex<ChildStdin>>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("ros-bridge-telemetry".into())
        .spawn(move || {
            let mut last_sequence = None;
            // D6_ROS_PERF_DIAGNOSTIC: bounded, default-off, 1 Hz telemetry-pipe counters.
            let diagnostic = diagnostic_enabled();
            let disable_forward = diagnostic
                && env::var_os("D6_ROS_PERF_DIAGNOSTIC_DISABLE_FORWARD").is_some();
            let diagnostic_started = Instant::now();
            let mut diagnostic_last = diagnostic_started;
            let mut produced_total = 0_u64;
            let mut forwarded_total = 0_u64;
            let mut dropped_total = 0_u64;
            let mut write_attempts = 0_u64;
            let mut write_completed = 0_u64;
            let mut bytes_total = 0_u64;
            let mut interval_produced = 0_u64;
            let mut interval_forwarded = 0_u64;
            let mut interval_bytes = 0_u64;
            let mut write_latencies_us = Vec::with_capacity(64);
            let mut write_latency_total_us = 0_u64;
            let mut write_latency_max_us = 0_u64;
            let mut physics_hz = 0.0;
            let mut real_time_factor = 0.0;
            let mut animation_hz = 0.0;
            while !stop.load(Ordering::Acquire) {
                let Some(core) = core.upgrade() else { break };
                let current_generation = core.inner.lock().ok().map(|inner| inner.generation);
                if current_generation != Some(generation) {
                    break;
                }
                if let Some(telemetry) = core.simulation.latest_telemetry() {
                    physics_hz = telemetry.performance.physics_frequency_hz;
                    real_time_factor = telemetry.performance.real_time_factor;
                    animation_hz = telemetry.locomotion.gait_frequency_hz;
                    if last_sequence != Some(telemetry.sequence) {
                        let sequence_delta = last_sequence.map_or(1_u64, |previous| {
                            u64::from(telemetry.sequence.wrapping_sub(previous)).max(1)
                        });
                        produced_total = produced_total.saturating_add(sequence_delta);
                        interval_produced = interval_produced.saturating_add(sequence_delta);
                        dropped_total = dropped_total.saturating_add(sequence_delta.saturating_sub(1));
                        if !disable_forward {
                            let frame = match telemetry_frame(&telemetry) {
                                Ok(frame) => frame,
                                Err(_) => {
                                    mark_fault(&core, Some(generation), "ROS telemetry forwarding failed");
                                    break;
                                }
                            };
                            write_attempts = write_attempts.saturating_add(1);
                            let write_started = Instant::now();
                            let result = write_bytes(&stdin, &frame);
                            let latency_us = write_started.elapsed().as_micros() as u64;
                            write_latencies_us.push(latency_us);
                            write_latency_total_us = write_latency_total_us.saturating_add(latency_us);
                            write_latency_max_us = write_latency_max_us.max(latency_us);
                            if result.is_err() {
                                mark_fault(&core, Some(generation), "ROS telemetry forwarding failed");
                                break;
                            }
                            write_completed = write_completed.saturating_add(1);
                            forwarded_total = forwarded_total.saturating_add(1);
                            interval_forwarded = interval_forwarded.saturating_add(1);
                            bytes_total = bytes_total.saturating_add(frame.len() as u64);
                            interval_bytes = interval_bytes.saturating_add(frame.len() as u64);
                        }
                        last_sequence = Some(telemetry.sequence);
                    }
                }
                if diagnostic && diagnostic_last.elapsed() >= Duration::from_secs(1) {
                    write_latencies_us.sort_unstable();
                    let p95_index = write_latencies_us
                        .len()
                        .saturating_mul(95)
                        .saturating_add(99)
                        / 100;
                    let p95_index = p95_index.saturating_sub(1);
                    let interval_write_mean_us = if write_latencies_us.is_empty() {
                        0
                    } else {
                        write_latencies_us.iter().sum::<u64>() / write_latencies_us.len() as u64
                    };
                    let interval_write_p95_us = write_latencies_us.get(p95_index).copied().unwrap_or(0);
                    let elapsed = diagnostic_last.elapsed().as_secs_f64();
                    eprintln!(
                        "D6_ROS_PERF_DIAGNOSTIC component=rust time_s={:.3} source_hz={:.2} forward_hz={:.2} produced_total={} forwarded_total={} dropped_total={} queue_current={} queue_max=1 enqueue_count={} dequeue_count={} drop_count={} write_attempts={} write_completed={} write_inflight=0 write_max_inflight=1 write_latency_interval_mean_us={} write_latency_interval_p95_us={} write_latency_total_mean_us={} write_latency_max_us={} bytes_per_sec={:.0} bytes_total={} latest_produced_sequence={} latest_forwarded_sequence={} forwarding_disabled={} physics_hz={:.3} rtf={:.3} animation_hz={:.2}",
                        diagnostic_started.elapsed().as_secs_f64(),
                        interval_produced as f64 / elapsed,
                        interval_forwarded as f64 / elapsed,
                        produced_total,
                        forwarded_total,
                        dropped_total,
                        0,
                        produced_total,
                        forwarded_total,
                        dropped_total,
                        write_attempts,
                        write_completed,
                        interval_write_mean_us,
                        interval_write_p95_us,
                        write_latency_total_us.checked_div(write_completed).unwrap_or(0),
                        write_latency_max_us,
                        interval_bytes as f64 / elapsed,
                        bytes_total,
                        last_sequence.unwrap_or(0),
                        if disable_forward { 0 } else { last_sequence.unwrap_or(0) },
                        disable_forward,
                        physics_hz,
                        real_time_factor,
                        animation_hz,
                    );
                    interval_produced = 0;
                    interval_forwarded = 0;
                    interval_bytes = 0;
                    write_latencies_us.clear();
                    diagnostic_last = Instant::now();
                }
                thread::sleep(TELEMETRY_INTERVAL);
            }
        })
        .expect("ROS bridge telemetry thread must start")
}

fn diagnostic_enabled() -> bool {
    env::var_os("D6_ROS_PERF_DIAGNOSTIC").is_some_and(|value| value == "1")
}

fn handle_message(core: &Arc<BridgeCore>, generation: u64, message: BridgeMessage) {
    if core
        .inner
        .lock()
        .map_or(true, |inner| inner.generation != generation)
    {
        return;
    }
    match message {
        BridgeMessage::Ready {
            bridge_version,
            watchdog_ms: _,
        } => {
            if let Ok(mut inner) = core.inner.lock() {
                inner.bridge_version = Some(bridge_version);
                inner.state = if core.simulation.control_source() == ControlSource::Ros {
                    BridgeState::Running
                } else {
                    BridgeState::Ready
                };
                inner.error = None;
            }
            emit_status(core);
        }
        BridgeMessage::CmdVel(command) => {
            if core.simulation.control_source() == ControlSource::Ros {
                let _ = core.simulation.set_ros_motion_command(command);
            }
        }
        BridgeMessage::WatchdogZero {
            last_cmd_vel_age_ms,
        } => {
            if core.simulation.control_source() == ControlSource::Ros {
                let _ = core.simulation.clear_motion_command();
            }
            if let Ok(mut inner) = core.inner.lock() {
                inner.last_cmd_vel_age_ms = last_cmd_vel_age_ms;
                inner.watchdog_state = if last_cmd_vel_age_ms.is_some() {
                    "triggered".into()
                } else {
                    "idle".into()
                };
            }
            emit_status(core);
        }
        BridgeMessage::Status {
            control_enabled,
            last_cmd_vel_age_ms,
            watchdog_state,
        } => {
            if let Ok(mut inner) = core.inner.lock() {
                inner.last_cmd_vel_age_ms = last_cmd_vel_age_ms;
                inner.watchdog_state = watchdog_state;
                inner.state = if control_enabled {
                    BridgeState::Running
                } else {
                    BridgeState::Ready
                };
            }
            emit_status(core);
        }
        BridgeMessage::ProtocolError {
            code,
            message,
            recoverable,
        } => {
            let error = format!("{code}: {message}");
            if recoverable {
                if let Ok(mut inner) = core.inner.lock() {
                    inner.error = Some(error);
                }
                emit_status(core);
            } else {
                mark_fault(core, Some(generation), &error);
            }
        }
    }
}

fn mark_fault(core: &Arc<BridgeCore>, generation: Option<u64>, error: &str) {
    let active = {
        let Ok(mut inner) = core.inner.lock() else {
            return;
        };
        if generation.is_some_and(|value| value != inner.generation) {
            return;
        }
        if let Some(runtime) = inner.runtime.as_ref() {
            runtime.stop.store(true, Ordering::Release);
        }
        inner.state = BridgeState::Fault;
        inner.error = Some(error.to_owned());
        core.simulation.control_source() == ControlSource::Ros
    };
    if active {
        let _ = core.simulation.clear_motion_command();
    }
    emit_status(core);
}

fn status_from_core(core: &Arc<BridgeCore>) -> RosBridgeStatus {
    let inner = core
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    RosBridgeStatus {
        state: inner.state,
        available: matches!(inner.state, BridgeState::Ready | BridgeState::Running),
        control_source: core.simulation.control_source(),
        bridge_version: inner.bridge_version.clone(),
        last_cmd_vel_age_ms: inner.last_cmd_vel_age_ms,
        watchdog_state: inner.watchdog_state.clone(),
        error: inner.error.clone(),
    }
}

fn emit_status(core: &Arc<BridgeCore>) {
    let _ = core
        .app
        .emit("ros-bridge-status-changed", status_from_core(core));
}

#[tauri::command]
pub fn ros_bridge_status(manager: State<'_, RosBridgeManager>) -> RosBridgeStatus {
    manager.status()
}

#[tauri::command]
pub fn ros_bridge_set_control_source(
    source: ControlSource,
    manager: State<'_, RosBridgeManager>,
) -> Result<RosBridgeStatus, String> {
    manager.set_control_source(source)
}

#[cfg(test)]
mod tests {
    use super::{
        protocol::{parse_bridge_frame, shutdown_frame, BridgeMessage, MAX_FRAME_BYTES},
        *,
    };
    use crate::simulation::{protocol::MotionCommand, ControlSource, SimulationManager};
    use std::process::Stdio;

    #[test]
    fn fake_bridge_ready_cmd_invalid_and_oversized_frames() {
        assert!(matches!(
            parse_bridge_frame(br#"{"protocolVersion":1,"type":"ready","payload":{"bridgeVersion":"test","watchdogMs":300}}"#).unwrap(),
            BridgeMessage::Ready { .. }
        ));
        assert!(matches!(
            parse_bridge_frame(br#"{"protocolVersion":1,"type":"cmd_vel","payload":{"sequence":9,"forwardVelocity":0.1,"yawRate":0.2}}"#).unwrap(),
            BridgeMessage::CmdVel(_)
        ));
        assert!(parse_bridge_frame(b"not-json").is_err());
        assert!(parse_bridge_frame(&vec![b'x'; MAX_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn control_source_defaults_manual_and_gates_both_paths() {
        let simulation = SimulationManager::new();
        assert_eq!(simulation.control_source(), ControlSource::Manual);
        let command = MotionCommand {
            sequence: 1,
            mode: crate::simulation::protocol::MotionCommandMode::Locomotion,
            forward_velocity: 0.1,
            lateral_velocity: 0.0,
            yaw_rate: 0.0,
            body_height: 0.3,
            valid_for_ms: 300,
        };
        assert_eq!(
            simulation
                .set_ros_motion_command(command.clone())
                .unwrap_err()
                .code,
            "CONTROL_SOURCE_MISMATCH"
        );
        simulation.set_control_source(ControlSource::Ros);
        assert_eq!(
            simulation.set_motion_command(command).unwrap_err().code,
            "CONTROL_SOURCE_MISMATCH"
        );
    }

    #[test]
    fn control_source_transitions_have_safe_order_and_no_automatic_rearm() {
        assert_eq!(
            transition_steps(ControlSource::Ros),
            &[
                TransitionStep::DisarmKeyboard,
                TransitionStep::ClearMotion,
                TransitionStep::SetSource(ControlSource::Ros),
                TransitionStep::SetBridgeEnabled(true),
            ]
        );
        assert_eq!(
            transition_steps(ControlSource::Manual),
            &[
                TransitionStep::SetBridgeEnabled(false),
                TransitionStep::ClearMotion,
                TransitionStep::SetSource(ControlSource::Manual),
                TransitionStep::DisarmKeyboard,
            ]
        );
    }

    #[test]
    fn missing_bridge_executable_is_an_optional_capability() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_bridge_executable(
                Some(directory.path().join("missing-override")),
                directory.path().join("missing-default"),
            ),
            None
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn fake_bridge_process_spawns_reads_ready_and_shuts_down() {
        let ready = r#"{"protocolVersion":1,"type":"ready","payload":{"bridgeVersion":"fake","watchdogMs":300}}"#;
        let mut command = Command::new("sh");
        command
            .args(["-c", &format!("printf '%s\\n' '{ready}'; read -r _")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut spawned = process::spawn_guarded(command).unwrap();
        let mut output = String::new();
        BufReader::new(spawned.child.stdout.take().unwrap())
            .read_line(&mut output)
            .unwrap();
        assert!(matches!(
            parse_bridge_frame(output.trim().as_bytes()).unwrap(),
            BridgeMessage::Ready { .. }
        ));
        spawned
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(&shutdown_frame().unwrap())
            .unwrap();
        assert!(spawned.child.wait().unwrap().success());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn fake_bridge_crash_is_observable_without_a_sidecar() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "exit 17"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut spawned = process::spawn_guarded(command).unwrap();
        assert_eq!(spawned.child.wait().unwrap().code(), Some(17));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn bridge_parent_death_helper() {
        if std::env::var_os("ROS_BRIDGE_PDEATHSIG_HELPER").is_none() {
            return;
        }
        let mut command = Command::new("sleep");
        command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let spawned = process::spawn_guarded(command).expect("spawn guarded bridge fixture");
        println!("ROS_BRIDGE_PDEATHSIG_PID={}", spawned.child.id());
        std::io::stdout().flush().unwrap();
        std::mem::forget(spawned);
        // SAFETY: The dedicated subprocess intentionally simulates an abrupt Tauri exit.
        unsafe { libc::_exit(0) }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn bridge_guardian_prevents_permanent_orphan() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ros_bridge::tests::bridge_parent_death_helper",
                "--nocapture",
            ])
            .env("ROS_BRIDGE_PDEATHSIG_HELPER", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        let pid = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("ROS_BRIDGE_PDEATHSIG_PID="))
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            // SAFETY: Signal 0 only checks whether the exact fixture PID still exists.
            if unsafe { libc::kill(pid, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("guarded ROS bridge fixture remained alive after parent exit");
    }
}

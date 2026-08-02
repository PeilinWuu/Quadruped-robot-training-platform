use super::{
    error::SimulationError,
    process::{self, JobObject},
    protocol::{parse_response_line, ProtocolCommand, ProtocolResponse, MAX_LINE_BYTES},
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

const START_TIMEOUT: Duration = Duration::from_secs(8);
const PING_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const STDERR_MAX_LINES: usize = 100;
const STDERR_MAX_BYTES: usize = 64 * 1024;
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimulationStatus {
    pub state: LifecycleState,
    pub sidecar_version: Option<String>,
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
    generation: u64,
    request_counter: u64,
    runtime: Option<ProcessRuntime>,
    pending: HashMap<String, PendingSender>,
    stderr_lines: VecDeque<String>,
    stderr_bytes: usize,
    error: Option<SimulationError>,
    started_at: Option<i64>,
    sidecar_version: Option<String>,
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
                    generation: 0,
                    request_counter: 0,
                    runtime: None,
                    pending: HashMap::new(),
                    stderr_lines: VecDeque::new(),
                    stderr_bytes: 0,
                    error: None,
                    started_at: None,
                    sidecar_version: None,
                }),
            }),
        }
    }

    pub fn status(&self) -> SimulationStatus {
        let inner = self
            .core
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        SimulationStatus {
            state: inner.state,
            sidecar_version: inner.sidecar_version.clone(),
            started_at: inner.started_at,
            error: inner.error.clone(),
        }
    }

    pub fn start_from_resource_dir(
        &self,
        resource_dir: &Path,
    ) -> Result<SimulationStatus, SimulationError> {
        let path = resolve_sidecar_path(resource_dir)?;
        self.start_path(path)
    }

    fn start_path(&self, path: PathBuf) -> Result<SimulationStatus, SimulationError> {
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
            inner.error = None;
            inner.started_at = Some(unix_milliseconds());
            inner.sidecar_version = None;
            inner.stderr_lines.clear();
            inner.stderr_bytes = 0;
            inner.generation
        };

        let spawned = match process::spawn(&path) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.set_failed(generation, error.clone());
                return Err(error);
            }
        };
        let mut child = spawned.child;
        let stdin = child.stdin.take().ok_or_else(SimulationError::internal)?;
        let stdout = child.stdout.take().ok_or_else(SimulationError::internal)?;
        let stderr = child.stderr.take().ok_or_else(SimulationError::internal)?;
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        let job = Arc::new(spawned.job);

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
            if inner.generation != generation || inner.state != LifecycleState::Starting {
                let _ = job.terminate();
                return Err(SimulationError::invalid_state());
            }
            inner.runtime = Some(ProcessRuntime {
                child,
                stdin,
                job,
                stdout_thread: Some(stdout_thread),
                stderr_thread: Some(stderr_thread),
            });
        }

        match self.request(ProtocolCommand::Hello, START_TIMEOUT) {
            Ok(ProtocolResponse::Ready(ready)) => {
                let mut inner = self
                    .core
                    .inner
                    .lock()
                    .map_err(|_| SimulationError::internal())?;
                if inner.generation != generation {
                    return Err(SimulationError::invalid_state());
                }
                inner.state = LifecycleState::Ready;
                inner.sidecar_version = Some(ready.sidecar_version);
                Ok(SimulationStatus {
                    state: inner.state,
                    sidecar_version: inner.sidecar_version.clone(),
                    started_at: inner.started_at,
                    error: inner.error.clone(),
                })
            }
            Ok(ProtocolResponse::Error(error)) => {
                let failure =
                    SimulationError::new(&error.code, "The simulation sidecar rejected startup.");
                self.cleanup_process(false);
                self.set_failed(generation, failure.clone());
                Err(failure)
            }
            Ok(_) => {
                let failure = SimulationError::protocol();
                self.cleanup_process(false);
                self.set_failed(generation, failure.clone());
                Err(failure)
            }
            Err(error) => {
                self.cleanup_process(false);
                self.set_failed(generation, error.clone());
                Err(error)
            }
        }
    }

    pub fn ping(&self) -> Result<PingResult, SimulationError> {
        if self.status().state != LifecycleState::Ready {
            return Err(SimulationError::invalid_state());
        }
        let nonce = format!("nonce-{}", unix_milliseconds());
        let started = Instant::now();
        match self.request(
            ProtocolCommand::Ping {
                nonce: nonce.clone(),
            },
            PING_TIMEOUT,
        ) {
            Ok(ProtocolResponse::Pong(payload)) => {
                let verified = payload.nonce == Some(nonce);
                if !verified {
                    return Err(SimulationError::protocol());
                }
                Ok(PingResult {
                    latency_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
                    nonce_verified: true,
                })
            }
            Ok(ProtocolResponse::Error(error)) => Err(SimulationError::new(
                &error.code,
                "The simulation sidecar rejected the ping request.",
            )),
            Ok(_) => Err(SimulationError::protocol()),
            Err(error) => {
                if error.code == "SIDECAR_REQUEST_TIMEOUT" {
                    if let Ok(mut inner) = self.core.inner.lock() {
                        inner.state = LifecycleState::Unresponsive;
                        inner.error = Some(error.clone());
                    }
                }
                Err(error)
            }
        }
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
        inner.error = None;
        inner.started_at = None;
        inner.sidecar_version = None;
        Ok(SimulationStatus {
            state: inner.state,
            sidecar_version: None,
            started_at: None,
            error: None,
        })
    }

    pub fn shutdown_for_exit(&self) {
        let _ = self.stop();
    }

    fn request(
        &self,
        command: ProtocolCommand,
        timeout: Duration,
    ) -> Result<ProtocolResponse, SimulationError> {
        let (request_id, receiver, stdin) = {
            let mut inner = self
                .core
                .inner
                .lock()
                .map_err(|_| SimulationError::internal())?;
            inner.request_counter = inner.request_counter.wrapping_add(1);
            let request_id = format!("request-{}-{}", inner.generation, inner.request_counter);
            let stdin = inner
                .runtime
                .as_ref()
                .map(|runtime| Arc::clone(&runtime.stdin))
                .ok_or_else(SimulationError::invalid_state)?;
            let (sender, receiver) = mpsc::channel();
            inner.pending.insert(request_id.clone(), sender);
            (request_id, receiver, stdin)
        };
        let line = command.to_line(request_id.clone(), unix_milliseconds())?;
        let write_result = stdin
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
        if let Err(error) = write_result {
            if let Ok(mut inner) = self.core.inner.lock() {
                inner.pending.remove(&request_id);
            }
            return Err(error);
        }
        let received = receiver.recv_timeout(timeout);
        if let Ok(mut inner) = self.core.inner.lock() {
            inner.pending.remove(&request_id);
        }
        match received {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(SimulationError::timeout("SIDECAR_REQUEST_TIMEOUT"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(SimulationError::new(
                "SIDECAR_DISCONNECTED",
                "The simulation sidecar disconnected.",
            )),
        }
    }

    fn cleanup_process(&self, allow_graceful_wait: bool) {
        let runtime_snapshot = self.core.inner.lock().ok().and_then(|inner| {
            inner
                .runtime
                .as_ref()
                .map(|runtime| (Arc::clone(&runtime.child), Arc::clone(&runtime.job)))
        });
        if let Some((child, job)) = runtime_snapshot {
            let deadline = Instant::now()
                + if allow_graceful_wait {
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
            if let Some(thread) = runtime.stdout_thread.take() {
                let _ = thread.join();
            }
            if let Some(thread) = runtime.stderr_thread.take() {
                let _ = thread.join();
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
            if let Some(runtime) = inner.runtime.as_ref() {
                let _ = runtime.job.terminate();
            }
        }
    }

    #[cfg(test)]
    fn stderr_metrics(&self) -> (usize, usize) {
        let inner = self.core.inner.lock().unwrap();
        (inner.stderr_lines.len(), inner.stderr_bytes)
    }
}

impl Drop for SimulationManager {
    fn drop(&mut self) {
        if Arc::strong_count(&self.core) == 1 {
            self.cleanup_process(false);
        }
    }
}

pub fn resolve_sidecar_path(resource_dir: &Path) -> Result<PathBuf, SimulationError> {
    let canonical_root = fs::canonicalize(resource_dir).map_err(|_| {
        SimulationError::new(
            "SIDECAR_RESOURCE_MISSING",
            "The bundled simulation sidecar is unavailable.",
        )
    })?;
    let candidate = SIDECAR_RELATIVE_PATH
        .iter()
        .fold(canonical_root.clone(), |path, segment| path.join(segment));
    let canonical_candidate = fs::canonicalize(candidate).map_err(|_| {
        SimulationError::new(
            "SIDECAR_RESOURCE_MISSING",
            "The bundled simulation sidecar is unavailable.",
        )
    })?;
    if !canonical_candidate.starts_with(&canonical_root)
        || !canonical_candidate.is_file()
        || canonical_candidate
            .extension()
            .and_then(|value| value.to_str())
            != Some("exe")
    {
        return Err(SimulationError::new(
            "SIDECAR_RESOURCE_INVALID",
            "The bundled simulation sidecar is invalid.",
        ));
    }
    Ok(canonical_candidate)
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
            let read_result = reader
                .by_ref()
                .take((MAX_LINE_BYTES + 2) as u64)
                .read_until(b'\n', &mut buffer);
            match read_result {
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
                        Ok((request_id, response)) => {
                            deliver_response(&core, generation, request_id, Ok(response))
                        }
                        Err(error) => {
                            mark_crashed_with_error(&core, generation, error);
                            let _ = job.terminate();
                            break;
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
            let read = reader.by_ref().take(1026).read_line(&mut line);
            let Ok(read) = read else { break };
            if read == 0 {
                break;
            }
            let sanitized: String = line
                .chars()
                .filter(|character| !character.is_control())
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

fn deliver_response(
    core: &Weak<ManagerCore>,
    generation: u64,
    request_id: String,
    response: Result<ProtocolResponse, SimulationError>,
) {
    let Some(core) = core.upgrade() else { return };
    let sender = core.inner.lock().ok().and_then(|mut inner| {
        if inner.generation != generation {
            return None;
        }
        inner.pending.remove(&request_id)
    });
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
}

fn mark_crashed(core: &Weak<ManagerCore>, generation: u64, code: &str) {
    mark_crashed_with_error(
        core,
        generation,
        SimulationError::new(code, "The simulation sidecar exited unexpectedly."),
    );
}

fn mark_crashed_with_error(core: &Weak<ManagerCore>, generation: u64, error: SimulationError) {
    let Some(core) = core.upgrade() else { return };
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

    fn sidecar_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/sidecar/quadruped-simulation-sidecar.exe")
    }

    fn profile_resource_dir(profile: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(profile)
    }

    fn sidecar_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait_for_state(manager: &SimulationManager, state: LifecycleState) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if manager.status().state == state {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "state did not become {state:?}: {:?}",
            manager.status().state
        );
    }

    #[test]
    fn initial_state_and_idempotent_stop() {
        let manager = SimulationManager::new();
        assert_eq!(manager.status().state, LifecycleState::Idle);
        assert_eq!(manager.stop().unwrap().state, LifecycleState::Idle);
    }

    #[test]
    fn actual_sidecar_start_ping_stop_restart_and_duplicate_guard() {
        let _guard = sidecar_test_guard();
        let manager = SimulationManager::new();
        assert_eq!(
            manager.start_path(sidecar_path()).unwrap().state,
            LifecycleState::Ready
        );
        assert!(manager.ping().unwrap().nonce_verified);
        assert_eq!(
            manager.start_path(sidecar_path()).unwrap_err().code,
            "ALREADY_RUNNING"
        );
        assert_eq!(manager.stop().unwrap().state, LifecycleState::Idle);
        assert_eq!(
            manager.start_path(sidecar_path()).unwrap().state,
            LifecycleState::Ready
        );
        assert_eq!(manager.stop().unwrap().state, LifecycleState::Idle);
    }

    #[test]
    fn fixed_development_and_release_resource_paths_resolve() {
        let _guard = sidecar_test_guard();
        for profile in ["debug", "release"] {
            let resource_dir = profile_resource_dir(profile);
            let resolved = resolve_sidecar_path(&resource_dir).unwrap();
            assert!(resolved.ends_with("resources/sidecar/quadruped-simulation-sidecar.exe"));
        }
        let manager = SimulationManager::new();
        assert_eq!(
            manager
                .start_from_resource_dir(&profile_resource_dir("debug"))
                .unwrap()
                .state,
            LifecycleState::Ready
        );
        assert_eq!(manager.stop().unwrap().state, LifecycleState::Idle);
    }

    #[test]
    fn unexpected_exit_becomes_crashed_and_can_be_cleaned() {
        let _guard = sidecar_test_guard();
        let manager = SimulationManager::new();
        manager.start_path(sidecar_path()).unwrap();
        manager.force_terminate_for_test();
        wait_for_state(&manager, LifecycleState::Crashed);
        assert_eq!(manager.stop().unwrap().state, LifecycleState::Idle);
    }

    #[test]
    fn lifecycle_timings_are_bounded() {
        let _guard = sidecar_test_guard();
        let manager = SimulationManager::new();
        let start_begin = Instant::now();
        manager.start_path(sidecar_path()).unwrap();
        let start_ms = start_begin.elapsed().as_millis();
        let ping = manager.ping().unwrap();
        let stop_begin = Instant::now();
        manager.stop().unwrap();
        let stop_ms = stop_begin.elapsed().as_millis();

        manager.start_path(sidecar_path()).unwrap();
        let force_begin = Instant::now();
        manager.force_terminate_for_test();
        wait_for_state(&manager, LifecycleState::Crashed);
        manager.stop().unwrap();
        let force_ms = force_begin.elapsed().as_millis();

        assert!(start_ms < START_TIMEOUT.as_millis());
        assert!(u128::from(ping.latency_ms) < PING_TIMEOUT.as_millis());
        assert!(stop_ms < STOP_TIMEOUT.as_millis());
        assert!(force_ms < STOP_TIMEOUT.as_millis());
        println!(
            "D4B_TIMING start_ms={start_ms} ping_ms={} stop_ms={stop_ms} force_ms={force_ms}",
            ping.latency_ms
        );
    }

    #[test]
    fn exit_cleanup_and_manager_drop_leave_no_process() {
        let _guard = sidecar_test_guard();
        let manager = SimulationManager::new();
        manager.start_path(sidecar_path()).unwrap();
        manager.shutdown_for_exit();
        assert_eq!(manager.status().state, LifecycleState::Idle);

        manager.start_path(sidecar_path()).unwrap();
        let child = {
            let inner = manager.core.inner.lock().unwrap();
            Arc::clone(&inner.runtime.as_ref().unwrap().child)
        };
        drop(manager);
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn stderr_ring_is_bounded() {
        let manager = SimulationManager::new();
        {
            let mut inner = manager.core.inner.lock().unwrap();
            for _ in 0..150 {
                let line = "x".repeat(1024);
                inner.stderr_bytes += line.len();
                inner.stderr_lines.push_back(line);
                while inner.stderr_lines.len() > STDERR_MAX_LINES
                    || inner.stderr_bytes > STDERR_MAX_BYTES
                {
                    let removed = inner.stderr_lines.pop_front().unwrap();
                    inner.stderr_bytes -= removed.len();
                }
            }
        }
        let (lines, bytes) = manager.stderr_metrics();
        assert!(lines <= STDERR_MAX_LINES);
        assert!(bytes <= STDERR_MAX_BYTES);
    }

    #[test]
    fn stale_generation_cannot_change_current_state() {
        let manager = SimulationManager::new();
        let old_generation = {
            let mut inner = manager.core.inner.lock().unwrap();
            inner.generation = 2;
            inner.state = LifecycleState::Ready;
            1
        };
        mark_crashed(&Arc::downgrade(&manager.core), old_generation, "OLD");
        assert_eq!(manager.status().state, LifecycleState::Ready);
    }

    #[test]
    fn safe_errors_do_not_expose_absolute_paths() {
        let error = resolve_sidecar_path(Path::new("Z:/missing/private/user/path")).unwrap_err();
        assert!(!error.message.contains("Z:"));
        assert!(!error.message.contains("private"));
    }
}

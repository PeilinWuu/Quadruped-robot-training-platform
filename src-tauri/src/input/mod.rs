#[cfg(target_os = "linux")]
mod linux;

use crate::real_robot::{RealKeyboardMotionCommand, RealRobotManager};
use crate::simulation::{
    protocol::{MotionCommand, MotionCommandMode},
    SimulationManager,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

const HEARTBEAT_PERIOD: Duration = Duration::from_millis(50);
const VALID_FOR_MS: u32 = 250;
const REAL_KEEPALIVE_PERIOD: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeDemoSpeed {
    Low,
    Medium,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeKeyboardState {
    pub native: bool,
    pub armed: bool,
    pub suppress_input: bool,
    pub window_focused: bool,
    pub forward: bool,
    pub backward: bool,
    pub left: bool,
    pub right: bool,
    pub yaw_left: bool,
    pub yaw_right: bool,
    pub resetting: bool,
    pub speed: NativeDemoSpeed,
    pub generation: u64,
    pub forward_velocity: f64,
    pub lateral_velocity: f64,
    pub yaw_rate: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeKeyboardCapabilities {
    pub realtime_input_mode: &'static str,
    pub heartbeat_period_ms: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeKeyboardDiagnostics {
    pub key_events: u64,
    pub desired_updates: u64,
    pub heartbeat_sends: u64,
    pub heartbeat_completions: u64,
    pub coalesced_updates: u64,
    pub in_flight: u8,
    pub max_in_flight: u8,
    pub last_key_pressed: bool,
    pub last_key_event_unix_micros: u64,
    pub last_desired_state_unix_micros: u64,
    pub last_heartbeat_send_unix_micros: u64,
    pub last_send_latency_micros: u64,
    pub last_sidecar_command_age_ms: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum NativeKey {
    #[default]
    Other,
    Forward,
    Backward,
    Left,
    Right,
    YawLeft,
    YawRight,
    Space,
    Reset,
    Escape,
}

#[derive(Debug, Clone)]
struct MotionState {
    armed: bool,
    suppress_input: bool,
    window_focused: bool,
    forward: bool,
    backward: bool,
    left: bool,
    right: bool,
    yaw_left: bool,
    yaw_right: bool,
    resetting: bool,
    reset_requested: bool,
    clear_requested: bool,
    speed: NativeDemoSpeed,
    generation: u64,
    revision: u64,
    shutdown: bool,
    diagnostics: NativeKeyboardDiagnostics,
}

impl Default for MotionState {
    fn default() -> Self {
        Self {
            armed: false,
            suppress_input: false,
            window_focused: true,
            forward: false,
            backward: false,
            left: false,
            right: false,
            yaw_left: false,
            yaw_right: false,
            resetting: false,
            reset_requested: false,
            clear_requested: false,
            speed: NativeDemoSpeed::Medium,
            generation: 0,
            revision: 0,
            shutdown: false,
            diagnostics: NativeKeyboardDiagnostics::default(),
        }
    }
}

impl MotionState {
    fn clear_keys(&mut self) {
        self.forward = false;
        self.backward = false;
        self.left = false;
        self.right = false;
        self.yaw_left = false;
        self.yaw_right = false;
    }

    fn target(&self) -> (f64, f64, f64) {
        let (linear, yaw) = match self.speed {
            NativeDemoSpeed::Low => (0.15, 0.25),
            NativeDemoSpeed::Medium => (0.30, 0.50),
        };
        let forward_velocity = if self.forward == self.backward {
            0.0
        } else if self.forward {
            linear
        } else {
            -linear
        };
        let lateral_velocity = if self.left == self.right {
            0.0
        } else if self.left {
            linear
        } else {
            -linear
        };
        let yaw_rate = if self.yaw_left == self.yaw_right {
            0.0
        } else if self.yaw_left {
            yaw
        } else {
            -yaw
        };
        (forward_velocity, lateral_velocity, yaw_rate)
    }

    fn snapshot(&self) -> NativeKeyboardState {
        let (forward_velocity, lateral_velocity, yaw_rate) = self.target();
        NativeKeyboardState {
            native: cfg!(target_os = "linux"),
            armed: self.armed,
            suppress_input: self.suppress_input,
            window_focused: self.window_focused,
            forward: self.forward,
            backward: self.backward,
            left: self.left,
            right: self.right,
            yaw_left: self.yaw_left,
            yaw_right: self.yaw_right,
            resetting: self.resetting,
            speed: self.speed,
            generation: self.generation,
            forward_velocity,
            lateral_velocity,
            yaw_rate,
        }
    }
}

trait MotionSink: Send + Sync + 'static {
    fn available(&self) -> bool;
    fn send(&self, command: Option<MotionCommand>) -> Option<u64>;
    fn reset(&self);
}

struct ManagerMotionSink {
    manager: SimulationManager,
    real_robot: RealRobotManager,
    real_state: Mutex<RealFanoutState>,
    app: AppHandle,
}

#[derive(Default)]
struct RealFanoutState {
    active: bool,
    last_command: Option<(f64, f64, f64)>,
    last_sent: Option<Instant>,
}

impl MotionSink for ManagerMotionSink {
    fn available(&self) -> bool {
        self.manager.native_motion_available()
    }

    fn send(&self, command: Option<MotionCommand>) -> Option<u64> {
        let result = if let Some(command) = command.as_ref() {
            self.manager
                .set_motion_command(command.clone())
                .ok()
                .map(|status| status.age_ms)
        } else {
            self.manager
                .clear_motion_command()
                .ok()
                .map(|status| status.age_ms)
        };
        self.fan_out_to_real(command.as_ref());
        result
    }

    fn reset(&self) {
        // GTK consumes R before it reaches the WebView. Forward it explicitly so
        // keyboard and UI resets share the same frontend recovery transaction,
        // including sidecar restart after a crash.
        let _ = self.app.emit("native-keyboard-reset-requested", ());
    }
}

impl ManagerMotionSink {
    fn fan_out_to_real(&self, command: Option<&MotionCommand>) {
        let mut state = self
            .real_state
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        let values = command.map(|value| {
            (
                value.forward_velocity,
                value.lateral_velocity,
                value.yaw_rate,
            )
        });
        let moving = values.is_some_and(|(vx, vy, yaw)| vx != 0.0 || vy != 0.0 || yaw != 0.0);
        if moving && self.real_robot.keyboard_sync_ready() {
            let values = values.expect("moving command has values");
            let due = state.last_command != Some(values)
                || state
                    .last_sent
                    .is_none_or(|time| time.elapsed() >= REAL_KEEPALIVE_PERIOD);
            if due
                && self
                    .real_robot
                    .keyboard_motion(RealKeyboardMotionCommand {
                        forward_velocity: values.0,
                        lateral_velocity: values.1,
                        yaw_rate: values.2,
                    })
                    .is_ok()
            {
                state.active = true;
                state.last_command = Some(values);
                state.last_sent = Some(Instant::now());
            }
        } else if state.active && (!moving || !self.real_robot.keyboard_sync_configured()) {
            let _ = self.real_robot.stop();
            *state = RealFanoutState::default();
        }
    }
}

type StateObserver = Arc<dyn Fn(NativeKeyboardState) + Send + Sync>;

struct Shared {
    state: Mutex<MotionState>,
    changed: Condvar,
}

struct ControllerCore {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for ControllerCore {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.shutdown = true;
            state.clear_keys();
            state.armed = false;
            state.revision = state.revision.wrapping_add(1);
            self.shared.changed.notify_all();
        }
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

#[derive(Clone)]
pub struct NativeKeyboardController {
    core: Arc<ControllerCore>,
}

impl NativeKeyboardController {
    pub fn new(manager: SimulationManager, real_robot: RealRobotManager, app: AppHandle) -> Self {
        let state_app = app.clone();
        let observer: StateObserver = Arc::new(move |state| {
            let _ = state_app.emit("native-keyboard-state-changed", state);
        });
        Self::with_sink(
            Arc::new(ManagerMotionSink {
                manager,
                real_robot,
                real_state: Mutex::new(RealFanoutState::default()),
                app,
            }),
            Some(observer),
        )
    }

    fn with_sink(sink: Arc<dyn MotionSink>, observer: Option<StateObserver>) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(MotionState::default()),
            changed: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("native-motion-heartbeat".into())
            .spawn(move || heartbeat_worker(worker_shared, sink, observer))
            .expect("native motion heartbeat thread must start");
        Self {
            core: Arc::new(ControllerCore {
                shared,
                worker: Mutex::new(Some(worker)),
            }),
        }
    }

    fn update(&self, operation: impl FnOnce(&mut MotionState)) -> NativeKeyboardState {
        let mut state = self
            .core
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = state.snapshot();
        operation(&mut state);
        let after = state.snapshot();
        if after != before {
            if state.diagnostics.in_flight > 0 {
                state.diagnostics.coalesced_updates =
                    state.diagnostics.coalesced_updates.saturating_add(1);
            }
            state.diagnostics.desired_updates = state.diagnostics.desired_updates.saturating_add(1);
            state.diagnostics.last_desired_state_unix_micros = unix_microseconds();
            state.revision = state.revision.wrapping_add(1);
            self.core.shared.changed.notify_one();
        }
        after
    }

    pub fn state(&self) -> NativeKeyboardState {
        self.core
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot()
    }

    pub fn diagnostics(&self) -> NativeKeyboardDiagnostics {
        self.core
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .diagnostics
    }

    pub fn arm(&self) -> NativeKeyboardState {
        self.update(|state| {
            state.generation = state.generation.wrapping_add(1);
            state.clear_keys();
            state.armed = true;
            state.resetting = false;
        })
    }

    pub fn disarm(&self) -> NativeKeyboardState {
        self.update(|state| {
            state.generation = state.generation.wrapping_add(1);
            state.clear_keys();
            state.armed = false;
            state.resetting = false;
            state.reset_requested = false;
            state.clear_requested = false;
        })
    }

    pub fn set_speed(&self, speed: NativeDemoSpeed) -> NativeKeyboardState {
        self.update(|state| state.speed = speed)
    }

    pub fn set_suppressed(&self, suppressed: bool) -> NativeKeyboardState {
        self.update(|state| {
            state.suppress_input = suppressed;
            if suppressed {
                state.generation = state.generation.wrapping_add(1);
                state.clear_keys();
            }
        })
    }

    pub fn set_window_focused(&self, focused: bool) -> NativeKeyboardState {
        self.update(|state| {
            state.window_focused = focused;
            if !focused {
                state.generation = state.generation.wrapping_add(1);
                state.clear_keys();
            }
        })
    }

    pub fn prepare_reset(&self) -> NativeKeyboardState {
        self.update(|state| {
            state.generation = state.generation.wrapping_add(1);
            state.clear_keys();
            state.resetting = true;
        })
    }

    pub fn finish_reset(&self) -> NativeKeyboardState {
        self.update(|state| state.resetting = false)
    }

    pub(crate) fn handle_key(&self, key: NativeKey, pressed: bool) -> bool {
        let mut consumed = false;
        self.update(|state| {
            if key != NativeKey::Other {
                state.diagnostics.key_events = state.diagnostics.key_events.saturating_add(1);
                state.diagnostics.last_key_pressed = pressed;
                state.diagnostics.last_key_event_unix_micros = unix_microseconds();
            }
            if state.suppress_input || !state.window_focused {
                return;
            }
            if key == NativeKey::Escape && pressed && state.armed {
                consumed = true;
                state.generation = state.generation.wrapping_add(1);
                state.clear_keys();
                state.armed = false;
                return;
            }
            if key == NativeKey::Space && pressed && state.armed {
                consumed = true;
                state.generation = state.generation.wrapping_add(1);
                state.clear_keys();
                state.clear_requested = true;
                return;
            }
            // Reset is a recovery action, not a locomotion action. A controller fault
            // automatically disarms W/A/S/D, but R must remain available so the user
            // can recover without restarting the application.
            if key == NativeKey::Reset && pressed {
                consumed = true;
                state.generation = state.generation.wrapping_add(1);
                state.clear_keys();
                state.resetting = true;
                state.reset_requested = true;
                return;
            }
            if !state.armed || state.suppress_input || !state.window_focused || state.resetting {
                return;
            }
            let target = match key {
                NativeKey::Forward => &mut state.forward,
                NativeKey::Backward => &mut state.backward,
                NativeKey::Left => &mut state.left,
                NativeKey::Right => &mut state.right,
                NativeKey::YawLeft => &mut state.yaw_left,
                NativeKey::YawRight => &mut state.yaw_right,
                _ => return,
            };
            consumed = true;
            *target = pressed;
        });
        consumed
    }

    pub fn shutdown(&self) {
        self.disarm();
        let mut state = self
            .core
            .shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.shutdown = true;
        state.revision = state.revision.wrapping_add(1);
        self.core.shared.changed.notify_all();
    }
}

fn heartbeat_worker(
    shared: Arc<Shared>,
    sink: Arc<dyn MotionSink>,
    observer: Option<StateObserver>,
) {
    let mut next_tick = Instant::now();
    let mut observed_revision = u64::MAX;
    let mut sequence = 1_u32;
    loop {
        let (snapshot, revision, reset_requested, clear_requested, shutting_down) = {
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while !state.shutdown
                && state.revision == observed_revision
                && Instant::now() < next_tick
            {
                let timeout = next_tick.saturating_duration_since(Instant::now());
                let waited = shared.changed.wait_timeout(state, timeout);
                state = match waited {
                    Ok((state, _)) => state,
                    Err(poisoned) => poisoned.into_inner().0,
                };
            }
            if state.shutdown {
                (state.snapshot(), state.revision, false, false, true)
            } else {
                if state.armed && !sink.available() {
                    let had_keys = state.forward
                        || state.backward
                        || state.left
                        || state.right
                        || state.yaw_left
                        || state.yaw_right;
                    state.clear_keys();
                    if had_keys {
                        state.revision = state.revision.wrapping_add(1);
                    }
                }
                let reset_requested = state.reset_requested;
                state.reset_requested = false;
                let clear_requested = state.clear_requested;
                state.clear_requested = false;
                (
                    state.snapshot(),
                    state.revision,
                    reset_requested,
                    clear_requested,
                    false,
                )
            }
        };

        if shutting_down {
            dispatch_motion(&shared, sink.as_ref(), None);
            return;
        }

        let revision_changed = revision != observed_revision;
        if revision_changed {
            observed_revision = revision;
            if let Some(observer) = observer.as_ref() {
                observer(snapshot);
            }
        }

        if reset_requested {
            dispatch_motion(&shared, sink.as_ref(), None);
            sink.reset();
            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.resetting = false;
            state.revision = state.revision.wrapping_add(1);
            shared.changed.notify_one();
            next_tick = Instant::now() + HEARTBEAT_PERIOD;
            continue;
        }

        if clear_requested {
            dispatch_motion(&shared, sink.as_ref(), None);
            next_tick = Instant::now() + HEARTBEAT_PERIOD;
            continue;
        }

        let due = Instant::now() >= next_tick;
        if due || revision_changed {
            let dispatch_started = Instant::now();
            if snapshot.armed
                && snapshot.window_focused
                && !snapshot.suppress_input
                && !snapshot.resetting
                && sink.available()
            {
                dispatch_motion(
                    &shared,
                    sink.as_ref(),
                    Some(MotionCommand {
                        sequence,
                        mode: MotionCommandMode::Locomotion,
                        forward_velocity: snapshot.forward_velocity,
                        lateral_velocity: snapshot.lateral_velocity,
                        yaw_rate: snapshot.yaw_rate,
                        body_height: 0.3,
                        valid_for_ms: VALID_FOR_MS,
                    }),
                );
                sequence = sequence.wrapping_add(1);
            } else if revision_changed {
                dispatch_motion(&shared, sink.as_ref(), None);
            }
            // Skip missed periods; never replay historical ticks.
            next_tick = dispatch_started + HEARTBEAT_PERIOD;
            if next_tick <= Instant::now() {
                next_tick = Instant::now() + HEARTBEAT_PERIOD;
            }
        }
    }
}

fn dispatch_motion(shared: &Shared, sink: &dyn MotionSink, command: Option<MotionCommand>) {
    let started_at = Instant::now();
    {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.diagnostics.heartbeat_sends = state.diagnostics.heartbeat_sends.saturating_add(1);
        state.diagnostics.in_flight = 1;
        state.diagnostics.max_in_flight = state.diagnostics.max_in_flight.max(1);
        state.diagnostics.last_heartbeat_send_unix_micros = unix_microseconds();
    }
    let sidecar_age_ms = sink.send(command);
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.diagnostics.in_flight = 0;
    state.diagnostics.heartbeat_completions =
        state.diagnostics.heartbeat_completions.saturating_add(1);
    state.diagnostics.last_send_latency_micros = started_at
        .elapsed()
        .as_micros()
        .try_into()
        .unwrap_or(u64::MAX);
    if let Some(age_ms) = sidecar_age_ms {
        state.diagnostics.last_sidecar_command_age_ms = age_ms;
    }
}

fn unix_microseconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[tauri::command]
pub fn native_keyboard_capabilities() -> NativeKeyboardCapabilities {
    NativeKeyboardCapabilities {
        realtime_input_mode: if cfg!(target_os = "linux") {
            "native"
        } else {
            "javascript"
        },
        heartbeat_period_ms: HEARTBEAT_PERIOD.as_millis() as u64,
    }
}

#[tauri::command]
pub fn native_keyboard_state(
    controller: State<'_, NativeKeyboardController>,
) -> NativeKeyboardState {
    controller.state()
}

#[tauri::command]
pub fn native_keyboard_diagnostics(
    controller: State<'_, NativeKeyboardController>,
) -> NativeKeyboardDiagnostics {
    controller.diagnostics()
}

#[tauri::command]
pub fn native_keyboard_arm(controller: State<'_, NativeKeyboardController>) -> NativeKeyboardState {
    controller.arm()
}

#[tauri::command]
pub fn native_keyboard_disarm(
    controller: State<'_, NativeKeyboardController>,
) -> NativeKeyboardState {
    controller.disarm()
}

#[tauri::command]
pub fn native_keyboard_set_speed(
    speed: NativeDemoSpeed,
    controller: State<'_, NativeKeyboardController>,
) -> NativeKeyboardState {
    controller.set_speed(speed)
}

#[tauri::command]
pub fn native_keyboard_set_input_suppressed(
    suppressed: bool,
    controller: State<'_, NativeKeyboardController>,
) -> NativeKeyboardState {
    controller.set_suppressed(suppressed)
}

#[cfg(target_os = "linux")]
pub fn install_linux_window_hooks(
    window: &tauri::WebviewWindow,
    controller: NativeKeyboardController,
) -> tauri::Result<()> {
    linux::install(window, controller)
}

#[cfg(test)]
mod tests;

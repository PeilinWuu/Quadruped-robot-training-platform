use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct FakeSink {
    available: AtomicBool,
    delay_ms: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    reset_count: AtomicUsize,
    sends: Mutex<Vec<(Instant, Option<MotionCommand>)>>,
}

impl FakeSink {
    fn ready() -> Arc<Self> {
        Arc::new(Self {
            available: AtomicBool::new(true),
            ..Self::default()
        })
    }

    fn commands(&self) -> Vec<Option<MotionCommand>> {
        self.sends
            .lock()
            .unwrap()
            .iter()
            .map(|(_, value)| value.clone())
            .collect()
    }

    fn timed_commands(&self) -> Vec<(Instant, Option<MotionCommand>)> {
        self.sends.lock().unwrap().clone()
    }

    fn clear(&self) {
        self.sends.lock().unwrap().clear();
    }
}

impl MotionSink for FakeSink {
    fn available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }

    fn send(&self, command: Option<MotionCommand>) -> Option<u64> {
        let current = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        self.max_in_flight.fetch_max(current, Ordering::AcqRel);
        let delay = self.delay_ms.load(Ordering::Acquire);
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay as u64));
        }
        self.sends.lock().unwrap().push((Instant::now(), command));
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        Some(0)
    }

    fn reset(&self) {
        self.reset_count.fetch_add(1, Ordering::AcqRel);
    }
}

fn controller(sink: &Arc<FakeSink>) -> NativeKeyboardController {
    NativeKeyboardController::with_sink(sink.clone(), None)
}

fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !predicate() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    assert!(predicate(), "condition did not become true before timeout");
}

fn latest_motion(sink: &FakeSink) -> MotionCommand {
    sink.commands().into_iter().rev().flatten().next().unwrap()
}

fn latest_forward(sink: &FakeSink) -> Option<f64> {
    sink.commands()
        .into_iter()
        .rev()
        .flatten()
        .next()
        .map(|command| command.forward_velocity)
}

#[test]
fn disarmed_w_is_ignored() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.handle_key(NativeKey::Forward, true);
    assert!(!input.state().forward);
    input.shutdown();
}

#[test]
fn armed_w_produces_forward_state() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    assert_eq!(input.state().forward_velocity, 0.30);
    input.shutdown();
}

#[test]
fn w_keyup_immediately_sets_desired_zero() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Forward, false);
    assert_eq!(input.state().forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn w_a_combination_uses_forward_and_lateral_axes() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Left, true);
    assert_eq!(
        (
            input.state().forward_velocity,
            input.state().lateral_velocity,
            input.state().yaw_rate
        ),
        (0.30, 0.30, 0.0)
    );
    input.shutdown();
}

#[test]
fn w_d_combination_uses_forward_and_lateral_axes() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Right, true);
    assert_eq!(
        (
            input.state().forward_velocity,
            input.state().lateral_velocity,
            input.state().yaw_rate
        ),
        (0.30, -0.30, 0.0)
    );
    input.shutdown();
}

#[test]
fn q_e_control_yaw_independently_from_lateral_motion() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.set_speed(NativeDemoSpeed::Low);
    input.arm();
    input.handle_key(NativeKey::Left, true);
    input.handle_key(NativeKey::YawLeft, true);
    assert_eq!(
        (input.state().lateral_velocity, input.state().yaw_rate),
        (0.15, 0.25)
    );
    input.handle_key(NativeKey::YawLeft, false);
    input.handle_key(NativeKey::YawRight, true);
    assert_eq!(input.state().yaw_rate, -0.25);
    input.shutdown();
}

#[test]
fn medium_speed_matches_go2_keyboard_limits_on_all_axes() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.set_speed(NativeDemoSpeed::Medium);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Left, true);
    input.handle_key(NativeKey::YawLeft, true);
    assert_eq!(
        (
            input.state().forward_velocity,
            input.state().lateral_velocity,
            input.state().yaw_rate
        ),
        (0.30, 0.30, 0.50)
    );
    input.shutdown();
}

#[test]
fn w_to_s_keeps_only_latest_state() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Forward, false);
    input.handle_key(NativeKey::Backward, true);
    assert_eq!(input.state().forward_velocity, -0.30);
    input.shutdown();
}

#[test]
fn space_has_zero_priority() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Space, true);
    assert!(input.state().armed);
    assert_eq!(input.state().forward_velocity, 0.0);
    wait_until(Duration::from_millis(100), || {
        sink.commands().iter().any(Option::is_none)
    });
    input.shutdown();
}

#[test]
fn escape_disarms_and_zeros() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Escape, true);
    assert!(!input.state().armed);
    assert_eq!(input.state().forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn blur_zeros_motion() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.set_window_focused(false);
    assert_eq!(input.state().forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn focus_restore_does_not_restore_old_w() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.set_window_focused(false);
    input.set_window_focused(true);
    assert!(!input.state().forward);
    input.shutdown();
}

#[test]
fn editable_suppression_blocks_w() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.set_suppressed(true);
    input.handle_key(NativeKey::Forward, true);
    assert!(!input.state().forward);
    input.shutdown();
}

#[test]
fn suppression_release_requires_new_keydown() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.set_suppressed(true);
    input.set_suppressed(false);
    assert!(!input.state().forward);
    input.handle_key(NativeKey::Forward, true);
    assert!(input.state().forward);
    input.shutdown();
}

#[test]
fn reset_generation_clears_old_keys() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    let generation = input.state().generation;
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Reset, true);
    assert!(input.state().generation > generation);
    assert!(!input.state().forward);
    input.shutdown();
}

#[test]
fn r_clears_motion_then_resets_once() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Reset, true);
    assert!(input.state().resetting);
    assert_eq!(input.state().forward_velocity, 0.0);
    wait_until(Duration::from_millis(100), || {
        sink.reset_count.load(Ordering::Acquire) == 1
            && sink.commands().iter().any(Option::is_none)
            && !input.state().resetting
    });
    assert_eq!(sink.reset_count.load(Ordering::Acquire), 1);
    input.shutdown();
}

#[test]
fn r_resets_once_while_disarmed_and_does_not_rearm_locomotion() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    assert!(!input.state().armed);
    assert!(input.handle_key(NativeKey::Reset, true));
    assert!(input.state().resetting);
    wait_until(Duration::from_millis(100), || {
        sink.reset_count.load(Ordering::Acquire) == 1 && !input.state().resetting
    });
    assert_eq!(sink.reset_count.load(Ordering::Acquire), 1);
    assert!(!input.state().armed);
    assert!(!input.handle_key(NativeKey::Forward, true));
    assert_eq!(input.state().forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn simulation_stop_disarms_and_zeros() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.disarm();
    assert!(!input.state().armed);
    assert_eq!(input.state().forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn heartbeat_period_is_fifty_milliseconds() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    sink.clear();
    wait_until(Duration::from_millis(240), || {
        sink.timed_commands().len() >= 3
    });
    let times = sink.timed_commands();
    let intervals = times
        .windows(2)
        .map(|pair| pair[1].0.duration_since(pair[0].0))
        .collect::<Vec<_>>();
    assert!(intervals
        .iter()
        .all(|value| *value >= Duration::from_millis(40)));
    input.shutdown();
}

#[test]
fn missed_ticks_are_skipped_not_replayed() {
    let sink = FakeSink::ready();
    sink.delay_ms.store(120, Ordering::Release);
    let input = controller(&sink);
    input.arm();
    wait_until(Duration::from_millis(450), || {
        sink.timed_commands().len() >= 2
    });
    let times = sink.timed_commands();
    assert!(times[1].0.duration_since(times[0].0) >= Duration::from_millis(160));
    input.shutdown();
}

#[test]
fn heartbeat_max_in_flight_is_one() {
    let sink = FakeSink::ready();
    sink.delay_ms.store(100, Ordering::Release);
    let input = controller(&sink);
    input.arm();
    thread::sleep(Duration::from_millis(260));
    assert_eq!(sink.max_in_flight.load(Ordering::Acquire), 1);
    input.shutdown();
}

#[test]
fn rapid_changes_are_latest_wins() {
    let sink = FakeSink::ready();
    sink.delay_ms.store(80, Ordering::Release);
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    input.handle_key(NativeKey::Forward, false);
    input.handle_key(NativeKey::Backward, true);
    wait_until(Duration::from_millis(400), || {
        latest_forward(&sink) == Some(-0.30)
    });
    assert_eq!(latest_motion(&sink).forward_velocity, -0.30);
    input.shutdown();
}

#[test]
fn delayed_w_then_keyup_sends_zero_next() {
    let sink = FakeSink::ready();
    sink.delay_ms.store(120, Ordering::Release);
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    wait_until(Duration::from_millis(250), || {
        sink.in_flight.load(Ordering::Acquire) == 1
    });
    input.handle_key(NativeKey::Forward, false);
    wait_until(Duration::from_millis(600), || {
        latest_forward(&sink) == Some(0.0)
    });
    assert_eq!(latest_motion(&sink).forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn old_completion_cannot_overwrite_new_generation() {
    let sink = FakeSink::ready();
    sink.delay_ms.store(100, Ordering::Release);
    let input = controller(&sink);
    input.arm();
    input.handle_key(NativeKey::Forward, true);
    thread::sleep(Duration::from_millis(20));
    input.disarm();
    thread::sleep(Duration::from_millis(150));
    assert!(!input.state().armed);
    assert_eq!(input.state().forward_velocity, 0.0);
    input.shutdown();
}

#[test]
fn shutdown_stops_worker_and_sends_clear() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    input.arm();
    input.shutdown();
    wait_until(Duration::from_millis(150), || {
        sink.commands().iter().any(Option::is_none)
    });
    let count = sink.commands().len();
    thread::sleep(Duration::from_millis(80));
    assert_eq!(sink.commands().len(), count);
}

#[test]
fn repeated_arm_disarm_does_not_create_workers() {
    let sink = FakeSink::ready();
    let input = controller(&sink);
    for _ in 0..5 {
        input.arm();
        input.disarm();
    }
    wait_until(Duration::from_millis(100), || !sink.commands().is_empty());
    assert_eq!(sink.max_in_flight.load(Ordering::Acquire), 1);
    input.shutdown();
}

#[test]
fn restart_does_not_leave_a_second_heartbeat() {
    let first_sink = FakeSink::ready();
    {
        let first = controller(&first_sink);
        first.arm();
        first.shutdown();
    }
    let old_count = first_sink.commands().len();
    let second_sink = FakeSink::ready();
    let second = controller(&second_sink);
    second.arm();
    thread::sleep(Duration::from_millis(130));
    assert_eq!(first_sink.commands().len(), old_count);
    assert!(!second_sink.commands().is_empty());
    second.shutdown();
}

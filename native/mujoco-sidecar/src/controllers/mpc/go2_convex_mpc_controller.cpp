#include "controllers/mpc/go2_convex_mpc_controller.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace sidecar::controllers::mpc {
namespace {

bool any_command(const MotionTarget& target) {
  return target.enabled && (std::abs(target.forward_velocity) > 1e-4 || std::abs(target.yaw_rate) > 1e-4);
}

bool all_contacts(const ContactVector& contacts) {
  return std::all_of(contacts.begin(), contacts.end(), [](const bool value) { return value; });
}

template <typename Callback>
class ScopeExit final {
 public:
  explicit ScopeExit(Callback callback) : callback_(std::move(callback)) {}
  ~ScopeExit() { callback_(); }
  ScopeExit(const ScopeExit&) = delete;
  ScopeExit& operator=(const ScopeExit&) = delete;

 private:
  Callback callback_;
};

template <typename Callback>
ScopeExit(Callback) -> ScopeExit<Callback>;

}  // namespace

bool Go2ConvexMpcController::initialize(const RobotState& state,
                                       const std::vector<double>& home_joint_positions,
                                       std::string& error) {
  if (!state.finite || home_joint_positions.size() != kJointCount) {
    transition_to_fault("invalid-controller-initial-state");
    error = "invalid-controller-initial-state";
    return false;
  }
  for (std::size_t index = 0; index < kJointCount; ++index) home_[static_cast<int>(index)] = home_joint_positions[index];
  body_height_ = state.base_position.z();
  initialized_ = true;
  reset(state);
  error.clear();
  return true;
}

void Go2ConvexMpcController::reset(const RobotState& state) {
  state_ = ControllerState::standing;
  state_started_ = state.simulation_time;
  body_height_ = state.base_position.z();
  consecutive_qp_failures_ = 0;
  previous_contacts_.fill(true);
  missed_contact_ticks_.fill(0);
  for (auto& force : desired_forces_) force.setZero();
  telemetry_ = ControllerTelemetry{};
  telemetry_.state = state_;
  mpc_.reset();
  gait_.reset(state.simulation_time);
  reference_.reset(body_height_);
  footholds_.initialize(state);
  touchdowns_.reset(state.contacts);
}

void Go2ConvexMpcController::force_fault(const std::string& reason) {
  transition_to_fault(reason.empty() ? "external-controller-fault" : reason);
}

#ifdef SIDECAR_TESTING
void Go2ConvexMpcController::test_force_consecutive_qp_failure() {
  consecutive_qp_failures_ = 3;
  telemetry_.qp_failure_count += 3;
  telemetry_.solver_status = "primal_infeasible";
  transition_to_fault("mpc-" + telemetry_.solver_status);
}

void Go2ConvexMpcController::test_force_non_finite_low_level_command() {
  transition_to_fault("non-finite-low-level-command");
}
#endif

void Go2ConvexMpcController::transition_to_fault(const std::string& reason) {
  state_ = ControllerState::fault;
  telemetry_.state = state_;
  telemetry_.fault_reason = reason.empty() ? "controller-fault" : reason;
  telemetry_.commanded_forward_velocity = 0.0;
  telemetry_.filtered_forward_velocity = 0.0;
  telemetry_.commanded_yaw_rate = 0.0;
  telemetry_.filtered_yaw_rate = 0.0;
  for (auto& force : desired_forces_) force.setZero();
  for (auto& force : telemetry_.desired_ground_forces) force.setZero();
}

void Go2ConvexMpcController::finalize_telemetry() {
  telemetry_.state = state_;
  if (state_ == ControllerState::fault) {
    if (telemetry_.fault_reason.empty()) telemetry_.fault_reason = "controller-fault";
  } else {
    telemetry_.fault_reason.clear();
  }
}

ContactVector Go2ConvexMpcController::expected_contacts(const RobotState& state) const {
  if (state_ == ControllerState::locomotion || state_ == ControllerState::stopping) {
    return gait_.contacts(state.simulation_time);
  }
  return ContactVector{{true, true, true, true}};
}

ContactHorizon Go2ConvexMpcController::expected_horizon(const RobotState& state) const {
  if (state_ == ControllerState::locomotion || state_ == ControllerState::stopping) {
    return gait_.contact_horizon(state.simulation_time, mpc_.config().horizon_steps, mpc_.config().node_dt);
  }
  return ContactHorizon(static_cast<std::size_t>(mpc_.config().horizon_steps),
                        ContactVector{{true, true, true, true}});
}

void Go2ConvexMpcController::start_swings(const RobotState& state, const MotionTarget& filtered,
                                         const ContactVector& contacts) {
  MotionTarget placement_target = filtered;
  if (state_ == ControllerState::stopping) {
    placement_target.forward_velocity = 0.0;
    placement_target.yaw_rate = 0.0;
  }
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    if (previous_contacts_[leg] && !contacts[leg]) {
      swings_[leg].configure(state.foot_position_world[leg],
          footholds_.plan(state, placement_target, leg, gait_.stance_duration()),
          state.simulation_time, gait_.swing_duration(), 0.05);
    }
  }
  previous_contacts_ = contacts;
}

bool Go2ConvexMpcController::update(const RobotState& state, const MotionTarget& target,
                                   const bool mpc_tick,
                                   std::array<LowLevelJointCommand, kJointCount>& commands,
                                   std::string& error) {
  const ScopeExit finalize([this] { finalize_telemetry(); });
  if (!initialized_ || !state.finite) {
    transition_to_fault("invalid-controller-state");
    error = "invalid-controller-state";
    return false;
  }
  if (state.fallen || state.out_of_bounds || state.non_foot_collision) {
    transition_to_fault(state.fallen ? "fall-detected" :
        state.out_of_bounds ? "out-of-bounds" : "non-foot-contact");
  }
  if (state_ == ControllerState::fault) {
    error = telemetry_.fault_reason.empty() ? "controller-fault" : telemetry_.fault_reason;
    return false;
  }

  const bool requested = any_command(target);
  if (state_ == ControllerState::standing && requested) {
    touchdowns_.reset(state.contacts);
    state_ = ControllerState::entering_trot;
    state_started_ = state.simulation_time;
  } else if (state_ == ControllerState::entering_trot) {
    if (!requested) {
      state_ = ControllerState::standing;
      state_started_ = state.simulation_time;
    } else if (state.simulation_time - state_started_ >= 0.30) {
      state_ = ControllerState::locomotion;
      state_started_ = state.simulation_time;
      gait_.reset(state.simulation_time);
      previous_contacts_.fill(true);
    }
  } else if (state_ == ControllerState::locomotion && !requested) {
    state_ = ControllerState::stopping;
    state_started_ = state.simulation_time;
  }

  MotionTarget filtered = reference_.update(target, 0.004);
  filtered.body_height = body_height_;
  ContactVector contacts = expected_contacts(state);
  if (state_ == ControllerState::stopping && state.simulation_time - state_started_ >= 0.15 &&
      all_contacts(contacts) && all_contacts(state.contacts) && std::abs(filtered.forward_velocity) < 0.01 &&
      std::abs(filtered.yaw_rate) < 0.02) {
    state_ = ControllerState::standing;
    state_started_ = state.simulation_time;
    contacts.fill(true);
    previous_contacts_.fill(true);
    mpc_.reset();
  }
  touchdowns_.update(state.simulation_time, contacts, state.contacts);
  const TouchdownMetrics touchdown_metrics = touchdowns_.metrics();
  telemetry_.touchdown_event_count = touchdown_metrics.touchdown_event_count;
  telemetry_.on_time_touchdown_count = touchdown_metrics.on_time_touchdown_count;
  telemetry_.late_touchdown_event_count = touchdown_metrics.late_touchdown_event_count;
  telemetry_.early_touchdown_event_count = touchdown_metrics.early_touchdown_event_count;
  telemetry_.touchdown_timeout_count = touchdown_metrics.touchdown_timeout_count;
  telemetry_.touchdown_latency_mean_ms = touchdown_metrics.touchdown_latency_mean_ms;
  telemetry_.touchdown_latency_max_ms = touchdown_metrics.touchdown_latency_max_ms;
  telemetry_.touchdown_latency_p95_ms = touchdown_metrics.touchdown_latency_p95_ms;
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    if ((state_ == ControllerState::locomotion || state_ == ControllerState::stopping) &&
        contacts[leg] && !state.contacts[leg]) {
      ++missed_contact_ticks_[leg];
      if (missed_contact_ticks_[leg] >= 25U) {
        force_fault("touchdown-timeout");
        error = telemetry_.fault_reason;
        return false;
      }
    } else {
      missed_contact_ticks_[leg] = 0;
    }
  }
  start_swings(state, filtered, contacts);

  if (mpc_tick || telemetry_.solver_count == 0) {
    const MpcSolution solution = mpc_.solve(state, filtered, expected_horizon(state));
    telemetry_.solver_status = solution.status;
    telemetry_.solver_iterations = solution.iterations;
    telemetry_.solver_max_ms = std::max(telemetry_.solver_max_ms, solution.solve_ms);
    ++telemetry_.solver_count;
    telemetry_.solver_mean_ms += (solution.solve_ms - telemetry_.solver_mean_ms) /
        static_cast<double>(telemetry_.solver_count);
    if (!solution.solved || solution.solve_ms > mpc_.config().solve_budget_ms) {
      ++telemetry_.qp_failure_count;
      ++consecutive_qp_failures_;
      telemetry_.solver_status = solution.solved ? "budget_exceeded" : solution.status;
      if (consecutive_qp_failures_ >= 3) {
        transition_to_fault("mpc-" + telemetry_.solver_status);
        error = telemetry_.fault_reason;
        return false;
      }
    } else {
      consecutive_qp_failures_ = 0;
      desired_forces_ = solution.ground_forces_world;
    }
  }

  std::array<SwingSample, kLegCount> swing_samples{};
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    if (!contacts[leg] && swings_[leg].configured()) swing_samples[leg] = swings_[leg].sample(state.simulation_time);
    else {
      swing_samples[leg].position = state.foot_position_world[leg];
      swing_samples[leg].velocity.setZero();
    }
  }
  legs_.compute(state, home_, contacts, desired_forces_, swing_samples, commands);
  for (const auto& command : commands) {
    if (!command.finite()) {
      transition_to_fault("non-finite-low-level-command");
      error = telemetry_.fault_reason;
      return false;
    }
  }

  telemetry_.state = state_;
  telemetry_.expected_contacts = contacts;
  telemetry_.desired_ground_forces = desired_forces_;
  telemetry_.commanded_forward_velocity = target.forward_velocity;
  telemetry_.filtered_forward_velocity = filtered.forward_velocity;
  telemetry_.measured_forward_velocity = state.base_linear_velocity_body.x();
  telemetry_.commanded_yaw_rate = target.yaw_rate;
  telemetry_.filtered_yaw_rate = filtered.yaw_rate;
  telemetry_.measured_yaw_rate = state.base_angular_velocity_world.z();
  telemetry_.gait_phase = (state_ == ControllerState::locomotion || state_ == ControllerState::stopping)
      ? gait_.phase(state.simulation_time) : 0.0;
  error.clear();
  return true;
}

}  // namespace sidecar::controllers::mpc

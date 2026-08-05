#include "controllers/stand_hold_controller.hpp"

#include <algorithm>
#include <cmath>

namespace sidecar::controllers {

bool StandHoldController::initialize(const RobotState& state,
                                     const std::vector<double>& home_joint_positions,
                                     std::string& error) {
  reset();
  if (!state.finite || home_joint_positions.size() != kJointCount) {
    error = "invalid-stand-initial-state";
    return false;
  }
  for (std::size_t index = 0; index < kJointCount; ++index) {
    home_joint_positions_[static_cast<int>(index)] = home_joint_positions[index];
  }
  body_height_ = state.base_position.z();
  initialized_ = true;
  error.clear();
  return true;
}

bool StandHoldController::update(const RobotState& state, const bool mpc_tick,
                                std::array<LowLevelJointCommand, kJointCount>& commands,
                                std::string& error) {
  if (!initialized_ || !state.finite) {
    error = "invalid-stand-state";
    return false;
  }
  if (state.fallen || state.out_of_bounds || state.non_foot_collision) {
    error = state.fallen ? "fall-detected" : state.out_of_bounds ? "out-of-bounds" : "non-foot-contact";
    return false;
  }
  if (mpc_tick || telemetry_.solver_count == 0) {
    const int horizon = mpc_.config().horizon_steps;
    const mpc::ContactHorizon contacts(static_cast<std::size_t>(horizon),
                                       ContactVector{{true, true, true, true}});
    const MotionTarget target{0.0, 0.0, body_height_, false};
    const MpcSolution solution = mpc_.solve(state, target, contacts);
    telemetry_.solver_status = solution.status;
    telemetry_.solver_iterations = solution.iterations;
    telemetry_.solver_max_ms = std::max(telemetry_.solver_max_ms, solution.solve_ms);
    ++telemetry_.solver_count;
    telemetry_.solver_mean_ms += (solution.solve_ms - telemetry_.solver_mean_ms) /
        static_cast<double>(telemetry_.solver_count);
    if (!solution.solved || solution.solve_ms > mpc_.config().solve_budget_ms) {
      ++telemetry_.qp_failure_count;
      error = !solution.solved ? "static-mpc-" + solution.status : "static-mpc-budget-exceeded";
      return false;
    }
    desired_forces_ = solution.ground_forces_world;
    telemetry_.desired_ground_forces = desired_forces_;
  }
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    // The centroidal QP force is ground-on-robot. The leg applies its opposite to the ground.
    const Eigen::Vector3d endpoint_force = -desired_forces_[leg];
    const Eigen::Vector3d joint_feedforward = state.foot_jacobian_world[leg].transpose() * endpoint_force;
    for (std::size_t joint = 0; joint < kJointsPerLeg; ++joint) {
      const std::size_t index = leg * kJointsPerLeg + joint;
      commands[index] = LowLevelJointCommand{home_joint_positions_[static_cast<int>(index)], 0.0,
                                              18.0, 1.2, joint_feedforward[static_cast<int>(joint)]};
      if (!commands[index].finite()) {
        error = "non-finite-stand-command";
        return false;
      }
    }
  }
  telemetry_.state = ControllerState::standing;
  error.clear();
  return true;
}

void StandHoldController::reset() {
  mpc_.reset();
  for (auto& force : desired_forces_) force.setZero();
  telemetry_ = ControllerTelemetry{};
  initialized_ = false;
}

}  // namespace sidecar::controllers

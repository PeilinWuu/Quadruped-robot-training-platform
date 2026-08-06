#include "controllers/mpc/foothold_planner.hpp"

#include <algorithm>

namespace sidecar::controllers::mpc {

void FootholdPlanner::initialize(const RobotState& state) {
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    nominal_foot_body_[leg] = state.base_rotation.transpose() *
        (state.foot_position_world[leg] - state.base_position);
  }
  initialized_ = state.finite;
}

Eigen::Vector3d FootholdPlanner::plan(const RobotState& state, const MotionTarget& target,
                                     const std::size_t leg, const double stance_duration) const {
  if (!initialized_ || leg >= kLegCount) return state.foot_position_world[std::min(leg, kLegCount - 1)];
  Eigen::Vector3d local = nominal_foot_body_[leg];
  const double measured_forward = state.base_linear_velocity_body.x();
  local.x() += target.forward_velocity * stance_duration * 0.5 +
      0.12 * (measured_forward - target.forward_velocity);
  local.x() += -target.yaw_rate * nominal_foot_body_[leg].y() * stance_duration * 0.5;
  local.y() += target.yaw_rate * nominal_foot_body_[leg].x() * stance_duration * 0.5;
  local.x() = std::clamp(local.x(), nominal_foot_body_[leg].x() - 0.10,
                         nominal_foot_body_[leg].x() + 0.10);
  local.y() = std::clamp(local.y(), nominal_foot_body_[leg].y() - 0.055,
                         nominal_foot_body_[leg].y() + 0.055);
  Eigen::Vector3d result = state.base_position + state.base_rotation * local;
  result.z() = 0.022;
  return result;
}

}  // namespace sidecar::controllers::mpc

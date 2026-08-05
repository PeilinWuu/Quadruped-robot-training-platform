#include "controllers/mpc/leg_controller.hpp"

namespace sidecar::controllers::mpc {

void LegController::compute(const RobotState& state, const JointVector& home,
                            const ContactVector& contacts, const FootVectors& ground_forces,
                            const std::array<SwingSample, kLegCount>& swing_samples,
                            std::array<LowLevelJointCommand, kJointCount>& commands) const {
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    Eigen::Vector3d endpoint_force;
    double joint_kp = 8.0;
    double joint_kd = 0.8;
    if (contacts[leg]) {
      endpoint_force = -ground_forces[leg];
    } else {
      const Eigen::Vector3d position_error = swing_samples[leg].position - state.foot_position_world[leg];
      const Eigen::Vector3d velocity_error = swing_samples[leg].velocity - state.foot_velocity_world[leg];
      endpoint_force = Eigen::Vector3d(300.0 * position_error.x() + 10.0 * velocity_error.x(),
                                      300.0 * position_error.y() + 10.0 * velocity_error.y(),
                                      420.0 * position_error.z() + 14.0 * velocity_error.z());
      joint_kp = 2.0;
      joint_kd = 0.3;
    }
    const Eigen::Vector3d joint_force = state.foot_jacobian_world[leg].transpose() * endpoint_force;
    for (std::size_t joint = 0; joint < kJointsPerLeg; ++joint) {
      const std::size_t index = leg * kJointsPerLeg + joint;
      commands[index] = LowLevelJointCommand{home[static_cast<int>(index)], 0.0, joint_kp, joint_kd,
                                              joint_force[static_cast<int>(joint)]};
    }
  }
}

}  // namespace sidecar::controllers::mpc

#include "controllers/mpc/centroidal_dynamics.hpp"

#include <algorithm>
#include <cmath>

#include <Eigen/LU>

namespace sidecar::controllers::mpc {
namespace {

Eigen::Matrix3d skew(const Eigen::Vector3d& value) {
  Eigen::Matrix3d result;
  result << 0.0, -value.z(), value.y(), value.z(), 0.0, -value.x(), -value.y(), value.x(), 0.0;
  return result;
}

Eigen::Vector3d roll_pitch_yaw(const Eigen::Matrix3d& rotation) {
  const double pitch = std::asin(std::clamp(-rotation(2, 0), -1.0, 1.0));
  const double roll = std::atan2(rotation(2, 1), rotation(2, 2));
  const double yaw = std::atan2(rotation(1, 0), rotation(0, 0));
  return {roll, pitch, yaw};
}

}  // namespace

MpcStateVector centroidal_state_vector(const RobotState& state) {
  MpcStateVector result;
  result.segment<3>(0) = roll_pitch_yaw(state.base_rotation);
  result.segment<3>(3) = state.center_of_mass;
  result.segment<3>(6) = state.base_angular_velocity_world;
  result.segment<3>(9) = state.center_of_mass_velocity;
  return result;
}

DiscreteCentroidalDynamics discretize_centroidal_dynamics(const RobotState& state, const double dt) {
  DiscreteCentroidalDynamics result;
  result.a.block<3, 3>(0, 6) = Eigen::Matrix3d::Identity() * dt;
  result.a.block<3, 3>(3, 9) = Eigen::Matrix3d::Identity() * dt;
  const Eigen::Matrix3d inertia_inverse = state.centroidal_inertia_world.inverse();
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    const Eigen::Vector3d lever = state.foot_position_world[leg] - state.center_of_mass;
    result.b.block<3, 3>(6, static_cast<int>(leg * 3)) = inertia_inverse * skew(lever) * dt;
    result.b.block<3, 3>(9, static_cast<int>(leg * 3)) =
        Eigen::Matrix3d::Identity() * (dt / state.total_mass);
  }
  result.gravity[11] = -9.81 * dt;
  return result;
}

}  // namespace sidecar::controllers::mpc

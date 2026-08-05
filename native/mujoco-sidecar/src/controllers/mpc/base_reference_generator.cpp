#include "controllers/mpc/base_reference_generator.hpp"

#include <algorithm>

namespace sidecar::controllers::mpc {
namespace {
double approach(const double value, const double target, const double maximum_delta) {
  return value + std::clamp(target - value, -maximum_delta, maximum_delta);
}
}  // namespace

MotionTarget BaseReferenceGenerator::update(const MotionTarget& command, const double dt) {
  const double forward = command.enabled ? std::clamp(command.forward_velocity, -0.20, 0.30) : 0.0;
  const double yaw = command.enabled ? std::clamp(command.yaw_rate, -0.50, 0.50) : 0.0;
  filtered_.forward_velocity = approach(filtered_.forward_velocity, forward, 0.60 * dt);
  filtered_.yaw_rate = approach(filtered_.yaw_rate, yaw, 1.50 * dt);
  filtered_.body_height = std::clamp(command.body_height, 0.24, 0.32);
  filtered_.enabled = command.enabled;
  return filtered_;
}

void BaseReferenceGenerator::reset(const double body_height) {
  filtered_ = MotionTarget{};
  filtered_.body_height = body_height;
}

}  // namespace sidecar::controllers::mpc

#pragma once

#include <array>
#include <string>
#include <vector>

#include "controllers/locomotion_types.hpp"
#include "controllers/low_level_joint_command.hpp"
#include "controllers/mpc/convex_mpc.hpp"

namespace sidecar::controllers {

class StandHoldController {
 public:
  bool initialize(const RobotState& state, const std::vector<double>& home_joint_positions,
                  std::string& error);
  bool update(const RobotState& state, bool mpc_tick,
              std::array<LowLevelJointCommand, kJointCount>& commands,
              std::string& error);
  void reset();
  [[nodiscard]] const ControllerTelemetry& telemetry() const noexcept { return telemetry_; }

 private:
  mpc::ConvexMpc mpc_;
  JointVector home_joint_positions_{JointVector::Zero()};
  FootVectors desired_forces_{};
  double body_height_{0.27};
  ControllerTelemetry telemetry_{};
  bool initialized_{false};
};

}  // namespace sidecar::controllers

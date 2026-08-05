#pragma once

#include <array>
#include <string>

#include "controllers/locomotion_types.hpp"
#include "controllers/low_level_joint_command.hpp"

namespace sidecar::controllers {

class LocomotionController {
 public:
  virtual ~LocomotionController() = default;
  virtual bool update(const RobotState& state, const MotionTarget& target, bool mpc_tick,
                      std::array<LowLevelJointCommand, kJointCount>& commands,
                      std::string& error) = 0;
  virtual void reset(const RobotState& state) = 0;
  [[nodiscard]] virtual const ControllerTelemetry& telemetry() const noexcept = 0;
};

}  // namespace sidecar::controllers

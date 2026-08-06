#pragma once

#include <array>

#include "controllers/locomotion_types.hpp"
#include "controllers/low_level_joint_command.hpp"
#include "controllers/mpc/swing_trajectory.hpp"

namespace sidecar::controllers::mpc {

class LegController {
 public:
  void compute(const RobotState& state, const JointVector& home,
               const ContactVector& contacts, const FootVectors& ground_forces,
               const std::array<SwingSample, kLegCount>& swing_samples,
               std::array<LowLevelJointCommand, kJointCount>& commands) const;
};

}  // namespace sidecar::controllers::mpc

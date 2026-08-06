#pragma once

#include "controllers/locomotion_types.hpp"

namespace sidecar::controllers::mpc {

class FootholdPlanner {
 public:
  void initialize(const RobotState& state);
  Eigen::Vector3d plan(const RobotState& state, const MotionTarget& target,
                       std::size_t leg, double stance_duration) const;

 private:
  FootVectors nominal_foot_body_{};
  bool initialized_{false};
};

}  // namespace sidecar::controllers::mpc

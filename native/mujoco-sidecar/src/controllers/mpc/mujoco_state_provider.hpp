#pragma once

#include <array>
#include <string>
#include <vector>

#include <mujoco/mujoco.h>

#include "controllers/locomotion_types.hpp"

namespace sidecar::controllers::mpc {

class MujocoStateProvider {
 public:
  bool initialize(const mjModel* model, const std::vector<int>& joint_ids,
                  const std::vector<int>& joint_qpos_addresses,
                  const std::vector<int>& joint_dof_addresses,
                  const std::vector<int>& actuator_ids,
                  const std::array<int, kLegCount>& foot_geom_ids,
                  int ground_geom_id, int root_body_id, std::string& error);
  bool update(const mjModel* model, mjData* data, bool non_foot_collision,
              bool fallen, bool out_of_bounds, RobotState& state,
              std::string& error) const;

  [[nodiscard]] bool initialized() const noexcept { return initialized_; }

 private:
  std::array<int, kJointCount> joint_ids_{};
  std::array<int, kJointCount> qpos_addresses_{};
  std::array<int, kJointCount> dof_addresses_{};
  std::array<int, kJointCount> actuator_ids_{};
  std::array<int, kLegCount> foot_geom_ids_{};
  std::array<int, kLegCount> foot_body_ids_{};
  int ground_geom_id_{-1};
  int root_body_id_{-1};
  bool initialized_{false};
};

}  // namespace sidecar::controllers::mpc

#pragma once

#include <vector>

#include "controllers/locomotion_types.hpp"
#include "controllers/mpc/mpc_config.hpp"
#include "controllers/mpc/qp_solver.hpp"

namespace sidecar::controllers::mpc {

using ContactHorizon = std::vector<ContactVector>;

class ConvexMpc {
 public:
  explicit ConvexMpc(MpcConfig config = kDefaultMpcConfig) : config_(config) {}

  MpcSolution solve(const RobotState& state, const MotionTarget& target,
                    const ContactHorizon& contacts);
  QpProblem build_problem(const RobotState& state, const MotionTarget& target,
                          const ContactHorizon& contacts) const;
  void reset();
  [[nodiscard]] const MpcConfig& config() const noexcept { return config_; }

 private:
  MpcConfig config_;
  OsqpSolver solver_;
};

}  // namespace sidecar::controllers::mpc

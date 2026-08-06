#pragma once

#include <Eigen/Core>

#include "controllers/locomotion_types.hpp"

namespace sidecar::controllers::mpc {

inline constexpr int kMpcStateSize = 12;
inline constexpr int kMpcInputSize = 12;
using MpcStateVector = Eigen::Matrix<double, kMpcStateSize, 1>;
using MpcStateMatrix = Eigen::Matrix<double, kMpcStateSize, kMpcStateSize>;
using MpcInputMatrix = Eigen::Matrix<double, kMpcStateSize, kMpcInputSize>;

struct DiscreteCentroidalDynamics {
  MpcStateMatrix a{MpcStateMatrix::Identity()};
  MpcInputMatrix b{MpcInputMatrix::Zero()};
  MpcStateVector gravity{MpcStateVector::Zero()};
};

MpcStateVector centroidal_state_vector(const RobotState& state);
DiscreteCentroidalDynamics discretize_centroidal_dynamics(const RobotState& state, double dt);

}  // namespace sidecar::controllers::mpc

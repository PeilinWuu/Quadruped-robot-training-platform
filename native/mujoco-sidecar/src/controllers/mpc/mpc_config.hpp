#pragma once

#include <array>

namespace sidecar::controllers::mpc {

struct MpcConfig {
  int horizon_steps{10};
  double node_dt{0.02};
  double friction_coefficient{0.8};
  double maximum_normal_force{120.0};
  double solve_budget_ms{15.0};
  int maximum_iterations{400};
  double absolute_tolerance{1e-3};
  double relative_tolerance{1e-3};
  std::array<double, 12> state_weights{{40.0, 40.0, 12.0, 2.0, 2.0, 80.0,
                                        1.5, 1.5, 0.8, 8.0, 8.0, 12.0}};
  double force_weight{2e-5};
  double hessian_regularization{1e-7};
};

inline constexpr MpcConfig kDefaultMpcConfig{};

}  // namespace sidecar::controllers::mpc

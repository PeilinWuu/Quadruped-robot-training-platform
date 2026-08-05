#pragma once

#include <Eigen/Core>

namespace sidecar::controllers::mpc {

struct SwingSample {
  Eigen::Vector3d position{Eigen::Vector3d::Zero()};
  Eigen::Vector3d velocity{Eigen::Vector3d::Zero()};
  Eigen::Vector3d acceleration{Eigen::Vector3d::Zero()};
};

class SwingTrajectory {
 public:
  void configure(const Eigen::Vector3d& start, const Eigen::Vector3d& target,
                 double start_time, double duration, double height);
  SwingSample sample(double simulation_time) const;
  [[nodiscard]] bool configured() const noexcept { return configured_; }

 private:
  Eigen::Vector3d start_{Eigen::Vector3d::Zero()};
  Eigen::Vector3d target_{Eigen::Vector3d::Zero()};
  double start_time_{0.0};
  double duration_{0.2};
  double height_{0.05};
  bool configured_{false};
};

}  // namespace sidecar::controllers::mpc

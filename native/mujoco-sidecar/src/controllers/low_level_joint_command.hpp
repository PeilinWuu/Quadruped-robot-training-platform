#pragma once

#include <cmath>

namespace sidecar::controllers {

struct LowLevelJointCommand {
  double q{0.0};
  double dq{0.0};
  double kp{0.0};
  double kd{0.0};
  double tau_feedforward{0.0};

  [[nodiscard]] bool finite() const noexcept {
    return std::isfinite(q) && std::isfinite(dq) && std::isfinite(kp) &&
           std::isfinite(kd) && std::isfinite(tau_feedforward) && kp >= 0.0 && kd >= 0.0;
  }
};

}  // namespace sidecar::controllers

#include "controllers/mpc/swing_trajectory.hpp"

#include <algorithm>

namespace sidecar::controllers::mpc {
namespace {
struct Quintic { double p; double v; double a; };
Quintic quintic(const double phase, const double duration) {
  const double t = std::clamp(phase, 0.0, 1.0);
  const double t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  return {10.0 * t3 - 15.0 * t4 + 6.0 * t5,
          (30.0 * t2 - 60.0 * t3 + 30.0 * t4) / duration,
          (60.0 * t - 180.0 * t2 + 120.0 * t3) / (duration * duration)};
}
}  // namespace

void SwingTrajectory::configure(const Eigen::Vector3d& start, const Eigen::Vector3d& target,
                                const double start_time, const double duration, const double height) {
  start_ = start;
  target_ = target;
  start_time_ = start_time;
  duration_ = std::max(duration, 0.05);
  height_ = std::clamp(height, 0.02, 0.08);
  configured_ = start.array().isFinite().all() && target.array().isFinite().all();
}

SwingSample SwingTrajectory::sample(const double simulation_time) const {
  SwingSample result;
  if (!configured_) return result;
  const double phase = std::clamp((simulation_time - start_time_) / duration_, 0.0, 1.0);
  const Quintic horizontal = quintic(phase, duration_);
  result.position = start_ + horizontal.p * (target_ - start_);
  result.velocity = horizontal.v * (target_ - start_);
  result.acceleration = horizontal.a * (target_ - start_);
  const bool rising = phase < 0.5;
  const double half_phase = rising ? phase * 2.0 : (phase - 0.5) * 2.0;
  const Quintic vertical = quintic(half_phase, duration_ * 0.5);
  const double apex = std::max(start_.z(), target_.z()) + height_;
  const double z0 = rising ? start_.z() : apex;
  const double z1 = rising ? apex : target_.z();
  result.position.z() = z0 + vertical.p * (z1 - z0);
  result.velocity.z() = vertical.v * (z1 - z0);
  result.acceleration.z() = vertical.a * (z1 - z0);
  return result;
}

}  // namespace sidecar::controllers::mpc

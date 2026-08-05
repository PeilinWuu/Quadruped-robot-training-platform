#pragma once

#include "controllers/locomotion_types.hpp"
#include "controllers/mpc/convex_mpc.hpp"

namespace sidecar::controllers::mpc {

class GaitGenerator {
 public:
  GaitGenerator(double frequency_hz = 2.2, double duty_factor = 0.65)
      : frequency_hz_(frequency_hz), duty_factor_(duty_factor) {}

  void reset(double simulation_time);
  ContactVector contacts(double simulation_time) const;
  ContactHorizon contact_horizon(double simulation_time, int steps, double dt) const;
  [[nodiscard]] double phase(double simulation_time) const;
  [[nodiscard]] double leg_phase(double simulation_time, std::size_t leg) const;
  [[nodiscard]] double swing_progress(double simulation_time, std::size_t leg) const;
  [[nodiscard]] double stance_duration() const noexcept { return duty_factor_ / frequency_hz_; }
  [[nodiscard]] double swing_duration() const noexcept { return (1.0 - duty_factor_) / frequency_hz_; }
  [[nodiscard]] double frequency_hz() const noexcept { return frequency_hz_; }
  [[nodiscard]] double duty_factor() const noexcept { return duty_factor_; }

 private:
  double start_time_{0.0};
  double frequency_hz_{2.2};
  double duty_factor_{0.65};
};

}  // namespace sidecar::controllers::mpc

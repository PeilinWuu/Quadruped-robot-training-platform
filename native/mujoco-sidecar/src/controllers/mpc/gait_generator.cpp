#include "controllers/mpc/gait_generator.hpp"

#include <algorithm>
#include <cmath>

namespace sidecar::controllers::mpc {

void GaitGenerator::reset(const double simulation_time) { start_time_ = simulation_time; }

double GaitGenerator::phase(const double simulation_time) const {
  const double cycles = std::max(0.0, simulation_time - start_time_) * frequency_hz_;
  return cycles - std::floor(cycles);
}

double GaitGenerator::leg_phase(const double simulation_time, const std::size_t leg) const {
  const double offset = (leg == 1 || leg == 2) ? 0.5 : 0.0;  // FR+RL opposite FL+RR.
  const double value = phase(simulation_time) + offset;
  return value - std::floor(value);
}

ContactVector GaitGenerator::contacts(const double simulation_time) const {
  ContactVector result{};
  for (std::size_t leg = 0; leg < kLegCount; ++leg) result[leg] = leg_phase(simulation_time, leg) < duty_factor_;
  return result;
}

ContactHorizon GaitGenerator::contact_horizon(const double simulation_time, const int steps,
                                              const double dt) const {
  ContactHorizon result;
  result.reserve(static_cast<std::size_t>(std::max(0, steps)));
  for (int step = 0; step < steps; ++step) result.push_back(contacts(simulation_time + step * dt));
  return result;
}

double GaitGenerator::swing_progress(const double simulation_time, const std::size_t leg) const {
  return std::clamp((leg_phase(simulation_time, leg) - duty_factor_) / (1.0 - duty_factor_), 0.0, 1.0);
}

}  // namespace sidecar::controllers::mpc

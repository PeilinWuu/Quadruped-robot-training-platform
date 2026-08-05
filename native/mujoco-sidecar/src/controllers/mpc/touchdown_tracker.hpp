#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "controllers/locomotion_types.hpp"

namespace sidecar::controllers::mpc {

struct TouchdownMetrics {
  std::uint64_t touchdown_event_count{0};
  std::uint64_t on_time_touchdown_count{0};
  std::uint64_t late_touchdown_event_count{0};
  std::uint64_t early_touchdown_event_count{0};
  std::uint64_t touchdown_timeout_count{0};
  double touchdown_latency_mean_ms{0.0};
  double touchdown_latency_max_ms{0.0};
  double touchdown_latency_p95_ms{0.0};
  std::size_t latency_sample_count{0};
};

class TouchdownTracker {
 public:
  static constexpr unsigned int kDebounceSamples = 2;
  static constexpr double kOnTimeToleranceSeconds = 0.012;
  static constexpr double kTimeoutSeconds = 0.100;
  static constexpr std::size_t kLatencyCapacity = 128;

  void reset(const ContactVector& actual_contacts = ContactVector{{true, true, true, true}});
  void update(double simulation_time, const ContactVector& expected_contacts,
              const ContactVector& actual_contacts);
  [[nodiscard]] TouchdownMetrics metrics() const;

 private:
  struct LegState {
    bool previous_expected_contact{true};
    bool debounced_actual_contact{true};
    bool debounce_candidate{true};
    unsigned int debounce_count{0};
    double debounce_started_at{0.0};
    bool event_active{false};
    bool expected_touchdown_seen{false};
    bool early_contact_seen{false};
    double early_contact_time{0.0};
    double expected_touchdown_time{0.0};
  };

  void finalize_latency(double latency_seconds);
  void finalize_timeout();
  void add_latency_sample(double latency_ms);

  std::array<LegState, kLegCount> legs_{};
  std::array<double, kLatencyCapacity> latency_samples_{};
  std::size_t latency_sample_count_{0};
  std::size_t latency_next_{0};
  std::uint64_t touchdown_event_count_{0};
  std::uint64_t on_time_touchdown_count_{0};
  std::uint64_t late_touchdown_event_count_{0};
  std::uint64_t early_touchdown_event_count_{0};
  std::uint64_t touchdown_timeout_count_{0};
};

}  // namespace sidecar::controllers::mpc

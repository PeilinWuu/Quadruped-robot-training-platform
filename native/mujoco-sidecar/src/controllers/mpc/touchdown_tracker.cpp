#include "controllers/mpc/touchdown_tracker.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace sidecar::controllers::mpc {

void TouchdownTracker::reset(const ContactVector& actual_contacts) {
  legs_ = {};
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    legs_[leg].previous_expected_contact = true;
    legs_[leg].debounced_actual_contact = actual_contacts[leg];
    legs_[leg].debounce_candidate = actual_contacts[leg];
  }
  latency_samples_.fill(0.0);
  latency_sample_count_ = 0;
  latency_next_ = 0;
  touchdown_event_count_ = 0;
  on_time_touchdown_count_ = 0;
  late_touchdown_event_count_ = 0;
  early_touchdown_event_count_ = 0;
  touchdown_timeout_count_ = 0;
}

void TouchdownTracker::update(const double simulation_time,
                              const ContactVector& expected_contacts,
                              const ContactVector& actual_contacts) {
  if (!std::isfinite(simulation_time)) return;
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    auto& state = legs_[leg];
    bool contact_rising = false;
    double contact_rising_time = simulation_time;
    const bool actual = actual_contacts[leg];
    if (actual == state.debounced_actual_contact) {
      state.debounce_candidate = actual;
      state.debounce_count = 0;
    } else if (actual != state.debounce_candidate || state.debounce_count == 0) {
      state.debounce_candidate = actual;
      state.debounce_count = 1;
      state.debounce_started_at = simulation_time;
    } else if (++state.debounce_count >= kDebounceSamples) {
      state.debounced_actual_contact = actual;
      state.debounce_count = 0;
      contact_rising = actual;
      contact_rising_time = state.debounce_started_at;
    }

    const bool expected = expected_contacts[leg];
    if (state.previous_expected_contact && !expected) {
      state.event_active = true;
      state.expected_touchdown_seen = false;
      state.early_contact_seen = false;
    }
    if (!state.previous_expected_contact && expected && state.event_active) {
      state.expected_touchdown_seen = true;
      state.expected_touchdown_time = simulation_time;
      if (state.early_contact_seen) {
        finalize_latency(state.early_contact_time - state.expected_touchdown_time);
        state.event_active = false;
      }
    }

    if (contact_rising && state.event_active) {
      if (!expected) {
        if (!state.early_contact_seen) {
          state.early_contact_seen = true;
          state.early_contact_time = contact_rising_time;
        }
      } else if (state.expected_touchdown_seen) {
        finalize_latency(contact_rising_time - state.expected_touchdown_time);
        state.event_active = false;
      }
    }

    if (state.event_active && state.expected_touchdown_seen &&
        simulation_time - state.expected_touchdown_time >= kTimeoutSeconds) {
      finalize_timeout();
      state.event_active = false;
    }
    state.previous_expected_contact = expected;
  }
}

void TouchdownTracker::finalize_latency(const double latency_seconds) {
  const double latency_ms = latency_seconds * 1000.0;
  if (!std::isfinite(latency_ms)) return;
  ++touchdown_event_count_;
  if (latency_seconds < -kOnTimeToleranceSeconds) {
    ++early_touchdown_event_count_;
  } else if (latency_seconds > kOnTimeToleranceSeconds) {
    ++late_touchdown_event_count_;
  } else {
    ++on_time_touchdown_count_;
  }
  add_latency_sample(latency_ms);
}

void TouchdownTracker::finalize_timeout() {
  ++touchdown_event_count_;
  ++touchdown_timeout_count_;
}

void TouchdownTracker::add_latency_sample(const double latency_ms) {
  latency_samples_[latency_next_] = latency_ms;
  latency_next_ = (latency_next_ + 1) % kLatencyCapacity;
  latency_sample_count_ = std::min(latency_sample_count_ + 1, kLatencyCapacity);
}

TouchdownMetrics TouchdownTracker::metrics() const {
  TouchdownMetrics result;
  result.touchdown_event_count = touchdown_event_count_;
  result.on_time_touchdown_count = on_time_touchdown_count_;
  result.late_touchdown_event_count = late_touchdown_event_count_;
  result.early_touchdown_event_count = early_touchdown_event_count_;
  result.touchdown_timeout_count = touchdown_timeout_count_;
  result.latency_sample_count = latency_sample_count_;
  if (latency_sample_count_ == 0) return result;
  std::vector<double> sorted;
  sorted.reserve(latency_sample_count_);
  double sum = 0.0;
  for (std::size_t index = 0; index < latency_sample_count_; ++index) {
    const double value = latency_samples_[index];
    sorted.push_back(value);
    sum += value;
  }
  std::sort(sorted.begin(), sorted.end());
  result.touchdown_latency_mean_ms = sum / static_cast<double>(latency_sample_count_);
  result.touchdown_latency_max_ms = sorted.back();
  const std::size_t p95_index = static_cast<std::size_t>(
      std::ceil(0.95 * static_cast<double>(sorted.size()))) - 1;
  result.touchdown_latency_p95_ms = sorted[std::min(p95_index, sorted.size() - 1)];
  return result;
}

}  // namespace sidecar::controllers::mpc

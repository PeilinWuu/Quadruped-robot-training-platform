#include "simulation.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>

#include <nlohmann/json.hpp>

namespace {
using Json = nlohmann::json;
int checks = 0;
void expect(const bool value, const char* name) {
  ++checks;
  if (!value) {
    std::cerr << "FAILED: " << name << '\n';
    std::exit(1);
  }
}
}

int main() {
  sidecar::SimulationEngine engine(TEST_RESOURCE_ROOT, [](Json) {});
  expect(engine.load_model("unitree-go2-menagerie").ok, "integration Go2 loads");
  expect(engine.reset().ok, "standing reset");
  for (int second = 0; second < 10; ++second) {
    expect(engine.step(500).ok, "standing advances one second");
  }
  const Json standing = engine.test_static_mpc_diagnostics();
  std::cout << "D6_LINUX_STANDING_10S=" << standing << '\n';
  expect(standing["controllerState"] == "standing", "standing remains standing");
  expect(!standing["collision"]["isFallen"].get<bool>() &&
             standing["collision"]["torsoContacts"].get<int>() == 0 &&
             standing["collision"]["headContacts"].get<int>() == 0,
         "standing no fall torso or head contact");
  expect(standing["actuatorSaturationCount"].get<std::uint64_t>() == 0,
         "standing has no actuator saturation");
  expect(standing["qpFailureCount"].get<std::uint64_t>() == 0,
         "standing has no QP failure");
  for (int repeat = 0; repeat < 3; ++repeat) {
    expect(engine.reset().ok, "trot repeat reset");
    sidecar::MotionCommand trot{static_cast<std::uint32_t>(1000 + repeat * 1000),
        sidecar::MotionMode::locomotion, 0.001, 0.0, 0.0, 0.30, 500};
    int diagonal_a_swing = 0;
    int diagonal_b_swing = 0;
    int all_stance = 0;
    int actual_a_swing = 0;
    int actual_b_swing = 0;
    int contact_samples = 0;
    int contact_matches = 0;
    for (int sample = 0; sample < 200; ++sample) {
      trot.sequence = static_cast<std::uint32_t>(1000 + repeat * 1000 + sample);
      expect(engine.set_motion_command(trot).ok, "trot heartbeat accepted");
      expect(engine.step(50).ok, "trot advances 100ms");
      const Json diagnostic = engine.test_static_mpc_diagnostics();
      const auto expected_contacts = diagnostic["expectedContacts"];
      const auto actual_contacts = diagnostic["actualContacts"];
      const bool fl = expected_contacts[0], fr = expected_contacts[1];
      const bool rl = expected_contacts[2], rr = expected_contacts[3];
      expect(fl == rr && fr == rl, "trot diagonal contact pairing");
      if (!fl && fr) ++diagonal_a_swing;
      else if (fl && !fr) ++diagonal_b_swing;
      else if (fl && fr) ++all_stance;
      for (int leg = 0; leg < 4; ++leg) {
        ++contact_samples;
        if (expected_contacts[leg] == actual_contacts[leg]) ++contact_matches;
      }
      if (!actual_contacts[0].get<bool>() && !actual_contacts[3].get<bool>()) ++actual_a_swing;
      if (!actual_contacts[1].get<bool>() && !actual_contacts[2].get<bool>()) ++actual_b_swing;
      expect(diagnostic["fault"].is_null(), "trot controller remains fault free");
      expect(diagnostic["qpFailureCount"].get<std::uint64_t>() == 0, "trot QP remains available");
    }
    const Json result = engine.test_static_mpc_diagnostics();
    std::cout << "D5V_MPC_TROT_20S_REPEAT_" << repeat << '=' << result
              << " CONTACT_MATCH=" << static_cast<double>(contact_matches) / contact_samples
              << " A_SWING=" << diagonal_a_swing << " B_SWING=" << diagonal_b_swing
              << " ACTUAL_A_SWING=" << actual_a_swing << " ACTUAL_B_SWING=" << actual_b_swing
              << " ALL_STANCE=" << all_stance << '\n';
    expect(diagonal_a_swing > 20 && diagonal_b_swing > 20 && all_stance > 10,
           "trot exercises both diagonal swings and overlap");
    expect(static_cast<double>(contact_matches) / contact_samples > 0.55,
           "trot expected and actual contacts broadly agree");
    expect(actual_a_swing > 10 && actual_b_swing > 10,
           "trot produces real diagonal flight contacts");
    expect(result["controllerState"] == "locomotion", "trot remains in locomotion");
    expect(!result["collision"]["isFallen"].get<bool>() &&
           result["collision"]["torsoContacts"].get<int>() == 0 &&
           result["collision"]["headContacts"].get<int>() == 0,
           "trot no fall torso or head contact");
    expect(result["actuatorSaturationCount"].get<std::uint64_t>() < 1000,
           "trot actuator saturation bounded");
    const std::uint64_t touchdown_total =
        result["touchdownEventCount"].get<std::uint64_t>();
    const std::uint64_t touchdown_outcomes =
        result["onTimeTouchdownCount"].get<std::uint64_t>() +
        result["lateTouchdownEventCount"].get<std::uint64_t>() +
        result["earlyTouchdownEventCount"].get<std::uint64_t>() +
        result["touchdownTimeoutCount"].get<std::uint64_t>();
    expect(touchdown_total >= 140 && touchdown_total <= 200 &&
               touchdown_total == touchdown_outcomes,
           "trot touchdown events follow gait cycles rather than controller ticks");
    expect(result["touchdownTimeoutCount"].get<std::uint64_t>() == 0,
           "trot touchdown diagnostics have no timeout");
    expect(std::isfinite(result["touchdownLatencyMeanMs"].get<double>()) &&
               std::isfinite(result["touchdownLatencyMaxMs"].get<double>()) &&
               std::isfinite(result["touchdownLatencyP95Ms"].get<double>()),
           "trot touchdown latency diagnostics finite");
  }
  std::cout << "D5V_MPC_INTEGRATION_CHECKS=" << checks << '\n';
  return 0;
}

#include "simulation.hpp"

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>

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

double yaw(const Json& diagnostic) {
  const auto q = diagnostic["rootQuaternion"];
  const double w = q[0], x = q[1], y = q[2], z = q[3];
  return std::atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
}

double wrapped_delta(const double end, const double start) {
  constexpr double kPi = 3.14159265358979323846;
  double result = end - start;
  while (result > kPi) result -= 2.0 * kPi;
  while (result < -kPi) result += 2.0 * kPi;
  return result;
}

struct Result {
  double dx{0.0};
  double dy{0.0};
  double yaw_delta{0.0};
  double stable_average_velocity{0.0};
  double stop_time{0.0};
  double stop_distance{0.0};
  double minimum_height{std::numeric_limits<double>::infinity()};
  double maximum_abs_roll{0.0};
  double maximum_abs_pitch{0.0};
  Json final;
};

Result run(sidecar::SimulationEngine& engine, const double forward, const double yaw_rate,
           const double duration, std::uint32_t sequence) {
  if (!engine.reset().ok) std::exit(2);
  engine.step(500);
  const Json initial = engine.test_static_mpc_diagnostics();
  sidecar::MotionCommand command{sequence, sidecar::MotionMode::locomotion,
      forward, 0.0, yaw_rate, 0.30, 500};
  const int samples = static_cast<int>(std::round(duration * 10.0));
  double velocity_sum = 0.0;
  int velocity_count = 0;
  double minimum_height = initial["collision"]["rootHeightAboveFloor"].get<double>();
  double maximum_abs_roll = std::abs(initial["collision"]["roll"].get<double>());
  double maximum_abs_pitch = std::abs(initial["collision"]["pitch"].get<double>());
  for (int sample = 0; sample < samples; ++sample) {
    command.sequence = sequence++;
    if (!engine.set_motion_command(command).ok || !engine.step(50).ok) std::exit(3);
    const Json current = engine.test_static_mpc_diagnostics();
    minimum_height = std::min(minimum_height,
        current["collision"]["rootHeightAboveFloor"].get<double>());
    maximum_abs_roll = std::max(maximum_abs_roll,
        std::abs(current["collision"]["roll"].get<double>()));
    maximum_abs_pitch = std::max(maximum_abs_pitch,
        std::abs(current["collision"]["pitch"].get<double>()));
    if (sample >= 50) {
      velocity_sum += current["measuredForwardVelocity"].get<double>();
      ++velocity_count;
    }
  }
  const Json at_clear = engine.test_static_mpc_diagnostics();
  if (!engine.clear_motion_command().ok) std::exit(4);
  double stop_time = 0.0;
  Json stopped = at_clear;
  for (int sample = 0; sample < 50; ++sample) {
    if (!engine.step(10).ok) std::exit(5);
    stop_time += 0.02;
    stopped = engine.test_static_mpc_diagnostics();
    minimum_height = std::min(minimum_height,
        stopped["collision"]["rootHeightAboveFloor"].get<double>());
    maximum_abs_roll = std::max(maximum_abs_roll,
        std::abs(stopped["collision"]["roll"].get<double>()));
    maximum_abs_pitch = std::max(maximum_abs_pitch,
        std::abs(stopped["collision"]["pitch"].get<double>()));
    if (stopped["controllerState"] == "standing") break;
  }
  Result result;
  result.dx = at_clear["rootPosition"][0].get<double>() - initial["rootPosition"][0].get<double>();
  result.dy = at_clear["rootPosition"][1].get<double>() - initial["rootPosition"][1].get<double>();
  result.yaw_delta = wrapped_delta(yaw(at_clear), yaw(initial));
  result.stable_average_velocity = velocity_count ? velocity_sum / velocity_count : 0.0;
  result.stop_time = stop_time;
  result.stop_distance = std::hypot(stopped["rootPosition"][0].get<double>() - at_clear["rootPosition"][0].get<double>(),
                                    stopped["rootPosition"][1].get<double>() - at_clear["rootPosition"][1].get<double>());
  result.minimum_height = minimum_height;
  result.maximum_abs_roll = maximum_abs_roll;
  result.maximum_abs_pitch = maximum_abs_pitch;
  result.final = stopped;
  return result;
}

void print(const char* name, const Result& result) {
  std::cout << name << " DX=" << result.dx << " DY=" << result.dy
            << " YAW=" << result.yaw_delta << " STABLE_V=" << result.stable_average_velocity
            << " STOP_T=" << result.stop_time << " STOP_D=" << result.stop_distance
            << " MIN_H=" << result.minimum_height << " MAX_ROLL=" << result.maximum_abs_roll
            << " MAX_PITCH=" << result.maximum_abs_pitch
            << " FINAL=" << result.final << '\n';
}
}  // namespace

int main() {
  sidecar::SimulationEngine engine(TEST_RESOURCE_ROOT, [](Json) {});
  expect(engine.load_model("unitree-go2-menagerie").ok, "acceptance Go2 loads");
  for (int repeat = 0; repeat < 3; ++repeat) {
    const std::uint32_t base = static_cast<std::uint32_t>(repeat * 100000);
    const Result forward = run(engine, 0.15, 0.0, 20.0, base + 10000);
    const Result reverse = run(engine, -0.10, 0.0, 12.0, base + 20000);
    const Result left = run(engine, 0.0, 0.30, 8.0, base + 30000);
    const Result right = run(engine, 0.0, -0.30, 8.0, base + 40000);
    const Result left_arc = run(engine, 0.08, 0.15, 30.0, base + 50000);
    const Result right_arc = run(engine, 0.08, -0.15, 30.0, base + 60000);
    print(("D5V_MPC_FORWARD_REPEAT_" + std::to_string(repeat)).c_str(), forward);
    print(("D5V_MPC_REVERSE_REPEAT_" + std::to_string(repeat)).c_str(), reverse);
    print(("D5V_MPC_LEFT_REPEAT_" + std::to_string(repeat)).c_str(), left);
    print(("D5V_MPC_RIGHT_REPEAT_" + std::to_string(repeat)).c_str(), right);
    print(("D5V_MPC_LEFT_ARC_REPEAT_" + std::to_string(repeat)).c_str(), left_arc);
    print(("D5V_MPC_RIGHT_ARC_REPEAT_" + std::to_string(repeat)).c_str(), right_arc);
    expect(forward.dx > 1.0 && forward.stable_average_velocity > 0.06,
           "forward displacement and stable velocity acceptance");
    expect(reverse.dx < -0.35 && reverse.stable_average_velocity < 0.0,
           "reverse displacement and direction acceptance");
    expect(left.yaw_delta > 0.5, "left yaw acceptance");
    expect(right.yaw_delta < -0.5, "right yaw acceptance");
    expect(left_arc.dx > 0.35 && left_arc.yaw_delta > 0.4,
           "forward-left arc acceptance");
    expect(right_arc.dx > 0.35 && right_arc.yaw_delta < -0.4,
           "forward-right arc acceptance");
    for (const Result* arc : {&left_arc, &right_arc}) {
      expect(arc->minimum_height > 0.24 && arc->maximum_abs_roll < 0.09 &&
                 arc->maximum_abs_pitch < 0.09,
             "long arc posture remains bounded throughout motion");
    }
    for (const Result* result : {&forward, &reverse, &left, &right, &left_arc, &right_arc}) {
      expect(result->stop_time <= 1.0 && result->stop_distance < 0.10,
             "bounded stop time and distance");
      expect(result->final["controllerState"] == "standing", "stop returns standing");
      expect(result->final["actualContacts"] == Json::array({true, true, true, true}),
             "stop returns four-foot support");
      expect(result->final["fault"].is_null() &&
             result->final["qpFailureCount"].get<std::uint64_t>() == 0,
             "acceptance controller fault free");
      const std::uint64_t touchdown_total =
          result->final["touchdownEventCount"].get<std::uint64_t>();
      const std::uint64_t touchdown_outcomes =
          result->final["onTimeTouchdownCount"].get<std::uint64_t>() +
          result->final["lateTouchdownEventCount"].get<std::uint64_t>() +
          result->final["earlyTouchdownEventCount"].get<std::uint64_t>() +
          result->final["touchdownTimeoutCount"].get<std::uint64_t>();
      expect(touchdown_total > 0 && touchdown_total < 300 &&
                 touchdown_total == touchdown_outcomes,
             "touchdown diagnostics count one outcome per gait event");
      expect(result->final["touchdownTimeoutCount"].get<std::uint64_t>() == 0 &&
                 result->final["lateTouchdownEventCount"].get<std::uint64_t>() <= touchdown_total,
             "touchdown diagnostics have no tick-accumulated late count or timeout");
      expect(std::isfinite(result->final["touchdownLatencyMeanMs"].get<double>()) &&
                 std::isfinite(result->final["touchdownLatencyMaxMs"].get<double>()) &&
                 std::isfinite(result->final["touchdownLatencyP95Ms"].get<double>()),
             "touchdown latency diagnostics are finite");
      expect(!result->final["collision"]["isFallen"].get<bool>() &&
             result->final["collision"]["torsoContacts"].get<int>() == 0 &&
             result->final["collision"]["headContacts"].get<int>() == 0,
             "acceptance no fall torso or head contact");
    }
  }
  std::cout << "D5V_MPC_ACCEPTANCE_CHECKS=" << checks << '\n';
  return 0;
}

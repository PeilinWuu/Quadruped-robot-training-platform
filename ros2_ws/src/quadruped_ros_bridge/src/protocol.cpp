#include "quadruped_ros_bridge/protocol.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <unordered_set>

namespace quadruped_ros_bridge {
namespace {

template <std::size_t Size>
std::array<double, Size> numeric_array(const nlohmann::json& value, const char* field) {
  if (!value.is_array() || value.size() != Size) {
    throw std::invalid_argument(std::string("invalid array: ") + field);
  }
  std::array<double, Size> result{};
  for (std::size_t index = 0; index < Size; ++index) {
    result[index] = value.at(index).get<double>();
    if (!std::isfinite(result[index])) {
      throw std::invalid_argument(std::string("non-finite value: ") + field);
    }
  }
  return result;
}

using Quaternion = std::array<double, 4>;  // w, x, y, z

Quaternion multiply(const Quaternion& left, const Quaternion& right) {
  return {
      left[0] * right[0] - left[1] * right[1] - left[2] * right[2] - left[3] * right[3],
      left[0] * right[1] + left[1] * right[0] + left[2] * right[3] - left[3] * right[2],
      left[0] * right[2] - left[1] * right[3] + left[2] * right[0] + left[3] * right[1],
      left[0] * right[3] + left[1] * right[2] - left[2] * right[1] + left[3] * right[0],
  };
}

std::array<double, 4> normalized_xyzw(const Quaternion& value) {
  const double norm = std::sqrt(value[0] * value[0] + value[1] * value[1] +
                                value[2] * value[2] + value[3] * value[3]);
  if (!(norm > 0.0) || !std::isfinite(norm)) {
    throw std::invalid_argument("invalid quaternion");
  }
  return {value[1] / norm, value[2] / norm, value[3] / norm, value[0] / norm};
}

}  // namespace

InputFrame parse_input_frame(const std::string& line) {
  if (line.empty() || line.size() > kMaxFrameBytes) {
    throw std::invalid_argument("invalid frame size");
  }
  const auto value = nlohmann::json::parse(line);
  if (!value.is_object() || value.value("protocolVersion", 0U) != kProtocolVersion ||
      !value.contains("payload") || !value.at("payload").is_object()) {
    throw std::invalid_argument("invalid protocol envelope");
  }
  const auto type = value.value("type", std::string{});
  const auto kind = type == "configure"       ? InputKind::configure
                    : type == "control_enable" ? InputKind::control_enable
                    : type == "telemetry"      ? InputKind::telemetry
                    : type == "shutdown"       ? InputKind::shutdown
                                                : throw std::invalid_argument("unknown frame type");
  return InputFrame{kind, value.at("payload")};
}

TelemetrySample parse_telemetry(const nlohmann::json& payload) {
  TelemetrySample result;
  result.sequence = payload.at("sequence").get<std::uint32_t>();
  result.source_wall_time_ms = payload.value("wallTime", std::int64_t{0});
  const auto& root = payload.at("root");
  const auto& imu = payload.at("imu");
  const auto& locomotion = payload.at("locomotion");
  result.position = output_to_ros_vector(numeric_array<3>(root.at("position"), "root.position"));
  result.orientation =
      output_to_ros_quaternion(numeric_array<4>(root.at("orientation"), "root.orientation"));
  result.linear_velocity_world = output_to_ros_vector(
      numeric_array<3>(root.at("linearVelocityWorld"), "root.linearVelocityWorld"));
  result.angular_velocity_world = output_to_ros_vector(
      numeric_array<3>(root.at("angularVelocityWorld"), "root.angularVelocityWorld"));
  result.imu_angular_velocity_body =
      numeric_array<3>(imu.at("angularVelocityBody"), "imu.angularVelocityBody");
  result.imu_linear_acceleration_body =
      numeric_array<3>(imu.at("linearAccelerationBody"), "imu.linearAccelerationBody");
  result.controller_state = locomotion.at("state").get<std::string>();
  if (result.controller_state.empty() || result.controller_state.size() > 32U) {
    throw std::invalid_argument("invalid controller state");
  }
  if (!locomotion.at("faultReason").is_null()) {
    result.controller_fault = locomotion.at("faultReason").get<std::string>();
    if (result.controller_fault->empty() || result.controller_fault->size() > 128U) {
      throw std::invalid_argument("invalid controller fault");
    }
  }
  const auto& joints = payload.at("joints");
  if (!joints.is_array() || joints.size() != 12U) {
    throw std::invalid_argument("invalid joint count");
  }
  std::unordered_set<std::string> names;
  result.joints.reserve(joints.size());
  for (const auto& joint : joints) {
    JointSample sample{
        joint.at("name").get<std::string>(), joint.at("position").get<double>(),
        joint.at("velocity").get<double>(), joint.at("actuatorTorque").get<double>()};
    if (sample.name.empty() || sample.name.size() > 64U || !names.insert(sample.name).second ||
        !std::isfinite(sample.position) || !std::isfinite(sample.velocity) ||
        !std::isfinite(sample.effort)) {
      throw std::invalid_argument("invalid joint telemetry");
    }
    result.joints.push_back(std::move(sample));
  }
  return result;
}

nlohmann::json output_frame(const std::string& type, nlohmann::json payload) {
  return {{"protocolVersion", kProtocolVersion}, {"type", type}, {"payload", std::move(payload)}};
}

nlohmann::json protocol_error_frame(const std::string& code, const std::string& message,
                                    const bool recoverable) {
  return output_frame("protocol_error",
                      {{"code", code}, {"message", message}, {"recoverable", recoverable}});
}

std::array<double, 3> output_to_ros_vector(const std::array<double, 3>& value) {
  return {value[0], -value[2], value[1]};
}

std::array<double, 4> output_to_ros_quaternion(const std::array<double, 4>& value) {
  constexpr double c = 0.7071067811865475244;
  const Quaternion output{value[3], value[0], value[1], value[2]};
  const Quaternion output_to_ros{c, c, 0.0, 0.0};
  const Quaternion ros_to_output{c, -c, 0.0, 0.0};
  return normalized_xyzw(multiply(multiply(output_to_ros, output), ros_to_output));
}

std::array<double, 3> world_to_body_vector(const std::array<double, 3>& world,
                                           const std::array<double, 4>& orientation) {
  const Quaternion q{orientation[3], orientation[0], orientation[1], orientation[2]};
  const Quaternion inverse{q[0], -q[1], -q[2], -q[3]};
  const Quaternion vector{0.0, world[0], world[1], world[2]};
  const auto rotated = multiply(multiply(inverse, vector), q);
  return {rotated[1], rotated[2], rotated[3]};
}

CommandWatchdog::CommandWatchdog(const std::chrono::milliseconds timeout) : timeout_(timeout) {}

void CommandWatchdog::configure(const std::chrono::milliseconds timeout) {
  if (timeout < std::chrono::milliseconds(250) || timeout > std::chrono::milliseconds(500)) {
    throw std::invalid_argument("watchdog must be between 250 and 500 ms");
  }
  timeout_ = timeout;
}

void CommandWatchdog::set_enabled(const bool enabled,
                                  const std::chrono::steady_clock::time_point) {
  enabled_ = enabled;
  triggered_ = false;
  last_command_.reset();
}

void CommandWatchdog::observe(const std::chrono::steady_clock::time_point now) {
  if (!enabled_) {
    return;
  }
  last_command_ = now;
  triggered_ = false;
}

bool CommandWatchdog::poll(const std::chrono::steady_clock::time_point now) {
  if (!enabled_ || triggered_ || !last_command_.has_value() || now - *last_command_ <= timeout_) {
    return false;
  }
  triggered_ = true;
  return true;
}

std::optional<std::uint64_t> CommandWatchdog::age_ms(
    const std::chrono::steady_clock::time_point now) const {
  if (!last_command_.has_value()) {
    return std::nullopt;
  }
  return std::chrono::duration_cast<std::chrono::milliseconds>(now - *last_command_).count();
}

bool CommandWatchdog::enabled() const { return enabled_; }
bool CommandWatchdog::triggered() const { return triggered_; }

}  // namespace quadruped_ros_bridge

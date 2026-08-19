#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace quadruped_ros_bridge {

inline constexpr std::uint32_t kProtocolVersion = 1;
inline constexpr std::size_t kMaxFrameBytes = 256U * 1024U;
inline constexpr std::chrono::milliseconds kDefaultWatchdog{300};

enum class InputKind { configure, control_enable, telemetry, shutdown };

struct InputFrame {
  InputKind kind;
  nlohmann::json payload;
};

struct JointSample {
  std::string name;
  double position{};
  double velocity{};
  double effort{};
};

struct TelemetrySample {
  std::uint32_t sequence{};
  std::int64_t source_wall_time_ms{};
  std::array<double, 3> position{};
  std::array<double, 4> orientation{};
  std::array<double, 3> linear_velocity_world{};
  std::array<double, 3> angular_velocity_world{};
  std::array<double, 3> imu_angular_velocity_body{};
  std::array<double, 3> imu_linear_acceleration_body{};
  std::vector<JointSample> joints;
  std::string controller_state;
  std::optional<std::string> controller_fault;
};

InputFrame parse_input_frame(const std::string& line);
TelemetrySample parse_telemetry(const nlohmann::json& payload);
nlohmann::json output_frame(const std::string& type, nlohmann::json payload);
nlohmann::json protocol_error_frame(const std::string& code, const std::string& message,
                                    bool recoverable);

std::array<double, 3> output_to_ros_vector(const std::array<double, 3>& value);
std::array<double, 4> output_to_ros_quaternion(const std::array<double, 4>& value);
std::array<double, 3> world_to_body_vector(const std::array<double, 3>& world,
                                           const std::array<double, 4>& orientation);

class CommandWatchdog {
 public:
  explicit CommandWatchdog(std::chrono::milliseconds timeout = kDefaultWatchdog);
  void configure(std::chrono::milliseconds timeout);
  void set_enabled(bool enabled, std::chrono::steady_clock::time_point now);
  void observe(std::chrono::steady_clock::time_point now);
  bool poll(std::chrono::steady_clock::time_point now);
  std::optional<std::uint64_t> age_ms(std::chrono::steady_clock::time_point now) const;
  bool enabled() const;
  bool triggered() const;

 private:
  std::chrono::milliseconds timeout_;
  bool enabled_{false};
  bool triggered_{false};
  std::optional<std::chrono::steady_clock::time_point> last_command_;
};

}  // namespace quadruped_ros_bridge

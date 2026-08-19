#pragma once

#include "quadruped_ros_bridge/protocol.hpp"

#include <condition_variable>
#include <atomic>
#include <chrono>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <geometry_msgs/msg/twist.hpp>
#include <nav_msgs/msg/odometry.hpp>
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/imu.hpp>
#include <sensor_msgs/msg/joint_state.hpp>
#include <std_msgs/msg/string.hpp>

namespace quadruped_ros_bridge {

class StdoutWriter {
 public:
  StdoutWriter();
  ~StdoutWriter();
  StdoutWriter(const StdoutWriter&) = delete;
  StdoutWriter& operator=(const StdoutWriter&) = delete;
  void send(const nlohmann::json& frame);

 private:
  void run();
  std::mutex mutex_;
  std::condition_variable changed_;
  std::condition_variable space_available_;
  std::deque<std::string> queue_;
  bool stopping_{false};
  std::thread thread_;
};

class BridgeNode final : public rclcpp::Node {
 public:
  explicit BridgeNode(std::shared_ptr<StdoutWriter> writer);
  void handle_frame(const InputFrame& frame);
  void diagnostic_frame_received();
  void diagnostic_frame_parsed();
  void diagnostic_frame_dropped();
  void diagnostic_parse_error();

 private:
  void handle_cmd_vel(const geometry_msgs::msg::Twist::SharedPtr message);
  void on_timer();
  void publish_telemetry(const TelemetrySample& sample);
  void emit_status();
  void emit_zero(const std::string& type, std::optional<std::uint64_t> age_ms);
  void emit_diagnostic_summary(std::chrono::steady_clock::time_point now);

  std::shared_ptr<StdoutWriter> writer_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_vel_subscription_;
  rclcpp::Publisher<sensor_msgs::msg::JointState>::SharedPtr joint_states_publisher_;
  rclcpp::Publisher<sensor_msgs::msg::Imu>::SharedPtr imu_publisher_;
  rclcpp::Publisher<nav_msgs::msg::Odometry>::SharedPtr odom_publisher_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr controller_state_publisher_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr fault_publisher_;
  rclcpp::TimerBase::SharedPtr timer_;
  std::mutex state_mutex_;
  CommandWatchdog watchdog_;
  std::optional<TelemetrySample> latest_telemetry_;
  std::optional<std::uint32_t> last_published_telemetry_sequence_;
  std::uint32_t command_sequence_{0};
  std::chrono::steady_clock::time_point last_status_emit_{};
  // D6_ROS_PERF_DIAGNOSTIC: default-off, bounded 1 Hz counters only.
  bool diagnostic_enabled_{false};
  std::chrono::steady_clock::time_point diagnostic_started_{};
  std::chrono::steady_clock::time_point diagnostic_last_emit_{};
  std::atomic<std::uint64_t> diagnostic_frames_received_{0};
  std::atomic<std::uint64_t> diagnostic_frames_parsed_{0};
  std::atomic<std::uint64_t> diagnostic_frames_dropped_{0};
  std::atomic<std::uint64_t> diagnostic_parse_errors_{0};
  std::atomic<std::uint64_t> diagnostic_telemetry_received_{0};
  std::atomic<std::uint64_t> diagnostic_telemetry_coalesced_{0};
  std::atomic<std::uint64_t> diagnostic_joint_published_{0};
  std::atomic<std::uint64_t> diagnostic_imu_published_{0};
  std::atomic<std::uint64_t> diagnostic_odom_published_{0};
  std::atomic<std::uint32_t> diagnostic_latest_received_sequence_{0};
  std::atomic<std::uint32_t> diagnostic_latest_published_sequence_{0};
  std::mutex diagnostic_age_mutex_;
  std::vector<std::uint64_t> diagnostic_age_samples_ms_;
  std::uint64_t diagnostic_last_received_count_{0};
  std::uint64_t diagnostic_last_joint_count_{0};
  std::uint64_t diagnostic_last_imu_count_{0};
  std::uint64_t diagnostic_last_odom_count_{0};
};

}  // namespace quadruped_ros_bridge

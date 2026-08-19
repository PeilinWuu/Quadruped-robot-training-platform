#include "quadruped_ros_bridge/bridge_node.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <numeric>
#include <utility>

namespace quadruped_ros_bridge {
namespace {

constexpr std::size_t kMaxQueuedOutputFrames = 256U;

void assign_xyz(geometry_msgs::msg::Vector3& destination, const std::array<double, 3>& source) {
  destination.x = source[0];
  destination.y = source[1];
  destination.z = source[2];
}

void assign_quaternion(geometry_msgs::msg::Quaternion& destination,
                       const std::array<double, 4>& source) {
  destination.x = source[0];
  destination.y = source[1];
  destination.z = source[2];
  destination.w = source[3];
}

}  // namespace

StdoutWriter::StdoutWriter() : thread_([this] { run(); }) {}

StdoutWriter::~StdoutWriter() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  changed_.notify_all();
  space_available_.notify_all();
  if (thread_.joinable()) {
    thread_.join();
  }
}

void StdoutWriter::send(const nlohmann::json& frame) {
  auto line = frame.dump();
  std::unique_lock<std::mutex> lock(mutex_);
  space_available_.wait(lock, [this] { return stopping_ || queue_.size() < kMaxQueuedOutputFrames; });
  if (stopping_) {
    return;
  }
  queue_.push_back(std::move(line));
  changed_.notify_one();
}

void StdoutWriter::run() {
  for (;;) {
    std::string line;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      changed_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (queue_.empty() && stopping_) {
        return;
      }
      line = std::move(queue_.front());
      queue_.pop_front();
      space_available_.notify_one();
    }
    std::cout << line << '\n';
    std::cout.flush();
  }
}

BridgeNode::BridgeNode(std::shared_ptr<StdoutWriter> writer)
    : Node("quadruped_ros_bridge"), writer_(std::move(writer)) {
  const auto* diagnostic = std::getenv("D6_ROS_PERF_DIAGNOSTIC");
  diagnostic_enabled_ = diagnostic != nullptr && std::string(diagnostic) == "1";
  diagnostic_started_ = std::chrono::steady_clock::now();
  diagnostic_last_emit_ = diagnostic_started_;
  diagnostic_age_samples_ms_.reserve(64U);
  cmd_vel_subscription_ = create_subscription<geometry_msgs::msg::Twist>(
      "/cmd_vel", rclcpp::QoS(10),
      [this](geometry_msgs::msg::Twist::SharedPtr message) { handle_cmd_vel(std::move(message)); });
  joint_states_publisher_ = create_publisher<sensor_msgs::msg::JointState>("/joint_states", 10);
  imu_publisher_ = create_publisher<sensor_msgs::msg::Imu>("/imu", 10);
  odom_publisher_ = create_publisher<nav_msgs::msg::Odometry>("/odom", 10);
  controller_state_publisher_ =
      create_publisher<std_msgs::msg::String>("/quadruped/controller_state", 10);
  fault_publisher_ = create_publisher<std_msgs::msg::String>("/quadruped/fault", 10);
  timer_ = create_wall_timer(std::chrono::milliseconds(20), [this] { on_timer(); });
  last_status_emit_ = std::chrono::steady_clock::now();
}

void BridgeNode::diagnostic_frame_received() {
  if (diagnostic_enabled_) {
    ++diagnostic_frames_received_;
  }
}

void BridgeNode::diagnostic_frame_parsed() {
  if (diagnostic_enabled_) {
    ++diagnostic_frames_parsed_;
  }
}

void BridgeNode::diagnostic_frame_dropped() {
  if (diagnostic_enabled_) {
    ++diagnostic_frames_dropped_;
  }
}

void BridgeNode::diagnostic_parse_error() {
  if (diagnostic_enabled_) {
    ++diagnostic_parse_errors_;
  }
}

void BridgeNode::handle_frame(const InputFrame& frame) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(state_mutex_);
  switch (frame.kind) {
    case InputKind::configure: {
      const auto timeout = std::chrono::milliseconds(frame.payload.value("watchdogMs", 300));
      watchdog_.configure(timeout);
      watchdog_.set_enabled(frame.payload.value("controlEnabled", false), now);
      emit_status();
      break;
    }
    case InputKind::control_enable:
      watchdog_.set_enabled(frame.payload.at("enabled").get<bool>(), now);
      if (!watchdog_.enabled()) {
        emit_zero("watchdog_zero", std::nullopt);
      }
      emit_status();
      break;
    case InputKind::telemetry: {
      auto sample = parse_telemetry(frame.payload);
        if (diagnostic_enabled_) {
          if (latest_telemetry_.has_value() &&
              last_published_telemetry_sequence_ != latest_telemetry_->sequence) {
            ++diagnostic_telemetry_coalesced_;
          }
          ++diagnostic_telemetry_received_;
          diagnostic_latest_received_sequence_.store(sample.sequence);
          const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count();
          const auto age_ms = sample.source_wall_time_ms > 0 && now_ms > sample.source_wall_time_ms
                                  ? static_cast<std::uint64_t>(now_ms - sample.source_wall_time_ms)
                                  : 0U;
          std::lock_guard<std::mutex> diagnostic_lock(diagnostic_age_mutex_);
          diagnostic_age_samples_ms_.push_back(age_ms);
        }
        latest_telemetry_ = std::move(sample);
      break;
    }
    case InputKind::shutdown:
      rclcpp::shutdown();
      break;
  }
}

void BridgeNode::handle_cmd_vel(const geometry_msgs::msg::Twist::SharedPtr message) {
  if (!std::isfinite(message->linear.x) || !std::isfinite(message->linear.y) ||
      !std::isfinite(message->angular.z)) {
    writer_->send(protocol_error_frame("NON_FINITE_CMD_VEL", "/cmd_vel contains NaN or Inf", true));
    return;
  }
  if (std::abs(message->linear.y) > 1e-9) {
    RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000,
                         "/cmd_vel linear.y is not supported and is clamped to zero");
  }
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(state_mutex_);
  if (!watchdog_.enabled()) {
    return;
  }
  watchdog_.observe(now);
  ++command_sequence_;
  writer_->send(output_frame(
      "cmd_vel", {{"sequence", command_sequence_},
                  {"forwardVelocity", std::clamp(message->linear.x, -0.20, 0.30)},
                  {"yawRate", std::clamp(message->angular.z, -0.50, 0.50)}}));
}

void BridgeNode::on_timer() {
  const auto now_steady = std::chrono::steady_clock::now();
  std::optional<TelemetrySample> telemetry;
  {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (latest_telemetry_.has_value() &&
        last_published_telemetry_sequence_ != latest_telemetry_->sequence) {
      telemetry = latest_telemetry_;
      last_published_telemetry_sequence_ = latest_telemetry_->sequence;
    }
    if (watchdog_.poll(now_steady)) {
      emit_zero("watchdog_zero", watchdog_.age_ms(now_steady));
      emit_status();
    }
    if (now_steady - last_status_emit_ >= std::chrono::seconds(1)) {
      emit_status();
      last_status_emit_ = now_steady;
    }
  }
  if (telemetry.has_value()) {
    publish_telemetry(*telemetry);
  }
  emit_diagnostic_summary(now_steady);
}

void BridgeNode::publish_telemetry(const TelemetrySample& sample) {
  const auto stamp = now();
  sensor_msgs::msg::JointState joints;
  joints.header.stamp = stamp;
  joints.name.reserve(sample.joints.size());
  joints.position.reserve(sample.joints.size());
  joints.velocity.reserve(sample.joints.size());
  joints.effort.reserve(sample.joints.size());
  for (const auto& joint : sample.joints) {
    joints.name.push_back(joint.name);
    joints.position.push_back(joint.position);
    joints.velocity.push_back(joint.velocity);
    joints.effort.push_back(joint.effort);
  }
  joint_states_publisher_->publish(joints);
  if (diagnostic_enabled_) {
    ++diagnostic_joint_published_;
  }

  sensor_msgs::msg::Imu imu;
  imu.header.stamp = stamp;
  imu.header.frame_id = "base_link";
  assign_quaternion(imu.orientation, sample.orientation);
  assign_xyz(imu.angular_velocity, sample.imu_angular_velocity_body);
  assign_xyz(imu.linear_acceleration, sample.imu_linear_acceleration_body);
  imu_publisher_->publish(imu);
  if (diagnostic_enabled_) {
    ++diagnostic_imu_published_;
  }

  nav_msgs::msg::Odometry odom;
  odom.header.stamp = stamp;
  odom.header.frame_id = "odom";
  odom.child_frame_id = "base_link";
  odom.pose.pose.position.x = sample.position[0];
  odom.pose.pose.position.y = sample.position[1];
  odom.pose.pose.position.z = sample.position[2];
  assign_quaternion(odom.pose.pose.orientation, sample.orientation);
  assign_xyz(odom.twist.twist.linear,
             world_to_body_vector(sample.linear_velocity_world, sample.orientation));
  assign_xyz(odom.twist.twist.angular,
             world_to_body_vector(sample.angular_velocity_world, sample.orientation));
  odom_publisher_->publish(odom);
  if (diagnostic_enabled_) {
    ++diagnostic_odom_published_;
    diagnostic_latest_published_sequence_.store(sample.sequence);
  }

  std_msgs::msg::String controller_state;
  controller_state.data = sample.controller_state;
  controller_state_publisher_->publish(controller_state);
  std_msgs::msg::String fault;
  fault.data = sample.controller_fault.value_or("");
  fault_publisher_->publish(fault);
}

void BridgeNode::emit_diagnostic_summary(const std::chrono::steady_clock::time_point now) {
  if (!diagnostic_enabled_ || now - diagnostic_last_emit_ < std::chrono::seconds(1)) {
    return;
  }
  std::vector<std::uint64_t> ages;
  {
    std::lock_guard<std::mutex> lock(diagnostic_age_mutex_);
    ages.swap(diagnostic_age_samples_ms_);
  }
  std::sort(ages.begin(), ages.end());
  const auto age_total = std::accumulate(ages.begin(), ages.end(), std::uint64_t{0});
  const auto age_mean = ages.empty() ? 0U : age_total / ages.size();
  const auto age_p95 = ages.empty() ? 0U : ages[((ages.size() * 95U + 99U) / 100U) - 1U];
  const auto age_max = ages.empty() ? 0U : ages.back();
  const auto elapsed = std::chrono::duration<double>(now - diagnostic_last_emit_).count();
  const auto received = diagnostic_telemetry_received_.load();
  const auto joint = diagnostic_joint_published_.load();
  const auto imu = diagnostic_imu_published_.load();
  const auto odom = diagnostic_odom_published_.load();
  std::cerr << "D6_ROS_PERF_DIAGNOSTIC component=bridge"
            << " time_s=" << std::chrono::duration<double>(now - diagnostic_started_).count()
            << " frames_received=" << diagnostic_frames_received_.load()
            << " frames_parsed=" << diagnostic_frames_parsed_.load()
            << " frames_dropped=" << diagnostic_frames_dropped_.load()
            << " parse_errors=" << diagnostic_parse_errors_.load()
            << " telemetry_receive_hz=" << (received - diagnostic_last_received_count_) / elapsed
            << " telemetry_received=" << received
            << " telemetry_coalesced=" << diagnostic_telemetry_coalesced_.load()
            << " latest_slot_current=" << (diagnostic_latest_received_sequence_.load() != 0U ? 1 : 0)
            << " latest_slot_max=1"
            << " input_age_mean_ms=" << age_mean
            << " input_age_p95_ms=" << age_p95
            << " input_age_max_ms=" << age_max
            << " joint_publish_hz=" << (joint - diagnostic_last_joint_count_) / elapsed
            << " imu_publish_hz=" << (imu - diagnostic_last_imu_count_) / elapsed
            << " odom_publish_hz=" << (odom - diagnostic_last_odom_count_) / elapsed
            << " joint_publish_count=" << joint
            << " imu_publish_count=" << imu
            << " odom_publish_count=" << odom
            << " latest_received_sequence=" << diagnostic_latest_received_sequence_.load()
            << " latest_published_sequence=" << diagnostic_latest_published_sequence_.load()
            << '\n';
  diagnostic_last_received_count_ = received;
  diagnostic_last_joint_count_ = joint;
  diagnostic_last_imu_count_ = imu;
  diagnostic_last_odom_count_ = odom;
  diagnostic_last_emit_ = now;
}

void BridgeNode::emit_status() {
  const auto now_steady = std::chrono::steady_clock::now();
  nlohmann::json age = nullptr;
  if (const auto value = watchdog_.age_ms(now_steady); value.has_value()) {
    age = *value;
  }
  writer_->send(output_frame(
      "bridge_status", {{"controlEnabled", watchdog_.enabled()},
                        {"lastCmdVelAgeMs", age},
                        {"watchdogState", watchdog_.triggered() ? "triggered"
                                             : watchdog_.age_ms(now_steady).has_value() ? "armed"
                                                                                       : "idle"}}));
}

void BridgeNode::emit_zero(const std::string& type, const std::optional<std::uint64_t> age_ms) {
  nlohmann::json age = age_ms.has_value() ? nlohmann::json(*age_ms) : nlohmann::json(nullptr);
  writer_->send(output_frame(type, {{"forwardVelocity", 0.0},
                                    {"yawRate", 0.0},
                                    {"lastCmdVelAgeMs", age}}));
}

}  // namespace quadruped_ros_bridge

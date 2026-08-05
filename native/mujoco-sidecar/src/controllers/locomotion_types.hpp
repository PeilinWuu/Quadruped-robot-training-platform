#pragma once

#include <array>
#include <cstdint>
#include <string>

#include <Eigen/Core>
#include <Eigen/Geometry>

namespace sidecar::controllers {

inline constexpr std::size_t kLegCount = 4;
inline constexpr std::size_t kJointsPerLeg = 3;
inline constexpr std::size_t kJointCount = kLegCount * kJointsPerLeg;
inline constexpr std::array<const char*, kLegCount> kLegNames{{"FL", "FR", "RL", "RR"}};
inline constexpr std::array<const char*, kJointCount> kGo2JointNames{{
    "FL_hip_joint", "FL_thigh_joint", "FL_calf_joint",
    "FR_hip_joint", "FR_thigh_joint", "FR_calf_joint",
    "RL_hip_joint", "RL_thigh_joint", "RL_calf_joint",
    "RR_hip_joint", "RR_thigh_joint", "RR_calf_joint"}};

enum class ControllerState { standing, entering_trot, locomotion, stopping, fault };

inline const char* controller_state_name(const ControllerState state) noexcept {
  switch (state) {
    case ControllerState::standing: return "standing";
    case ControllerState::entering_trot: return "entering_trot";
    case ControllerState::locomotion: return "locomotion";
    case ControllerState::stopping: return "stopping";
    case ControllerState::fault: return "fault";
  }
  return "fault";
}

using JointVector = Eigen::Matrix<double, static_cast<int>(kJointCount), 1>;
using ContactVector = std::array<bool, kLegCount>;
using FootVectors = std::array<Eigen::Vector3d, kLegCount>;
using FootJacobians = std::array<Eigen::Matrix3d, kLegCount>;

struct MotionTarget {
  double forward_velocity{0.0};
  double yaw_rate{0.0};
  double body_height{0.27};
  bool enabled{false};
};

struct RobotState {
  RobotState() {
    for (auto& value : foot_position_world) value.setZero();
    for (auto& value : foot_velocity_world) value.setZero();
    for (auto& value : actual_contact_force_world) value.setZero();
    for (auto& value : foot_jacobian_world) value.setZero();
  }
  double simulation_time{0.0};
  Eigen::Vector3d base_position{Eigen::Vector3d::Zero()};
  Eigen::Quaterniond base_orientation{Eigen::Quaterniond::Identity()};
  Eigen::Matrix3d base_rotation{Eigen::Matrix3d::Identity()};
  Eigen::Vector3d base_linear_velocity_world{Eigen::Vector3d::Zero()};
  Eigen::Vector3d base_linear_velocity_body{Eigen::Vector3d::Zero()};
  Eigen::Vector3d base_angular_velocity_world{Eigen::Vector3d::Zero()};
  Eigen::Vector3d base_angular_velocity_body{Eigen::Vector3d::Zero()};
  Eigen::Vector3d center_of_mass{Eigen::Vector3d::Zero()};
  Eigen::Vector3d center_of_mass_velocity{Eigen::Vector3d::Zero()};
  Eigen::Matrix3d centroidal_inertia_world{Eigen::Matrix3d::Identity()};
  double total_mass{0.0};
  JointVector joint_position{JointVector::Zero()};
  JointVector joint_velocity{JointVector::Zero()};
  FootVectors foot_position_world{};
  FootVectors foot_velocity_world{};
  FootVectors actual_contact_force_world{};
  FootJacobians foot_jacobian_world{};
  ContactVector contacts{{false, false, false, false}};
  bool non_foot_collision{false};
  bool fallen{false};
  bool out_of_bounds{false};
  bool finite{false};
};

struct MpcSolution {
  MpcSolution() { for (auto& force : ground_forces_world) force.setZero(); }
  FootVectors ground_forces_world{};
  std::string status{"not_run"};
  int iterations{0};
  double solve_ms{0.0};
  bool solved{false};
};

struct ControllerTelemetry {
  ControllerTelemetry() {
    for (auto& force : desired_ground_forces) force.setZero();
  }
  ControllerState state{ControllerState::standing};
  ContactVector expected_contacts{{true, true, true, true}};
  FootVectors desired_ground_forces{};
  double commanded_forward_velocity{0.0};
  double filtered_forward_velocity{0.0};
  double measured_forward_velocity{0.0};
  double commanded_yaw_rate{0.0};
  double filtered_yaw_rate{0.0};
  double measured_yaw_rate{0.0};
  double gait_phase{0.0};
  std::string solver_status{"not_run"};
  int solver_iterations{0};
  double solver_mean_ms{0.0};
  double solver_max_ms{0.0};
  std::uint64_t solver_count{0};
  std::uint64_t qp_failure_count{0};
  std::uint64_t joint_limit_clip_count{0};
  std::uint64_t actuator_saturation_count{0};
  std::uint64_t touchdown_event_count{0};
  std::uint64_t on_time_touchdown_count{0};
  std::uint64_t late_touchdown_event_count{0};
  std::uint64_t early_touchdown_event_count{0};
  std::uint64_t touchdown_timeout_count{0};
  double touchdown_latency_mean_ms{0.0};
  double touchdown_latency_max_ms{0.0};
  double touchdown_latency_p95_ms{0.0};
  std::string fault_reason;
};

}  // namespace sidecar::controllers

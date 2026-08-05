#pragma once

#include <array>
#include <vector>

#include "controllers/locomotion_controller.hpp"
#include "controllers/mpc/base_reference_generator.hpp"
#include "controllers/mpc/convex_mpc.hpp"
#include "controllers/mpc/foothold_planner.hpp"
#include "controllers/mpc/gait_generator.hpp"
#include "controllers/mpc/leg_controller.hpp"
#include "controllers/mpc/swing_trajectory.hpp"
#include "controllers/mpc/touchdown_tracker.hpp"

namespace sidecar::controllers::mpc {

class Go2ConvexMpcController final : public LocomotionController {
 public:
  bool initialize(const RobotState& state, const std::vector<double>& home_joint_positions,
                  std::string& error);
  bool update(const RobotState& state, const MotionTarget& target, bool mpc_tick,
              std::array<LowLevelJointCommand, kJointCount>& commands,
              std::string& error) override;
  void reset(const RobotState& state) override;
  void force_fault(const std::string& reason);
  [[nodiscard]] const ControllerTelemetry& telemetry() const noexcept override { return telemetry_; }
  [[nodiscard]] double gait_frequency_hz() const noexcept { return gait_.frequency_hz(); }
  [[nodiscard]] double duty_factor() const noexcept { return gait_.duty_factor(); }

 private:
  ContactVector expected_contacts(const RobotState& state) const;
  ContactHorizon expected_horizon(const RobotState& state) const;
  void start_swings(const RobotState& state, const MotionTarget& filtered,
                    const ContactVector& contacts);

  ConvexMpc mpc_;
  GaitGenerator gait_{};
  BaseReferenceGenerator reference_;
  FootholdPlanner footholds_;
  LegController legs_;
  TouchdownTracker touchdowns_;
  std::array<SwingTrajectory, kLegCount> swings_{};
  ContactVector previous_contacts_{{true, true, true, true}};
  std::array<unsigned int, kLegCount> missed_contact_ticks_{};
  FootVectors desired_forces_{};
  JointVector home_{JointVector::Zero()};
  ControllerTelemetry telemetry_{};
  ControllerState state_{ControllerState::standing};
  double state_started_{0.0};
  double body_height_{0.27};
  int consecutive_qp_failures_{0};
  bool initialized_{false};
};

}  // namespace sidecar::controllers::mpc

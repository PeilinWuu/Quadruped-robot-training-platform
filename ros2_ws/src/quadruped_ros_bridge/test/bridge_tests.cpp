#include "quadruped_ros_bridge/protocol.hpp"

#include <chrono>
#include <cmath>
#include <string>

#include <gtest/gtest.h>

namespace bridge = quadruped_ros_bridge;
using namespace std::chrono_literals;

TEST(Protocol, ParsesConfigureAndRejectsWrongVersion) {
  const auto frame = bridge::parse_input_frame(
      R"({"protocolVersion":1,"type":"configure","payload":{"controlEnabled":false,"watchdogMs":300}})");
  EXPECT_EQ(frame.kind, bridge::InputKind::configure);
  EXPECT_THROW(bridge::parse_input_frame(
                   R"({"protocolVersion":2,"type":"configure","payload":{}})"),
               std::invalid_argument);
}

TEST(Protocol, RejectsInvalidJsonUnknownTypeAndOversizedFrames) {
  EXPECT_THROW(bridge::parse_input_frame("{"), nlohmann::json::exception);
  EXPECT_THROW(bridge::parse_input_frame(
                   R"({"protocolVersion":1,"type":"other","payload":{}})"),
               std::invalid_argument);
  EXPECT_THROW(bridge::parse_input_frame(std::string(bridge::kMaxFrameBytes + 1U, 'x')),
               std::invalid_argument);
}

TEST(Protocol, TelemetryPreservesValidatedJointOrderAndConvertsWorldAxes) {
  const std::array<const char*, 12> names{
      "FL_hip_joint", "FL_thigh_joint", "FL_calf_joint", "FR_hip_joint",
      "FR_thigh_joint", "FR_calf_joint", "RL_hip_joint", "RL_thigh_joint",
      "RL_calf_joint", "RR_hip_joint", "RR_thigh_joint", "RR_calf_joint"};
  nlohmann::json joints = nlohmann::json::array();
  for (std::size_t index = 0; index < names.size(); ++index) {
    joints.push_back({{"name", names[index]},
                      {"position", static_cast<double>(index)},
                      {"velocity", 0.1},
                      {"actuatorTorque", 0.2}});
  }
  const auto sample = bridge::parse_telemetry({
      {"sequence", 5},
      {"root", {{"position", {1.0, 3.0, -2.0}},
                {"orientation", {0.0, 0.0, 0.0, 1.0}},
                {"linearVelocityWorld", {0.1, 0.3, -0.2}},
                {"angularVelocityWorld", {0.4, 0.6, -0.5}}}},
      {"imu", {{"angularVelocityBody", {0.1, 0.2, 0.3}},
               {"linearAccelerationBody", {1.0, 2.0, 3.0}}}},
      {"locomotion", {{"state", "standing"}, {"faultReason", nullptr}}},
      {"joints", joints},
  });
  ASSERT_EQ(sample.joints.size(), 12U);
  for (std::size_t index = 0; index < names.size(); ++index) {
    EXPECT_EQ(sample.joints[index].name, names[index]);
    EXPECT_DOUBLE_EQ(sample.joints[index].position, static_cast<double>(index));
  }
  EXPECT_EQ(sample.position, (std::array<double, 3>{1.0, 2.0, 3.0}));
  EXPECT_EQ(sample.linear_velocity_world, (std::array<double, 3>{0.1, 0.2, 0.3}));
}

TEST(Coordinates, InvertsViewerYUpMapping) {
  EXPECT_EQ(bridge::output_to_ros_vector({1.0, 3.0, -2.0}),
            (std::array<double, 3>{1.0, 2.0, 3.0}));
  const auto identity = bridge::output_to_ros_quaternion({0.0, 0.0, 0.0, 1.0});
  EXPECT_NEAR(identity[0], 0.0, 1e-12);
  EXPECT_NEAR(identity[1], 0.0, 1e-12);
  EXPECT_NEAR(identity[2], 0.0, 1e-12);
  EXPECT_NEAR(identity[3], 1.0, 1e-12);
}

TEST(Coordinates, ConvertsPositiveRosYawAndWorldTwist) {
  constexpr double half = 0.7071067811865475244;
  // MuJoCo +90 degree Z yaw appears around the viewer's +Y axis.
  const auto yaw = bridge::output_to_ros_quaternion({0.0, half, 0.0, half});
  EXPECT_NEAR(yaw[2], half, 1e-12);
  EXPECT_NEAR(yaw[3], half, 1e-12);
  const auto body = bridge::world_to_body_vector({0.0, 1.0, 0.0}, yaw);
  EXPECT_NEAR(body[0], 1.0, 1e-12);
  EXPECT_NEAR(body[1], 0.0, 1e-12);
  EXPECT_NEAR(body[2], 0.0, 1e-12);
}

TEST(Watchdog, ZerosOnceAfterConfiguredDeadline) {
  bridge::CommandWatchdog watchdog(300ms);
  const auto start = std::chrono::steady_clock::time_point{};
  watchdog.set_enabled(true, start);
  EXPECT_FALSE(watchdog.poll(start + 1s));
  watchdog.observe(start);
  EXPECT_FALSE(watchdog.poll(start + 300ms));
  EXPECT_TRUE(watchdog.poll(start + 301ms));
  EXPECT_TRUE(watchdog.triggered());
  EXPECT_FALSE(watchdog.poll(start + 600ms));
  watchdog.observe(start + 700ms);
  EXPECT_FALSE(watchdog.triggered());
}

TEST(Watchdog, DisableClearsCommandAgeAndValidatesRange) {
  bridge::CommandWatchdog watchdog;
  const auto start = std::chrono::steady_clock::time_point{};
  watchdog.set_enabled(true, start);
  watchdog.observe(start);
  watchdog.set_enabled(false, start + 1ms);
  EXPECT_FALSE(watchdog.age_ms(start + 2ms).has_value());
  EXPECT_THROW(watchdog.configure(200ms), std::invalid_argument);
  EXPECT_THROW(watchdog.configure(501ms), std::invalid_argument);
}

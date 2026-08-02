#include "protocol.hpp"
#include "simulation.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

namespace {
using Json = nlohmann::json;
int checks = 0;
void expect(bool value, const char* name) {
  ++checks;
  if (!value) { std::cerr << "FAILED: " << name << '\n'; std::exit(1); }
}
bool finite_pose(const Json& pose) {
  if (!pose.is_object()) return false;
  for (const auto& value : pose["rootPosition"]) if (!std::isfinite(value.get<double>())) return false;
  for (const auto& value : pose["rootOrientation"]) if (!std::isfinite(value.get<double>())) return false;
  for (const auto& joint : pose["joints"]) if (!std::isfinite(joint["position"].get<double>())) return false;
  return std::isfinite(pose["simulationTime"].get<double>());
}
std::string command(const char* id, const char* type, Json payload) {
  return Json{{"protocolVersion", 1}, {"requestId", id}, {"type", type}, {"timestamp", 1}, {"payload", std::move(payload)}}.dump();
}
}

int main() {
  expect(mjVERSION_HEADER == 3011000 && mj_version() == mjVERSION_HEADER, "header runtime version");
  std::mutex events_mutex;
  std::vector<Json> events;
  sidecar::SimulationEngine engine(TEST_RESOURCE_ROOT, [&](Json pose) { std::lock_guard lock(events_mutex); events.push_back(std::move(pose)); });
  expect(!engine.start().ok, "start unloaded rejected");
  expect(!engine.load_model("unknown").ok, "unknown model rejected");
  const auto loaded = engine.load_model("minimal-quadruped-v1");
  expect(loaded.ok, "minimal model loads");
  expect(loaded.payload["jointCount"] == 12, "12 joints");
  expect(loaded.payload["actuatorCount"] == 12, "12 actuators");
  expect(std::abs(loaded.payload["timestep"].get<double>() - 0.002) < 1e-12, "fixed timestep");
  const Json initial = engine.latest_pose();
  expect(finite_pose(initial), "initial pose finite");
  expect(initial["joints"].size() == 12, "pose joint count");
  const auto q = initial["rootOrientation"];
  const double qnorm = std::sqrt(q[0].get<double>() * q[0].get<double>() + q[1].get<double>() * q[1].get<double>() + q[2].get<double>() * q[2].get<double>() + q[3].get<double>() * q[3].get<double>());
  expect(std::abs(qnorm - 1.0) < 1e-12, "quaternion normalized");
  const auto position = sidecar::convert_position({1.0, 2.0, 3.0});
  expect(position == std::array<double, 3>{1.0, 3.0, -2.0}, "position conversion");
  const auto identity = sidecar::convert_quaternion_wxyz({1.0, 0.0, 0.0, 0.0});
  expect(std::abs(identity[0]) < 1e-12 && std::abs(identity[1]) < 1e-12 && std::abs(identity[2]) < 1e-12 && std::abs(identity[3] - 1.0) < 1e-12, "quaternion conversion identity");
  expect(!engine.step(0).ok && !engine.step(1001).ok, "step bounds");
  const auto one = engine.step(1);
  expect(one.ok && std::abs(one.payload["simulationTime"].get<double>() - 0.002) < 1e-10, "step one exact");
  engine.reset();
  const auto hundred = engine.step(100);
  expect(hundred.ok && std::abs(hundred.payload["simulationTime"].get<double>() - 0.2) < 1e-9, "step 100 exact");
  engine.reset(); const auto deterministic_a = engine.step(100).payload;
  engine.reset(); const auto deterministic_b = engine.step(100).payload;
  expect(deterministic_a["rootPosition"] == deterministic_b["rootPosition"] && deterministic_a["joints"] == deterministic_b["joints"], "deterministic steps");
  engine.reset();
  for (int index = 0; index < 5; ++index) expect(finite_pose(engine.step(1000).payload), "thousands stable");
  expect(engine.latest_pose().dump().size() < sidecar::kMaxLineBytes, "pose under line limit");
  expect(engine.set_speed(0.25).ok && engine.set_speed(4.0).ok, "speed boundaries");
  expect(!engine.set_speed(0.0).ok && !engine.set_speed(4.01).ok && !engine.set_speed(std::nan("")).ok, "invalid speeds");
  expect(engine.set_speed(1.0).ok, "default wall speed restored");
  engine.reset();
  expect(engine.start().ok && engine.state() == sidecar::SimulationState::running, "start transition");
  std::this_thread::sleep_for(std::chrono::milliseconds(180));
  expect(engine.pause().ok && engine.state() == sidecar::SimulationState::paused, "pause transition");
  const double paused_time = engine.latest_pose()["simulationTime"];
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  expect(std::abs(engine.latest_pose()["simulationTime"].get<double>() - paused_time) < 1e-12, "pause freezes time");
  { std::lock_guard lock(events_mutex); std::cout << "D4C_POSE_EVENTS_180MS=" << events.size() << '\n'; expect(events.size() >= 3 && events.size() <= 100, "pose approximately 60hz"); }
  expect(engine.stop().ok && engine.state() == sidecar::SimulationState::stopped, "simulation stop");
  expect(engine.reset().ok && engine.latest_pose()["simulationTime"] == 0.0, "reset home time");
  std::vector<std::string> names;
  for (const auto& joint : engine.latest_pose()["joints"]) names.push_back(joint["name"]);
  expect(std::adjacent_find(names.begin(), names.end()) == names.end(), "joint order stable");

  std::vector<std::string> protocol_events;
  sidecar::ProtocolHandler protocol(TEST_RESOURCE_ROOT, [&](std::string line) { protocol_events.push_back(std::move(line)); });
  auto hello = Json::parse(protocol.process_line(command("h", "hello", {{"clientName", "tauri-host"}, {"clientProtocolVersion", 1}})).response);
  expect(hello["type"] == "ready" && hello["payload"]["capabilities"].size() == 10, "hello capabilities");
  expect(Json::parse(protocol.process_line(command("l", "load_model", {{"modelId", "minimal-quadruped-v1"}})).response)["type"] == "model_loaded", "protocol load");
  expect(Json::parse(protocol.process_line(command("s", "start", Json::object())).response)["payload"]["state"] == "running", "protocol start");
  expect(Json::parse(protocol.process_line(command("p", "pause", Json::object())).response)["payload"]["state"] == "paused", "protocol pause");
  expect(Json::parse(protocol.process_line(command("t", "step", {{"steps", 1}})).response)["type"] == "pose", "protocol step pose");
  expect(Json::parse(protocol.process_line(command("r", "reset", Json::object())).response)["payload"]["state"] == "loaded", "protocol reset");
  expect(Json::parse(protocol.process_line(command("x", "stop", Json::object())).response)["payload"]["state"] == "stopped", "protocol stop");
  expect(Json::parse(protocol.process_line(command("v", "set_speed", {{"speed", 1.0}})).response)["payload"]["speed"] == 1.0, "protocol speed");
  expect(Json::parse(protocol.process_line(command("g", "ping", {{"nonce", "n"}})).response)["type"] == "pong", "ping retained");
  const auto shutdown = protocol.process_line(command("q", "shutdown", Json::object()));
  expect(shutdown.should_stop, "shutdown joins physics");
  expect(sidecar::message_too_large_response().find("MESSAGE_TOO_LARGE") != std::string::npos, "oversize response");
  std::cout << "D4C_CPP_CHECKS=" << checks << '\n';
  return 0;
}

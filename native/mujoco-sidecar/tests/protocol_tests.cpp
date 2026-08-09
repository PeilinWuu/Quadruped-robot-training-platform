#include "protocol.hpp"
#include "simulation.hpp"

#include <atomic>
#include <algorithm>
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
bool finite_json_numbers(const Json& value) {
  if (value.is_number_float()) return std::isfinite(value.get<double>());
  if (value.is_array() || value.is_object()) {
    for (const auto& child : value) if (!finite_json_numbers(child)) return false;
  }
  return true;
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
  expect(!engine.load_model("minimal-quadruped-v1", "unknown-environment").ok,
         "unknown environment rejected");
  const auto loaded = engine.load_model("minimal-quadruped-v1");
  expect(loaded.ok, "minimal model loads");
  expect(loaded.payload["jointCount"] == 12, "12 joints");
  expect(loaded.payload["actuatorCount"] == 12, "12 actuators");
  expect(std::abs(loaded.payload["timestep"].get<double>() - 0.002) < 1e-12, "fixed timestep");
  expect(!engine.test_has_stable_performance_snapshot(), "load starts performance warmup");
  const auto one_step_performance = engine.test_performance_window(0.012, 0.002, 1);
  expect(!one_step_performance["stableSnapshotCached"].get<bool>(),
         "one step does not create stable performance snapshot");
  const double one_step_hz = one_step_performance["performance"]["physicsFrequencyHz"];
  const auto hundred_ms_performance = engine.test_performance_window(0.100, 0.100, 50);
  expect(!hundred_ms_performance["stableSnapshotCached"].get<bool>() &&
             std::abs(hundred_ms_performance["performance"]["physicsFrequencyHz"].get<double>() -
                      500.0) < 1e-6 &&
             hundred_ms_performance["performance"]["physicsFrequencyHz"].get<double>() !=
                 one_step_hz,
         "100ms warmup updates instead of freezing first step");
  const auto five_hundred_ms_performance = engine.test_performance_window(0.500, 0.500, 250);
  expect(!five_hundred_ms_performance["stableSnapshotCached"].get<bool>() &&
             std::abs(five_hundred_ms_performance["performance"]["realTimeFactor"].get<double>() -
                      1.0) < 1e-6,
         "500ms remains uncached warmup");
  const auto stable_performance = engine.test_performance_window(1.100, 1.100, 550);
  expect(stable_performance["stableSnapshotCached"].get<bool>() &&
             std::abs(stable_performance["performance"]["physicsFrequencyHz"].get<double>() -
                      500.0) < 1e-6 &&
             std::abs(stable_performance["performance"]["realTimeFactor"].get<double>() -
                      1.0) < 1e-6,
         "one second creates finite stable performance snapshot");
  expect(finite_json_numbers(stable_performance), "stable performance numbers finite");

  expect(engine.reset().ok && !engine.test_has_stable_performance_snapshot(),
         "reset restarts performance warmup");
  const auto delayed_first_step = engine.test_performance_window(0.012, 0.002, 1);
  expect(delayed_first_step["performance"]["realTimeFactor"].get<double>() < 0.2 &&
             !delayed_first_step["stableSnapshotCached"].get<bool>(),
         "delayed first step remains an uncached warmup sample");
  const auto delayed_stable = engine.test_performance_window(1.020, 1.010, 505);
  expect(delayed_stable["stableSnapshotCached"].get<bool>() &&
             delayed_stable["performance"]["physicsFrequencyHz"].get<double>() > 490.0 &&
             delayed_stable["performance"]["realTimeFactor"].get<double>() > 0.98,
         "10ms cold start does not contaminate stable window");

  expect(engine.reset().ok, "reset before 44hz regression reproduction");
  const auto old_44hz_sample = engine.test_performance_window(1.0 / 44.0, 0.002, 1);
  expect(!old_44hz_sample["stableSnapshotCached"].get<bool>() &&
             old_44hz_sample["performance"]["physicsFrequencyHz"].get<double>() > 43.0 &&
             old_44hz_sample["performance"]["physicsFrequencyHz"].get<double>() < 45.0 &&
             old_44hz_sample["performance"]["realTimeFactor"].get<double>() < 0.1,
         "past 44hz cold snapshot reproduced as warmup only");
  const auto recovered_warmup = engine.test_performance_window(0.500, 0.500, 250);
  expect(!recovered_warmup["stableSnapshotCached"].get<bool>() &&
             recovered_warmup["performance"]["physicsFrequencyHz"].get<double>() > 499.0 &&
             recovered_warmup["performance"]["realTimeFactor"].get<double>() > 0.99,
         "44hz warmup value is not frozen");
  const auto recovered_stable = engine.test_performance_window(1.050, 1.050, 525);
  expect(recovered_stable["stableSnapshotCached"].get<bool>() &&
             recovered_stable["performance"]["physicsFrequencyHz"].get<double>() > 499.0 &&
             recovered_stable["performance"]["realTimeFactor"].get<double>() > 0.99,
         "44hz regression converges to stable target");
  expect(engine.load_model("minimal-quadruped-v1").ok &&
             !engine.test_has_stable_performance_snapshot(),
         "model reload restarts performance warmup");
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
  const auto minimal_telemetry = engine.get_latest_telemetry();
  expect(minimal_telemetry.ok && minimal_telemetry.payload["modelId"] == "minimal-quadruped-v1", "minimal telemetry profile");
  expect(minimal_telemetry.payload["joints"].size() == 12 && minimal_telemetry.payload["feet"].size() == 4, "minimal telemetry mapping sizes");
  expect(minimal_telemetry.payload["collision"]["environmentId"] == "flat-ground-v1",
         "default flat environment");
  expect(minimal_telemetry.payload["collision"]["nonFootContacts"] == 0,
         "minimal home nonfoot clear");
  const auto minimal_profile = engine.test_collision_profile();
  for (const char* category : {"feet", "calves", "thighs", "hips", "torso", "head", "environment"}) {
    expect(std::any_of(minimal_profile.begin(), minimal_profile.end(), [category](const Json& item) {
      return item["category"] == category;
    }), "minimal collision category mapped");
  }
  expect(engine.test_set_root_state({9.0, 0.0, 0.58}, {1.0, 0.0, 0.0, 0.0}),
         "test root out of bounds");
  expect(engine.get_latest_telemetry().payload["collision"]["isOutOfBounds"],
         "out of bounds detected");
  engine.reset();
  expect(!engine.get_latest_telemetry().payload["collision"]["isOutOfBounds"],
         "reset returns in bounds");
  expect(finite_json_numbers(minimal_telemetry.payload), "minimal telemetry finite");
  expect(minimal_telemetry.payload.dump().size() < sidecar::kMaxLineBytes, "telemetry under line limit");
  expect(engine.set_telemetry_rate(10).ok && engine.set_telemetry_rate(100).ok, "telemetry rate boundaries");
  expect(!engine.set_telemetry_rate(9).ok && !engine.set_telemetry_rate(101).ok, "telemetry rate rejects out of range");
  sidecar::MotionCommand stand{11, sidecar::MotionMode::stand, 1.0, -0.5, 1.0, 0.3, 500};
  expect(sidecar::valid_motion_command(stand), "motion command legal");
  const auto stand_status = engine.set_motion_command(stand);
  expect(stand_status.ok && stand_status.payload["forwardVelocity"] == 0.0 && stand_status.payload["appliedByController"], "stand zeros velocity and applies hold");
  sidecar::MotionCommand locomotion{12, sidecar::MotionMode::locomotion, 0.2, -0.1, 0.3, 0.3, 100};
  const auto locomotion_status = engine.set_motion_command(locomotion);
  expect(!locomotion_status.ok && locomotion_status.code == "LOCOMOTION_UNAVAILABLE",
         "minimal locomotion unavailable");
  sidecar::MotionCommand invalid = locomotion; invalid.forward_velocity = std::nan("");
  expect(!sidecar::valid_motion_command(invalid), "nonfinite motion rejected");
  invalid = locomotion; invalid.body_height = 0.41;
  expect(!sidecar::valid_motion_command(invalid), "motion bounds rejected");
  const auto cleared = engine.clear_motion_command();
  expect(cleared.ok && cleared.payload["mode"] == "stand" && !cleared.payload["timedOut"], "clear command restores stand");
  std::this_thread::sleep_for(std::chrono::milliseconds(110));
  expect(!engine.get_latest_telemetry().payload["command"]["timedOut"], "cleared stand does not acquire a timeout");
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

  const std::array<const char*, 12> go2_names = {
      "FL_hip_joint", "FL_thigh_joint", "FL_calf_joint", "FR_hip_joint",
      "FR_thigh_joint", "FR_calf_joint", "RL_hip_joint", "RL_thigh_joint",
      "RL_calf_joint", "RR_hip_joint", "RR_thigh_joint", "RR_calf_joint"};
  const auto go2_started = std::chrono::steady_clock::now();
  const auto go2_loaded = engine.load_model("unitree-go2-menagerie");
  const auto go2_load_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - go2_started).count();
  expect(go2_loaded.ok, "Go2 wrapper loads");
  expect(go2_loaded.payload["jointCount"] == 12 && go2_loaded.payload["actuatorCount"] == 12,
         "Go2 metadata");
  Json go2_home = engine.latest_pose();
  for (std::size_t index = 0; index < go2_names.size(); ++index) {
    expect(go2_home["joints"][index]["name"] == go2_names[index], "Go2 joint order");
  }
  expect(go2_home["simulationTime"] == 0.0 && finite_pose(go2_home), "Go2 home finite");
  const auto go2_telemetry = engine.get_latest_telemetry().payload;
  expect(go2_telemetry["modelId"] == "unitree-go2-menagerie" && go2_telemetry["joints"].size() == 12, "Go2 telemetry profile");
  expect(go2_telemetry["feet"][0]["name"] == "FL" && go2_telemetry["feet"][1]["name"] == "FR" && go2_telemetry["feet"][2]["name"] == "RL" && go2_telemetry["feet"][3]["name"] == "RR", "Go2 fixed foot mapping");
  expect(go2_telemetry["collision"]["environmentId"] == "flat-ground-v1" &&
         go2_telemetry["collision"]["nonFootContacts"] == 0, "Go2 home collision state");
  const auto go2_profile = engine.test_collision_profile();
  for (const char* category : {"feet", "calves", "thighs", "hips", "torso", "head", "environment"}) {
    expect(std::any_of(go2_profile.begin(), go2_profile.end(), [category](const Json& item) {
      return item["category"] == category;
    }), "Go2 collision category mapped");
  }
  expect(engine.test_set_root_state({0.0, 0.0, 0.10}, {0.7071067811865476, 0.7071067811865476, 0.0, 0.0}),
         "test fallen root state");
  engine.step(101);
  const auto fault_telemetry = engine.get_latest_telemetry().payload;
  const auto fallen = fault_telemetry["collision"];
  expect(fallen["isFallen"] && fallen["fallReason"] != "none", "debounced fall detected");
  expect(fault_telemetry["locomotion"]["state"] == "fault" &&
         fault_telemetry["locomotion"]["faultReason"] == "fall-detected",
         "forced fall telemetry state and reason are consistent");
  for (int frame = 0; frame < 10; ++frame) {
    engine.step(1);
    const auto sustained_fault = engine.get_latest_telemetry().payload["locomotion"];
    expect(sustained_fault["state"] == "fault" &&
           sustained_fault["faultReason"] == "fall-detected",
           "sustained fault telemetry remains consistent");
  }
  engine.reset();
  const auto reset_telemetry = engine.get_latest_telemetry().payload;
  expect(!reset_telemetry["collision"]["isFallen"] &&
         reset_telemetry["locomotion"]["state"] == "standing" &&
         reset_telemetry["locomotion"]["faultReason"].is_null(),
         "reset clears fall and restores standing without sidecar restart");
  expect(finite_json_numbers(go2_telemetry) && go2_telemetry.dump().size() < sidecar::kMaxLineBytes, "Go2 telemetry finite and bounded");
  engine.reset();
  for (int second = 0; second < 10; ++second) expect(engine.step(500).ok, "static MPC stand second");
  const auto static_mpc = engine.test_static_mpc_diagnostics();
  std::cout << "D5V_MPC_STATIC_10S=" << static_mpc << '\n';
  expect(static_mpc["fault"].is_null() && static_mpc["qpFailureCount"] == 0,
         "static MPC has no fault or QP failure");
  expect(static_mpc["rootPosition"][2].get<double>() > 0.18 &&
         static_mpc["rootPosition"][2].get<double>() < 0.35,
         "static MPC base height bounded");
  expect(!static_mpc["collision"]["isFallen"].get<bool>() &&
         static_mpc["collision"]["torsoContacts"].get<int>() == 0 &&
         static_mpc["collision"]["headContacts"].get<int>() == 0,
         "static MPC no fall torso or head contact");
  expect(static_mpc["solverMeanMs"].get<double>() < 15.0 &&
         static_mpc["solverMaxMs"].get<double>() < 15.0,
         "static MPC stays within 50Hz budget");
  expect(static_mpc["actuatorSaturationCount"].get<std::uint64_t>() < 250,
         "static MPC has no persistent saturation");
  engine.reset();
  const auto mpc_telemetry = engine.get_latest_telemetry().payload["locomotion"];
  expect(mpc_telemetry["controllerId"] == "go2-convex-mpc-v1" &&
         mpc_telemetry["availability"] == "available", "Go2 MPC telemetry identity");
  expect(mpc_telemetry["mpcFrequencyHz"] == 50 && mpc_telemetry["legControllerFrequencyHz"] == 250 &&
         mpc_telemetry["horizonSteps"] == 10, "Go2 MPC frequencies and horizon");
  expect(!mpc_telemetry.contains("compensationEnabled") && !mpc_telemetry.contains("ikFailureCount") &&
         !mpc_telemetry.contains("swingLeg"), "legacy crawl telemetry removed");
  for (int index = 0; index < 5; ++index) {
    const auto advanced = engine.step(1000);
    expect(advanced.ok && finite_pose(advanced.payload), "Go2 thousands stable");
  }
  engine.reset(); const auto go2_a = engine.step(100).payload;
  engine.reset(); const auto go2_b = engine.step(100).payload;
  expect(go2_a["rootPosition"] == go2_b["rootPosition"] && go2_a["joints"] == go2_b["joints"],
         "Go2 deterministic steps");
  for (int index = 0; index < 10; ++index) {
    expect(engine.load_model(index % 2 == 0 ? "minimal-quadruped-v1" : "unitree-go2-menagerie").ok,
           "model switching");
  }
  expect(!engine.load_model("../unitree-go2-menagerie/unitree-go2-scene.xml").ok,
         "path injection rejected");
  sidecar::SimulationEngine missing_engine(std::filesystem::path(TEST_RESOURCE_ROOT) / "missing", [](Json) {});
  const auto missing = missing_engine.load_model("unitree-go2-menagerie");
  expect(!missing.ok && missing.code == "MODEL_LOAD_FAILED", "missing asset safe failure");
  std::cout << "D4D2A_GO2_LOAD_MS=" << go2_load_ms << '\n';

  std::vector<std::string> protocol_events;
  sidecar::ProtocolHandler protocol(TEST_RESOURCE_ROOT, [&](std::string line) { protocol_events.push_back(std::move(line)); });
  auto hello = Json::parse(protocol.process_line(command("h", "hello", {{"clientName", "tauri-host"}, {"clientProtocolVersion", 1}})).response);
  expect(hello["type"] == "ready" && hello["payload"]["capabilities"].size() == 14, "hello capabilities");
  expect(Json::parse(protocol.process_line(command("l", "load_model", {{"modelId", "minimal-quadruped-v1"}})).response)["type"] == "model_loaded", "protocol load");
  expect(Json::parse(protocol.process_line(command("lg", "load_model", {{"modelId", "unitree-go2-menagerie"}})).response)["type"] == "model_loaded", "protocol Go2 load");
  expect(Json::parse(protocol.process_line(command("s", "start", Json::object())).response)["payload"]["state"] == "running", "protocol start");
  expect(Json::parse(protocol.process_line(command("p", "pause", Json::object())).response)["payload"]["state"] == "paused", "protocol pause");
  expect(Json::parse(protocol.process_line(command("t", "step", {{"steps", 1}})).response)["type"] == "pose", "protocol step pose");
  expect(Json::parse(protocol.process_line(command("r", "reset", Json::object())).response)["payload"]["state"] == "loaded", "protocol reset");
  expect(Json::parse(protocol.process_line(command("x", "stop", Json::object())).response)["payload"]["state"] == "stopped", "protocol stop");
  expect(Json::parse(protocol.process_line(command("v", "set_speed", {{"speed", 1.0}})).response)["payload"]["speed"] == 1.0, "protocol speed");
  const Json motion_payload{{"sequence", 1}, {"mode", "locomotion"}, {"forwardVelocity", 0.2}, {"lateralVelocity", 0.0}, {"yawRate", 0.1}, {"bodyHeight", 0.3}, {"validForMs", 500}};
  expect(Json::parse(protocol.process_line(command("mc", "set_motion_command", motion_payload)).response)["type"] == "motion_command_changed", "protocol motion command");
  expect(Json::parse(protocol.process_line(command("tc", "set_telemetry_rate", {{"rateHz", 50}})).response)["payload"]["rateHz"] == 50, "protocol telemetry rate");
  expect(Json::parse(protocol.process_line(command("gt", "get_latest_telemetry", Json::object())).response)["type"] == "telemetry", "protocol latest telemetry");
  expect(Json::parse(protocol.process_line(command("cc", "clear_motion_command", Json::object())).response)["payload"]["mode"] == "stand", "protocol clear command");
  expect(Json::parse(protocol.process_line(command("g", "ping", {{"nonce", "n"}})).response)["type"] == "pong", "ping retained");
  const auto shutdown = protocol.process_line(command("q", "shutdown", Json::object()));
  expect(shutdown.should_stop, "shutdown joins physics");
  expect(sidecar::message_too_large_response().find("MESSAGE_TOO_LARGE") != std::string::npos, "oversize response");
  std::cout << "D5VB1_CPP_CHECKS=" << checks << '\n';
  return 0;
}

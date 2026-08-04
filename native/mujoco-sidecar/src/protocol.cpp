#include "protocol.hpp"
#include "simulation.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <exception>
#include <utility>

#include <nlohmann/json.hpp>

namespace sidecar {
namespace {
using Json = nlohmann::json;
constexpr std::size_t kMaxDepth = 16;
constexpr std::size_t kMaxObjectMembers = 64;
constexpr std::size_t kMaxArrayMembers = 256;
constexpr std::size_t kMaxStringBytes = 4096;

std::int64_t unix_milliseconds() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}
bool printable_ascii(const std::string& value) {
  for (const unsigned char c : value) if (c < 0x20U || c > 0x7eU) return false;
  return true;
}
bool valid_request_id(const Json& value) {
  return value.is_string() && !value.get_ref<const std::string&>().empty() &&
         value.get_ref<const std::string&>().size() <= 64U && printable_ascii(value.get_ref<const std::string&>());
}
bool valid_u32(const Json& value) {
  if (!value.is_number_integer() && !value.is_number_unsigned()) return false;
  if (value.is_number_unsigned()) return value.get<std::uint64_t>() <= UINT32_MAX;
  const auto number = value.get<std::int64_t>();
  return number >= 0 && static_cast<std::uint64_t>(number) <= UINT32_MAX;
}
bool structurally_safe(const Json& value, const std::size_t depth = 0) {
  if (depth > kMaxDepth) return false;
  if (value.is_string()) return value.get_ref<const std::string&>().size() <= kMaxStringBytes;
  if (value.is_number_float()) return std::isfinite(value.get<double>());
  if (value.is_object()) {
    if (value.size() > kMaxObjectMembers) return false;
    for (auto it = value.begin(); it != value.end(); ++it) if (it.key().size() > kMaxStringBytes || !structurally_safe(it.value(), depth + 1)) return false;
  } else if (value.is_array()) {
    if (value.size() > kMaxArrayMembers) return false;
    for (const auto& item : value) if (!structurally_safe(item, depth + 1)) return false;
  }
  return true;
}
Json envelope(const Json& request_id, const char* type, Json payload) {
  return Json{{"protocolVersion", kProtocolVersion}, {"requestId", request_id}, {"type", type},
              {"timestamp", unix_milliseconds()}, {"payload", std::move(payload)}};
}
ProtocolResult error_result(const Json& request_id, const char* code, const char* message,
                            const bool recoverable = true) {
  return {envelope(request_id, "error", Json{{"code", code}, {"message", message}, {"recoverable", recoverable}}).dump(), false};
}
ProtocolResult engine_result(const Json& request_id, const char* success_type, EngineResult result) {
  if (!result.ok) return error_result(request_id, result.code.c_str(), "The simulation command was rejected.");
  return {envelope(request_id, success_type, std::move(result.payload)).dump(), false};
}
}  // namespace

ProtocolHandler::ProtocolHandler(std::string resource_root, EventSink event_sink)
    : simulation_(std::make_unique<SimulationEngine>(std::move(resource_root),
          [sink = std::move(event_sink)](const EventKind kind, Json payload) {
            std::string type = "telemetry";
            if (kind == EventKind::pose) type = "pose";
            else if (kind == EventKind::motion_command) type = "motion_command_changed";
            else if (kind == EventKind::telemetry_config) type = "telemetry_config_changed";
            else if (kind == EventKind::collision) type = payload.value("kind", "collision_event");
            return sink(type, envelope(nullptr, type.c_str(), std::move(payload)).dump());
          })) {}
ProtocolHandler::ProtocolHandler(std::string resource_root, LegacyEventSink event_sink)
    : ProtocolHandler(std::move(resource_root),
        [sink = std::move(event_sink)](std::string_view, std::string line) {
          sink(std::move(line));
          return false;
        }) {}
ProtocolHandler::~ProtocolHandler() = default;

std::string message_too_large_response() {
  return error_result(nullptr, "MESSAGE_TOO_LARGE", "The protocol message exceeds the size limit.", false).response;
}

ProtocolResult ProtocolHandler::process_line(const std::string& line) {
  if (line.size() > kMaxLineBytes) return {message_too_large_response(), false};
  if (line.empty()) return error_result(nullptr, "INVALID_MESSAGE", "The protocol message is empty.");
  Json request;
  try { request = Json::parse(line); }
  catch (const Json::parse_error&) { return error_result(nullptr, "INVALID_JSON", "The protocol message is not valid JSON."); }
  catch (...) { return error_result(nullptr, "INTERNAL_ERROR", "The protocol message could not be processed.", false); }
  try {
    if (!request.is_object() || !structurally_safe(request)) return error_result(nullptr, "INVALID_MESSAGE", "The protocol message has an invalid structure.");
    if (!request.contains("requestId") || !valid_request_id(request["requestId"])) return error_result(nullptr, "INVALID_REQUEST_ID", "The request identifier is invalid.");
    const Json request_id = request["requestId"];
    if (!request.contains("protocolVersion") || !request["protocolVersion"].is_number_integer() || request["protocolVersion"].get<int>() != kProtocolVersion)
      return error_result(request_id, "PROTOCOL_VERSION_UNSUPPORTED", "The requested protocol version is not supported.", false);
    if (!request.contains("type") || !request["type"].is_string() || request["type"].get_ref<const std::string&>().empty() || request["type"].get_ref<const std::string&>().size() > 64U)
      return error_result(request_id, "INVALID_MESSAGE", "The command type is invalid.");
    if (!request.contains("timestamp") || !(request["timestamp"].is_number_integer() || request["timestamp"].is_number_unsigned()) || request["timestamp"].get<std::int64_t>() < 0)
      return error_result(request_id, "INVALID_MESSAGE", "The timestamp is invalid.");
    if (!request.contains("payload") || !request["payload"].is_object()) return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
    const auto& type = request["type"].get_ref<const std::string&>();
    const auto& payload = request["payload"];
    if (type == "hello") {
      if (state_ != SidecarState::starting || payload.value("clientName", "") != "tauri-host" || payload.value("clientProtocolVersion", 0) != kProtocolVersion)
        return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
      state_ = SidecarState::ready;
      return {envelope(request_id, "ready", Json{{"sidecarName", "quadruped-simulation-sidecar"},
              {"sidecarVersion", "0.2.0"}, {"protocolVersion", kProtocolVersion},
              {"capabilities", Json::array({"hello", "ping", "shutdown", "load_model", "start", "pause", "step", "reset", "stop", "set_speed", "set_motion_command", "clear_motion_command", "set_telemetry_rate", "get_latest_telemetry"})}}).dump(), false};
    }
    if (state_ != SidecarState::ready) return error_result(request_id, "INVALID_MESSAGE", "The command is not valid in the current process state.");
    if (type == "ping") {
      Json pong = Json::object(); if (payload.contains("nonce")) pong["nonce"] = payload["nonce"];
      return {envelope(request_id, "pong", std::move(pong)).dump(), false};
    }
    if (type == "shutdown") {
      if (!payload.empty()) return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
      state_ = SidecarState::stopping; simulation_->shutdown();
      return {envelope(request_id, "state_changed", Json{{"state", "stopping"}}).dump(), true};
    }
    if (type == "load_model") {
      if ((payload.size() != 1 && payload.size() != 2) || !payload.contains("modelId") || !payload["modelId"].is_string() ||
          (payload.contains("environmentId") && !payload["environmentId"].is_string())) return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
      return engine_result(request_id, "model_loaded", simulation_->load_model(payload["modelId"].get<std::string>(), payload.value("environmentId", "flat-ground-v1")));
    }
    if (type == "start" && payload.empty()) return engine_result(request_id, "state_changed", simulation_->start());
    if (type == "pause" && payload.empty()) return engine_result(request_id, "state_changed", simulation_->pause());
    if (type == "reset" && payload.empty()) return engine_result(request_id, "state_changed", simulation_->reset());
    if (type == "stop" && payload.empty()) return engine_result(request_id, "state_changed", simulation_->stop());
    if (type == "step" && payload.size() == 1 && payload.contains("steps") && payload["steps"].is_number_integer())
      return engine_result(request_id, "pose", simulation_->step(payload["steps"].get<int>()));
    if (type == "set_speed" && payload.size() == 1 && payload.contains("speed") && payload["speed"].is_number())
      return engine_result(request_id, "state_changed", simulation_->set_speed(payload["speed"].get<double>()));
    if (type == "set_motion_command") {
      if (payload.size() != 7 || !payload.contains("sequence") || !valid_u32(payload["sequence"]) ||
          !payload.contains("mode") || !payload["mode"].is_string() ||
          !payload.contains("forwardVelocity") || !payload["forwardVelocity"].is_number() ||
          !payload.contains("lateralVelocity") || !payload["lateralVelocity"].is_number() ||
          !payload.contains("yawRate") || !payload["yawRate"].is_number() ||
          !payload.contains("bodyHeight") || !payload["bodyHeight"].is_number() ||
          !payload.contains("validForMs") || !valid_u32(payload["validForMs"])) {
        return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
      }
      const auto mode = payload["mode"].get<std::string>();
      if (mode != "stand" && mode != "locomotion") return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
      MotionCommand command;
      command.sequence = payload["sequence"].get<std::uint32_t>();
      command.mode = mode == "stand" ? MotionMode::stand : MotionMode::locomotion;
      command.forward_velocity = payload["forwardVelocity"].get<double>();
      command.lateral_velocity = payload["lateralVelocity"].get<double>();
      command.yaw_rate = payload["yawRate"].get<double>();
      command.body_height = payload["bodyHeight"].get<double>();
      command.valid_for_ms = payload["validForMs"].get<std::uint32_t>();
      return engine_result(request_id, "motion_command_changed", simulation_->set_motion_command(command));
    }
    if (type == "clear_motion_command" && payload.empty())
      return engine_result(request_id, "motion_command_changed", simulation_->clear_motion_command());
    if (type == "set_telemetry_rate" && payload.size() == 1 && payload.contains("rateHz") && payload["rateHz"].is_number_integer())
      return engine_result(request_id, "telemetry_config_changed", simulation_->set_telemetry_rate(payload["rateHz"].get<int>()));
    if (type == "get_latest_telemetry" && payload.empty())
      return engine_result(request_id, "telemetry", simulation_->get_latest_telemetry());
    return error_result(request_id, "UNKNOWN_COMMAND", "The command type is not supported.");
  } catch (...) { return error_result(nullptr, "INTERNAL_ERROR", "The protocol message could not be processed.", false); }
}

}  // namespace sidecar

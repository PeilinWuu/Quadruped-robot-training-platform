#include "protocol.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <exception>
#include <string>

#include <nlohmann/json.hpp>

namespace sidecar {
namespace {

using Json = nlohmann::json;

constexpr std::size_t kMaxDepth = 16;
constexpr std::size_t kMaxObjectMembers = 64;
constexpr std::size_t kMaxArrayMembers = 256;
constexpr std::size_t kMaxStringBytes = 4096;
constexpr std::size_t kMaxClientNameBytes = 64;

std::int64_t unix_milliseconds() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

bool printable_ascii(const std::string& value) {
  for (const unsigned char character : value) {
    if (character < 0x20U || character > 0x7eU) {
      return false;
    }
  }
  return true;
}

bool valid_request_id(const Json& value) {
  if (!value.is_string()) {
    return false;
  }
  const auto& request_id = value.get_ref<const std::string&>();
  return !request_id.empty() && request_id.size() <= 64U && printable_ascii(request_id);
}

bool structurally_safe(const Json& value, const std::size_t depth = 0) {
  if (depth > kMaxDepth) {
    return false;
  }
  if (value.is_string()) {
    return value.get_ref<const std::string&>().size() <= kMaxStringBytes;
  }
  if (value.is_number_float()) {
    return std::isfinite(value.get<double>());
  }
  if (value.is_object()) {
    if (value.size() > kMaxObjectMembers) {
      return false;
    }
    for (auto iterator = value.begin(); iterator != value.end(); ++iterator) {
      if (iterator.key().size() > kMaxStringBytes || !structurally_safe(iterator.value(), depth + 1U)) {
        return false;
      }
    }
  } else if (value.is_array()) {
    if (value.size() > kMaxArrayMembers) {
      return false;
    }
    for (const auto& item : value) {
      if (!structurally_safe(item, depth + 1U)) {
        return false;
      }
    }
  }
  return true;
}

Json envelope(const Json& request_id, const char* type, Json payload) {
  return Json{{"protocolVersion", kProtocolVersion},
              {"requestId", request_id},
              {"type", type},
              {"timestamp", unix_milliseconds()},
              {"payload", std::move(payload)}};
}

ProtocolResult error_result(const Json& request_id, const char* code, const char* message,
                            const bool recoverable = true) {
  return {envelope(request_id, "error",
                   Json{{"code", code}, {"message", message}, {"recoverable", recoverable}})
              .dump(),
          false};
}

ProtocolResult invalid_payload(const Json& request_id) {
  return error_result(request_id, "INVALID_PAYLOAD", "The command payload is invalid.");
}

}  // namespace

std::string message_too_large_response() {
  return error_result(nullptr, "MESSAGE_TOO_LARGE", "The protocol message exceeds the size limit.", false)
      .response;
}

ProtocolResult ProtocolHandler::process_line(const std::string& line) {
  if (line.size() > kMaxLineBytes) {
    return {message_too_large_response(), false};
  }
  if (line.empty()) {
    return error_result(nullptr, "INVALID_MESSAGE", "The protocol message is empty.");
  }

  Json request;
  try {
    request = Json::parse(line);
  } catch (const Json::parse_error&) {
    return error_result(nullptr, "INVALID_JSON", "The protocol message is not valid JSON.");
  } catch (const std::exception&) {
    return error_result(nullptr, "INTERNAL_ERROR", "The protocol message could not be processed.", false);
  }

  try {
  if (!request.is_object() || !structurally_safe(request)) {
    return error_result(nullptr, "INVALID_MESSAGE", "The protocol message has an invalid structure.");
  }

  if (!request.contains("requestId") || !valid_request_id(request["requestId"])) {
    return error_result(nullptr, "INVALID_REQUEST_ID", "The request identifier is invalid.");
  }
  const Json request_id = request["requestId"];

  if (!request.contains("protocolVersion") || !request["protocolVersion"].is_number_integer()) {
    return error_result(request_id, "INVALID_MESSAGE", "The protocol version is missing or invalid.");
  }
  if (request["protocolVersion"].get<int>() != kProtocolVersion) {
    return error_result(request_id, "PROTOCOL_VERSION_UNSUPPORTED",
                        "The requested protocol version is not supported.", false);
  }
  if (!request.contains("type") || !request["type"].is_string() ||
      request["type"].get_ref<const std::string&>().empty() ||
      request["type"].get_ref<const std::string&>().size() > 64U) {
    return error_result(request_id, "INVALID_MESSAGE", "The command type is invalid.");
  }
  if (!request.contains("timestamp") ||
      !(request["timestamp"].is_number_integer() || request["timestamp"].is_number_unsigned()) ||
      request["timestamp"].get<std::int64_t>() < 0) {
    return error_result(request_id, "INVALID_MESSAGE", "The timestamp is invalid.");
  }
  if (!request.contains("payload") || !request["payload"].is_object()) {
    return invalid_payload(request_id);
  }

  const auto& type = request["type"].get_ref<const std::string&>();
  const auto& payload = request["payload"];
  if (type == "hello") {
    if (state_ != SidecarState::starting) {
      return error_result(request_id, "INVALID_MESSAGE", "The hello command is not valid in the current state.");
    }
    if (!payload.contains("clientName") || !payload["clientName"].is_string() ||
        payload["clientName"].get_ref<const std::string&>().empty() ||
        payload["clientName"].get_ref<const std::string&>().size() > kMaxClientNameBytes ||
        !printable_ascii(payload["clientName"].get_ref<const std::string&>()) ||
        !payload.contains("clientProtocolVersion") ||
        !payload["clientProtocolVersion"].is_number_integer() ||
        payload["clientProtocolVersion"].get<int>() != kProtocolVersion) {
      return invalid_payload(request_id);
    }
    state_ = SidecarState::ready;
    return {envelope(request_id, "ready",
                     Json{{"sidecarName", "quadruped-simulation-sidecar"},
                          {"sidecarVersion", "0.1.0"},
                          {"protocolVersion", kProtocolVersion},
                          {"capabilities", Json::array({"hello", "ping", "shutdown"})}})
                .dump(),
            false};
  }

  if (type == "ping") {
    if (state_ != SidecarState::ready) {
      return error_result(request_id, "INVALID_MESSAGE", "The ping command is not valid in the current state.");
    }
    if (payload.size() > 1U || (payload.contains("nonce") && !structurally_safe(payload["nonce"]))) {
      return invalid_payload(request_id);
    }
    Json response_payload = Json::object();
    if (payload.contains("nonce")) {
      response_payload["nonce"] = payload["nonce"];
    }
    return {envelope(request_id, "pong", std::move(response_payload)).dump(), false};
  }

  if (type == "shutdown") {
    if (!payload.empty()) {
      return invalid_payload(request_id);
    }
    state_ = SidecarState::stopping;
    return {envelope(request_id, "state_changed", Json{{"state", "stopping"}}).dump(), true};
  }

  return error_result(request_id, "UNKNOWN_COMMAND", "The command type is not supported.");
  } catch (const std::exception&) {
    return error_result(nullptr, "INTERNAL_ERROR", "The protocol message could not be processed.", false);
  }
}

}  // namespace sidecar

#include "protocol.hpp"

#include <cstdint>
#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

namespace {

using Json = nlohmann::json;
int failures = 0;

void check(const bool condition, const char* name) {
  if (!condition) {
    std::cerr << "FAILED: " << name << '\n';
    ++failures;
  }
}

std::string request(const std::string& id, const std::string& type, const Json& payload,
                    const int protocol_version = 1) {
  return Json{{"protocolVersion", protocol_version},
              {"requestId", id},
              {"type", type},
              {"timestamp", 0},
              {"payload", payload}}
      .dump();
}

Json response(const sidecar::ProtocolResult& result) {
  check(result.response.find('\n') == std::string::npos, "response is one JSON line");
  return Json::parse(result.response);
}

void check_error(const sidecar::ProtocolResult& result, const std::string& code) {
  const Json json = response(result);
  check(json["type"] == "error", "error response type");
  check(json["payload"]["code"] == code, "stable error code");
  check(result.response.find(":\\") == std::string::npos, "error contains no Windows path");
  check(result.response.find("/Users/") == std::string::npos, "error contains no user path");
}

}  // namespace

int main() {
  sidecar::ProtocolHandler handler;
  const auto hello = handler.process_line(request(
      "hello-1", "hello", Json{{"clientName", "tauri-host"}, {"clientProtocolVersion", 1}}));
  const Json ready = response(hello);
  check(ready["type"] == "ready", "legal hello");
  check(ready["requestId"] == "hello-1", "hello request id");
  check(ready["payload"]["capabilities"].size() == 3U, "capability count");

  const Json pong = response(handler.process_line(request("ping-1", "ping", Json{{"nonce", "abc"}})));
  check(pong["type"] == "pong" && pong["payload"]["nonce"] == "abc", "ping nonce round trip");

  const auto shutdown = handler.process_line(request("stop-1", "shutdown", Json::object()));
  const Json stopping = response(shutdown);
  check(stopping["type"] == "state_changed" && stopping["payload"]["state"] == "stopping",
        "legal shutdown");
  check(shutdown.should_stop, "shutdown enters stopping state");
  check(handler.state() == sidecar::SidecarState::stopping, "handler stores stopping state");

  sidecar::ProtocolHandler invalid_handler;
  check_error(invalid_handler.process_line(request("v2", "ping", Json::object(), 2)),
              "PROTOCOL_VERSION_UNSUPPORTED");
  check_error(invalid_handler.process_line(request("unknown", "start", Json::object())), "UNKNOWN_COMMAND");

  Json missing_id = Json::parse(request("x", "ping", Json::object()));
  missing_id.erase("requestId");
  check_error(invalid_handler.process_line(missing_id.dump()), "INVALID_REQUEST_ID");
  check_error(invalid_handler.process_line(request(std::string(65U, 'x'), "ping", Json::object())),
              "INVALID_REQUEST_ID");

  Json non_object_payload = Json::parse(request("payload", "ping", Json::object()));
  non_object_payload["payload"] = Json::array();
  check_error(invalid_handler.process_line(non_object_payload.dump()), "INVALID_PAYLOAD");
  check_error(invalid_handler.process_line("{broken"), "INVALID_JSON");
  check_error(invalid_handler.process_line(std::string(sidecar::kMaxLineBytes + 1U, 'x')),
              "MESSAGE_TOO_LARGE");

  sidecar::ProtocolHandler pre_hello_handler;
  check_error(pre_hello_handler.process_line(request("early", "ping", Json::object())),
              "INVALID_MESSAGE");

  check(ready["timestamp"].is_number_integer(), "timestamp is integer");
  check(ready["timestamp"].get<std::int64_t>() >= 0, "timestamp is non-negative");

  if (failures != 0) {
    std::cerr << failures << " protocol test(s) failed\n";
    return 1;
  }
  std::cout << "All sidecar protocol tests passed\n";
  return 0;
}

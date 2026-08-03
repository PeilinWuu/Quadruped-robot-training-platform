#pragma once

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace sidecar {

inline constexpr std::size_t kMaxLineBytes = 256U * 1024U;
inline constexpr int kProtocolVersion = 1;

struct ProtocolResult {
  std::string response;
  bool should_stop{false};
};

enum class SidecarState { starting, ready, stopping };

class SimulationEngine;

class ProtocolHandler {
 public:
  using EventSink = std::function<bool(std::string_view, std::string)>;
  using LegacyEventSink = std::function<void(std::string)>;
  ProtocolHandler(std::string resource_root, EventSink event_sink);
  ProtocolHandler(std::string resource_root, LegacyEventSink event_sink);
  ~ProtocolHandler();
  ProtocolHandler(const ProtocolHandler&) = delete;
  ProtocolHandler& operator=(const ProtocolHandler&) = delete;
  ProtocolResult process_line(const std::string& line);
  [[nodiscard]] SidecarState state() const noexcept { return state_; }

 private:
  SidecarState state_{SidecarState::starting};
  std::unique_ptr<SimulationEngine> simulation_;
};

std::string message_too_large_response();

}  // namespace sidecar

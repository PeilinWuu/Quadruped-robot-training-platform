#pragma once

#include <cstddef>
#include <string>

namespace sidecar {

inline constexpr std::size_t kMaxLineBytes = 256U * 1024U;
inline constexpr int kProtocolVersion = 1;

struct ProtocolResult {
  std::string response;
  bool should_stop{false};
};

enum class SidecarState { starting, ready, stopping };

class ProtocolHandler {
 public:
  ProtocolResult process_line(const std::string& line);
  [[nodiscard]] SidecarState state() const noexcept { return state_; }

 private:
  SidecarState state_{SidecarState::starting};
};

std::string message_too_large_response();

}  // namespace sidecar

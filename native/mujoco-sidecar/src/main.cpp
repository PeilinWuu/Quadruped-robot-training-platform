#include "protocol.hpp"

#include <iostream>
#include <string>

namespace {

enum class ReadStatus { line, end_of_file, too_large };

ReadStatus read_line_limited(std::istream& input, std::string& line) {
  line.clear();
  bool overflow = false;
  for (;;) {
    const int next = input.get();
    if (next == std::char_traits<char>::eof()) {
      if (line.empty() && !overflow) {
        return ReadStatus::end_of_file;
      }
      return overflow ? ReadStatus::too_large : ReadStatus::line;
    }
    if (next == '\n') {
      return overflow ? ReadStatus::too_large : ReadStatus::line;
    }
    if (!overflow) {
      if (line.size() >= sidecar::kMaxLineBytes) {
        overflow = true;
      } else if (next != '\r') {
        line.push_back(static_cast<char>(next));
      }
    }
  }
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  sidecar::ProtocolHandler handler;
  std::string line;
  for (;;) {
    const ReadStatus status = read_line_limited(std::cin, line);
    if (status == ReadStatus::end_of_file) {
      return 0;
    }
    if (status == ReadStatus::too_large) {
      std::cout << sidecar::message_too_large_response() << '\n' << std::flush;
      continue;
    }
    const sidecar::ProtocolResult result = handler.process_line(line);
    std::cout << result.response << '\n' << std::flush;
    if (result.should_stop) {
      return 0;
    }
  }
}

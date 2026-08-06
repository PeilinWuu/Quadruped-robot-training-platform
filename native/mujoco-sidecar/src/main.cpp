#include "protocol.hpp"

#include <condition_variable>
#include <deque>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <mujoco/mujoco.h>

namespace {
enum class ReadStatus { line, end_of_file, too_large };
ReadStatus read_line_limited(std::istream& input, std::string& line) {
  line.clear(); bool overflow = false;
  for (;;) {
    const int next = input.get();
    if (next == std::char_traits<char>::eof()) return line.empty() && !overflow ? ReadStatus::end_of_file : (overflow ? ReadStatus::too_large : ReadStatus::line);
    if (next == '\n') return overflow ? ReadStatus::too_large : ReadStatus::line;
    if (!overflow) { if (line.size() >= sidecar::kMaxLineBytes) overflow = true; else if (next != '\r') line.push_back(static_cast<char>(next)); }
  }
}

class StdoutWriter {
 public:
  StdoutWriter() : thread_(&StdoutWriter::run, this) {}
  ~StdoutWriter() { stop(); }
  void response(std::string line) { std::lock_guard lock(mutex_); responses_.push_back(std::move(line)); condition_.notify_one(); }
  bool pose(std::string line) { std::lock_guard lock(mutex_); const bool dropped = latest_pose_.has_value(); latest_pose_ = std::move(line); condition_.notify_one(); return dropped; }
  bool telemetry(std::string line) { std::lock_guard lock(mutex_); const bool dropped = latest_telemetry_.has_value(); latest_telemetry_ = std::move(line); condition_.notify_one(); return dropped; }
  bool collision(std::string line) { std::lock_guard lock(mutex_); const bool dropped = collisions_.size() >= 64U; if (dropped) collisions_.pop_front(); collisions_.push_back(std::move(line)); condition_.notify_one(); return dropped; }
  void stop() {
    { std::lock_guard lock(mutex_); stopping_ = true; }
    condition_.notify_one();
    if (thread_.joinable()) thread_.join();
  }
 private:
  void run() {
    std::unique_lock lock(mutex_);
    for (;;) {
      condition_.wait(lock, [this] { return stopping_ || !responses_.empty() || !collisions_.empty() || latest_pose_.has_value() || latest_telemetry_.has_value(); });
      if (stopping_ && responses_.empty() && collisions_.empty() && !latest_pose_ && !latest_telemetry_) break;
      std::string line;
      if (!responses_.empty()) { line = std::move(responses_.front()); responses_.pop_front(); }
      else if (!collisions_.empty()) { line = std::move(collisions_.front()); collisions_.pop_front(); }
      else if (latest_pose_) { line = std::move(*latest_pose_); latest_pose_.reset(); }
      else { line = std::move(*latest_telemetry_); latest_telemetry_.reset(); }
      lock.unlock(); std::cout << line << '\n' << std::flush; lock.lock();
    }
  }
  std::mutex mutex_; std::condition_variable condition_; std::deque<std::string> responses_;
  std::deque<std::string> collisions_;
  std::optional<std::string> latest_pose_; std::optional<std::string> latest_telemetry_;
  bool stopping_{false}; std::thread thread_;
};
}

int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);
  if (argc != 3 || std::string(argv[1]) != "--resource-root") { std::cerr << "A validated resource root is required.\n"; return 2; }
  std::error_code ec;
  const auto root = std::filesystem::canonical(argv[2], ec);
  if (ec || !std::filesystem::is_directory(root)) { std::cerr << "The resource root is invalid.\n"; return 2; }
  if (mjVERSION_HEADER != 3011000 || mj_version() != mjVERSION_HEADER) { std::cerr << "MuJoCo version mismatch.\n"; return 3; }
  StdoutWriter writer;
  sidecar::ProtocolHandler handler(root.string(), [&writer](const std::string_view type, std::string event) {
    if (type == "pose") return writer.pose(std::move(event));
    if (type == "telemetry") return writer.telemetry(std::move(event));
    if (type == "collision") return writer.collision(std::move(event));
    writer.response(std::move(event));
    return false;
  });
  std::string line;
  for (;;) {
    const auto status = read_line_limited(std::cin, line);
    if (status == ReadStatus::end_of_file) break;
    if (status == ReadStatus::too_large) { writer.response(sidecar::message_too_large_response()); continue; }
    auto result = handler.process_line(line); writer.response(std::move(result.response));
    if (result.should_stop) break;
  }
  return 0;
}

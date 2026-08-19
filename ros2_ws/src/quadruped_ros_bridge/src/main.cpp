#include "quadruped_ros_bridge/bridge_node.hpp"

#include <iostream>
#include <memory>
#include <string>
#include <thread>

#include <rclcpp/rclcpp.hpp>

namespace {

bool read_bounded_line(std::string& line, bool& oversized) {
  line.clear();
  oversized = false;
  char character = 0;
  while (std::cin.get(character)) {
    if (character == '\n') {
      return true;
    }
    if (character == '\r') {
      continue;
    }
    if (line.size() < quadruped_ros_bridge::kMaxFrameBytes + 1U) {
      line.push_back(character);
    } else {
      oversized = true;
    }
  }
  return !line.empty() || oversized;
}

}  // namespace

int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  rclcpp::init(argc, argv);
  auto writer = std::make_shared<quadruped_ros_bridge::StdoutWriter>();
  auto node = std::make_shared<quadruped_ros_bridge::BridgeNode>(writer);
  writer->send(quadruped_ros_bridge::output_frame(
      "ready", {{"nodeName", node->get_name()},
                {"bridgeVersion", "0.1.0"},
                {"watchdogMs", quadruped_ros_bridge::kDefaultWatchdog.count()}}));

  std::thread input_thread([node, writer] {
    std::string line;
    bool oversized = false;
    while (read_bounded_line(line, oversized)) {
      node->diagnostic_frame_received();
      if (oversized || line.size() > quadruped_ros_bridge::kMaxFrameBytes) {
        node->diagnostic_frame_dropped();
        writer->send(quadruped_ros_bridge::protocol_error_frame(
            "FRAME_TOO_LARGE", "ROS bridge input frame exceeds the size limit", false));
        rclcpp::shutdown();
        break;
      }
      try {
        node->handle_frame(quadruped_ros_bridge::parse_input_frame(line));
        node->diagnostic_frame_parsed();
      } catch (const std::exception& error) {
        node->diagnostic_parse_error();
        writer->send(quadruped_ros_bridge::protocol_error_frame(
            "INVALID_FRAME", error.what(), true));
      }
      oversized = false;
    }
  });
  input_thread.detach();

  rclcpp::spin(node);
  rclcpp::shutdown();
  return 0;
}

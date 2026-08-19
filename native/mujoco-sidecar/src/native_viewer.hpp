#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <string_view>

#include <mujoco/mujoco.h>

namespace sidecar {

struct NativeViewerConfig {
  bool enabled{false};
  int fps{60};

  static NativeViewerConfig from_environment();
};

NativeViewerConfig resolve_native_viewer_config(std::string_view enabled,
                                                std::string_view fps);

class NativeViewer {
 public:
  explicit NativeViewer(NativeViewerConfig config);
  ~NativeViewer();
  NativeViewer(const NativeViewer&) = delete;
  NativeViewer& operator=(const NativeViewer&) = delete;

  [[nodiscard]] bool enabled() const noexcept;
  void replace_model(const mjModel* model, const mjData* data);
  void publish_state(const mjModel* model, const mjData* data);
  void set_active(bool active);
  void shutdown();

 private:
  struct Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace sidecar

#include "native_viewer.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <numeric>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#define GLFW_INCLUDE_NONE
#include <GLFW/glfw3.h>

namespace sidecar {
namespace {

using Clock = std::chrono::steady_clock;

struct ModelDeleter {
  void operator()(mjModel* value) const noexcept {
    if (value) mj_deleteModel(value);
  }
};

struct DataDeleter {
  void operator()(mjData* value) const noexcept {
    if (value) mj_deleteData(value);
  }
};

using ModelPtr = std::unique_ptr<mjModel, ModelDeleter>;
using DataPtr = std::unique_ptr<mjData, DataDeleter>;

double milliseconds(const Clock::duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}

double percentile(std::vector<double> values, const double fraction) {
  if (values.empty()) return 0.0;
  std::sort(values.begin(), values.end());
  const auto index = static_cast<std::size_t>(
      std::ceil(fraction * static_cast<double>(values.size())) - 1.0);
  return values[std::min(index, values.size() - 1U)];
}

struct ModelState {
  ModelPtr model;
  DataPtr snapshot;
  std::mutex snapshot_mutex;
  std::uint64_t generation{0};
};

}  // namespace

NativeViewerConfig NativeViewerConfig::from_environment() {
  const char* enabled = std::getenv("D6_NATIVE_MUJOCO_VIEWER_POC");
  const char* fps = std::getenv("D6_NATIVE_MUJOCO_VIEWER_FPS");
  return resolve_native_viewer_config(enabled ? enabled : "", fps ? fps : "");
}

NativeViewerConfig resolve_native_viewer_config(const std::string_view enabled,
                                                const std::string_view fps) {
  NativeViewerConfig config;
  config.enabled = enabled == "1";
  if (fps == "30") config.fps = 30;
  if (fps == "60") config.fps = 60;
  return config;
}

struct NativeViewer::Implementation {
  explicit Implementation(const NativeViewerConfig value) : config(value) {
  }

  ~Implementation() { shutdown(); }

  void replace_model(const mjModel* source_model, const mjData* source_data) {
    if (!config.enabled || !source_model || !source_data) return;
    ModelPtr model(mj_copyModel(nullptr, source_model));
    if (!model) return;
    DataPtr data(mj_makeData(model.get()));
    if (!data || !mj_copyData(data.get(), model.get(), source_data)) return;
    auto state = std::make_shared<ModelState>();
    state->model = std::move(model);
    state->snapshot = std::move(data);
    {
      std::lock_guard lock(mutex);
      state->generation = ++model_generation;
      pending_model = std::move(state);
      if (!worker.joinable()) worker = std::thread(&Implementation::run, this);
    }
    condition.notify_one();
  }

  void publish_state(const mjModel* source_model, const mjData* source_data) {
    if (!config.enabled || !source_model || !source_data) return;
    std::shared_ptr<ModelState> state;
    {
      std::lock_guard lock(mutex);
      state = pending_model ? pending_model : active_model;
    }
    if (!state || state->model->nq != source_model->nq || state->model->nv != source_model->nv) {
      return;
    }
    const auto wait_started = Clock::now();
    std::unique_lock snapshot_lock(state->snapshot_mutex);
    const auto acquired = Clock::now();
    mj_copyData(state->snapshot.get(), state->model.get(), source_data);
    const auto copied = Clock::now();
    {
      std::lock_guard lock(metrics_mutex);
      snapshot_wait_ms.push_back(milliseconds(acquired - wait_started));
      snapshot_copy_ms.push_back(milliseconds(copied - acquired));
    }
  }

  void set_active(const bool value) {
    active.store(value, std::memory_order_release);
    condition.notify_one();
  }

  void shutdown() {
    if (!config.enabled || !worker.joinable()) return;
    {
      std::lock_guard lock(mutex);
      if (stopping) return;
      stopping = true;
    }
    condition.notify_one();
    if (worker.joinable()) worker.join();
  }

  void report(const Clock::time_point now) {
    std::vector<double> frames;
    std::vector<double> waits;
    std::vector<double> copies;
    {
      std::lock_guard lock(metrics_mutex);
      frames.swap(frame_ms);
      waits.swap(snapshot_wait_ms);
      copies.swap(snapshot_copy_ms);
    }
    const double elapsed = std::chrono::duration<double>(now - report_started).count();
    const auto mean = [](const std::vector<double>& values) {
      return values.empty() ? 0.0
                            : std::accumulate(values.begin(), values.end(), 0.0) /
                                  static_cast<double>(values.size());
    };
    const auto maximum = [](const std::vector<double>& values) {
      return values.empty() ? 0.0 : *std::max_element(values.begin(), values.end());
    };
    std::cerr << std::fixed << std::setprecision(3)
              << "D6_NATIVE_VIEWER fps=" << (elapsed > 0.0 ? frames.size() / elapsed : 0.0)
              << " frame_ms_mean=" << mean(frames)
              << " frame_ms_p95=" << percentile(frames, 0.95)
              << " frame_ms_max=" << maximum(frames)
              << " snapshot_wait_ms_mean=" << mean(waits)
              << " snapshot_wait_ms_p95=" << percentile(waits, 0.95)
              << " snapshot_wait_ms_max=" << maximum(waits)
              << " snapshot_copy_ms_mean=" << mean(copies)
              << " snapshot_copy_ms_p95=" << percentile(copies, 0.95)
              << " snapshot_copy_ms_max=" << maximum(copies)
              << " window_create_count=" << window_create_count
              << " context_create_count=" << context_create_count
              << " scene_rebuild_count=" << scene_rebuild_count << '\n';
    report_started = now;
  }

  static Implementation* from_window(GLFWwindow* window) {
    return static_cast<Implementation*>(glfwGetWindowUserPointer(window));
  }

  static void mouse_button(GLFWwindow* window, int, int, int) {
    auto* viewer = from_window(window);
    glfwGetCursorPos(window, &viewer->last_cursor_x, &viewer->last_cursor_y);
  }

  static void cursor_position(GLFWwindow* window, const double x, const double y) {
    auto* viewer = from_window(window);
    if (!viewer->render_model) return;
    int width = 1;
    int height = 1;
    glfwGetWindowSize(window, &width, &height);
    const double dx = (x - viewer->last_cursor_x) / std::max(width, 1);
    const double dy = (y - viewer->last_cursor_y) / std::max(height, 1);
    viewer->last_cursor_x = x;
    viewer->last_cursor_y = y;
    const bool left = glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS;
    const bool right = glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_RIGHT) == GLFW_PRESS;
    const bool middle = glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_MIDDLE) == GLFW_PRESS;
    if (!left && !right && !middle) return;
    const bool shift = glfwGetKey(window, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS ||
                       glfwGetKey(window, GLFW_KEY_RIGHT_SHIFT) == GLFW_PRESS;
    const mjtMouse action = right ? (shift ? mjMOUSE_MOVE_H : mjMOUSE_MOVE_V)
                                  : left ? (shift ? mjMOUSE_ROTATE_H : mjMOUSE_ROTATE_V)
                                         : mjMOUSE_ZOOM;
    mjv_moveCamera(viewer->render_model, action, dx, dy, &viewer->camera);
  }

  static void scroll(GLFWwindow* window, double, const double y_offset) {
    auto* viewer = from_window(window);
    if (viewer->render_model) {
      mjv_moveCamera(viewer->render_model, mjMOUSE_ZOOM, 0.0, -0.05 * y_offset,
                     &viewer->camera);
    }
  }

  static void key(GLFWwindow* window, const int key_code, int, const int action, int) {
    if (action != GLFW_PRESS || (key_code != GLFW_KEY_HOME && key_code != GLFW_KEY_F)) return;
    auto* viewer = from_window(window);
    if (!viewer->render_data) return;
    viewer->camera.lookat[0] = viewer->render_data->qpos[0];
    viewer->camera.lookat[1] = viewer->render_data->qpos[1];
    viewer->camera.lookat[2] = viewer->render_data->qpos[2];
    viewer->camera.distance = 2.5;
  }

  bool rebuild(const std::shared_ptr<ModelState>& state, mjvScene& scene,
               mjrContext& context) {
    DataPtr data(mj_makeData(state->model.get()));
    if (!data) return false;
    {
      std::lock_guard lock(state->snapshot_mutex);
      if (!mj_copyData(data.get(), state->model.get(), state->snapshot.get())) return false;
    }
    mjr_freeContext(&context);
    mjv_freeScene(&scene);
    mjv_makeScene(state->model.get(), &scene, 2000);
    mjr_makeContext(state->model.get(), &context, mjFONTSCALE_150);
    ++context_create_count;
    ++scene_rebuild_count;
    render_model = state->model.get();
    render_data = std::move(data);
    render_generation = state->generation;
    camera.lookat[0] = render_data->qpos[0];
    camera.lookat[1] = render_data->qpos[1];
    camera.lookat[2] = render_data->qpos[2];
    camera.distance = 2.5;
    return true;
  }

  void run() {
    if (!glfwInit()) {
      std::cerr << "D6_NATIVE_VIEWER_ERROR glfw_init_failed\n";
      return;
    }
    window = glfwCreateWindow(1280, 800, "MuJoCo Go2 Native Viewer POC", nullptr, nullptr);
    if (!window) {
      std::cerr << "D6_NATIVE_VIEWER_ERROR window_create_failed\n";
      glfwTerminate();
      return;
    }
    ++window_create_count;
    glfwMakeContextCurrent(window);
    if (!glfwExtensionSupported("GL_ARB_framebuffer_object")) {
      std::cerr << "D6_NATIVE_VIEWER_ERROR framebuffer_object_unavailable\n";
      glfwDestroyWindow(window);
      window = nullptr;
      ++window_destroy_count;
      glfwTerminate();
      return;
    }
    glfwSwapInterval(0);
    glfwSetWindowUserPointer(window, this);
    glfwSetMouseButtonCallback(window, mouse_button);
    glfwSetCursorPosCallback(window, cursor_position);
    glfwSetScrollCallback(window, scroll);
    glfwSetKeyCallback(window, key);

    mjvCamera camera_value;
    mjvOption option;
    mjvPerturb perturb;
    mjvScene scene;
    mjrContext context;
    mjv_defaultCamera(&camera_value);
    mjv_defaultOption(&option);
    mjv_defaultPerturb(&perturb);
    mjv_defaultScene(&scene);
    mjr_defaultContext(&context);
    camera = camera_value;
    report_started = Clock::now();
    const auto period = std::chrono::duration_cast<Clock::duration>(
        std::chrono::duration<double>(1.0 / static_cast<double>(config.fps)));
    auto next_frame = Clock::now();

    while (!glfwWindowShouldClose(window)) {
      std::shared_ptr<ModelState> state;
      {
        std::unique_lock lock(mutex);
        condition.wait_until(lock, next_frame, [this] {
          return stopping || pending_model || active.load(std::memory_order_acquire);
        });
        if (stopping) break;
        if (pending_model) {
          active_model = std::move(pending_model);
        }
        state = active_model;
      }
      glfwPollEvents();
      if (!state || !active.load(std::memory_order_acquire)) {
        next_frame = Clock::now() + period;
        continue;
      }
      if (state->generation != render_generation && !rebuild(state, scene, context)) {
        next_frame = Clock::now() + period;
        continue;
      }
      const auto frame_started = Clock::now();
      {
        std::lock_guard lock(state->snapshot_mutex);
        mj_copyData(render_data.get(), state->model.get(), state->snapshot.get());
      }
      mjv_updateScene(state->model.get(), render_data.get(), &option, &perturb, &camera,
                      mjCAT_ALL, &scene);
      int width = 0;
      int height = 0;
      glfwGetFramebufferSize(window, &width, &height);
      mjr_render(mjrRect{0, 0, width, height}, &scene, &context);
      glfwSwapBuffers(window);
      const auto frame_finished = Clock::now();
      {
        std::lock_guard lock(metrics_mutex);
        frame_ms.push_back(milliseconds(frame_finished - frame_started));
      }
      if (frame_finished - report_started >= std::chrono::seconds(1)) report(frame_finished);
      next_frame += period;
      if (next_frame < frame_finished) next_frame = frame_finished + period;
      std::this_thread::sleep_until(next_frame);
    }

    mjr_freeContext(&context);
    mjv_freeScene(&scene);
    render_data.reset();
    render_model = nullptr;
    glfwDestroyWindow(window);
    window = nullptr;
    ++window_destroy_count;
    glfwTerminate();
    std::cerr << "D6_NATIVE_VIEWER_DESTROY window_destroy_count=" << window_destroy_count
              << " context_free_count=" << context_create_count
              << " scene_free_count=" << scene_rebuild_count << '\n';
  }

  NativeViewerConfig config;
  std::mutex mutex;
  std::condition_variable condition;
  std::shared_ptr<ModelState> pending_model;
  std::shared_ptr<ModelState> active_model;
  std::uint64_t model_generation{0};
  std::atomic<bool> active{false};
  bool stopping{false};
  std::thread worker;
  GLFWwindow* window{nullptr};
  mjvCamera camera{};
  const mjModel* render_model{nullptr};
  DataPtr render_data;
  std::uint64_t render_generation{0};
  double last_cursor_x{0.0};
  double last_cursor_y{0.0};
  std::mutex metrics_mutex;
  std::vector<double> frame_ms;
  std::vector<double> snapshot_wait_ms;
  std::vector<double> snapshot_copy_ms;
  Clock::time_point report_started{};
  std::uint64_t window_create_count{0};
  std::uint64_t window_destroy_count{0};
  std::uint64_t context_create_count{0};
  std::uint64_t scene_rebuild_count{0};
};

NativeViewer::NativeViewer(const NativeViewerConfig config)
    : implementation_(std::make_unique<Implementation>(config)) {}
NativeViewer::~NativeViewer() = default;
bool NativeViewer::enabled() const noexcept { return implementation_->config.enabled; }
void NativeViewer::replace_model(const mjModel* model, const mjData* data) {
  implementation_->replace_model(model, data);
}
void NativeViewer::publish_state(const mjModel* model, const mjData* data) {
  implementation_->publish_state(model, data);
}
void NativeViewer::set_active(const bool active) { implementation_->set_active(active); }
void NativeViewer::shutdown() { implementation_->shutdown(); }

}  // namespace sidecar

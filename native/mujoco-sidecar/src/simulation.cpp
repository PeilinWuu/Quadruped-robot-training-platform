#include "simulation.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <optional>
#include <system_error>

namespace sidecar {
namespace {
using Json = nlohmann::json;
constexpr double kTimestep = 0.002;
constexpr double kPosePeriod = 1.0 / 60.0;
constexpr int kMaximumCatchupSteps = 10;
constexpr std::array<const char*, 12> kMinimalJointNames = {
    "front_left_hip_abduction", "front_left_hip_flexion", "front_left_knee",
    "front_right_hip_abduction", "front_right_hip_flexion", "front_right_knee",
    "rear_left_hip_abduction", "rear_left_hip_flexion", "rear_left_knee",
    "rear_right_hip_abduction", "rear_right_hip_flexion", "rear_right_knee"};
constexpr std::array<const char*, 12> kGo2JointNames = {
    "FL_hip_joint", "FL_thigh_joint", "FL_calf_joint",
    "FR_hip_joint", "FR_thigh_joint", "FR_calf_joint",
    "RL_hip_joint", "RL_thigh_joint", "RL_calf_joint",
    "RR_hip_joint", "RR_thigh_joint", "RR_calf_joint"};

struct ModelDefinition {
  std::filesystem::path relative_path;
  const std::array<const char*, 12>* joints;
  bool test_pose_hold;
};

std::optional<ModelDefinition> model_definition(const std::string& model_id) {
  if (model_id == "minimal-quadruped-v1") {
    return ModelDefinition{std::filesystem::path("resources") / "simulation" /
      "models" / "minimal-quadruped-v1.xml", &kMinimalJointNames, false};
  }
  if (model_id == "unitree-go2-menagerie") {
    return ModelDefinition{std::filesystem::path("resources") / "simulation" /
      "models" / "unitree-go2-menagerie" / "unitree-go2-scene.xml", &kGo2JointNames, true};
  }
  return std::nullopt;
}

std::int64_t unix_milliseconds() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

std::array<double, 4> multiply(const std::array<double, 4>& a,
                               const std::array<double, 4>& b) {
  return {a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
          a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
          a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
          a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]};
}

EngineResult error(const char* code) { return {false, Json::object(), code}; }
}  // namespace

std::array<double, 3> convert_position(const std::array<double, 3>& p) {
  return {p[0], p[2], -p[1]};
}

std::array<double, 4> convert_quaternion_wxyz(const std::array<double, 4>& q) {
  constexpr double c = 0.7071067811865475244;
  const std::array<double, 4> basis{c, -c, 0.0, 0.0};
  const std::array<double, 4> inverse{c, c, 0.0, 0.0};
  auto converted = multiply(multiply(basis, q), inverse);
  const double norm = std::sqrt(converted[0] * converted[0] + converted[1] * converted[1] +
                                converted[2] * converted[2] + converted[3] * converted[3]);
  if (!(norm > 0.0) || !std::isfinite(norm)) return {0.0, 0.0, 0.0, 1.0};
  for (double& value : converted) value /= norm;
  return {converted[1], converted[2], converted[3], converted[0]};
}

const char* simulation_state_name(const SimulationState state) {
  switch (state) {
    case SimulationState::unloaded: return "unloaded";
    case SimulationState::loaded: return "loaded";
    case SimulationState::running: return "running";
    case SimulationState::paused: return "paused";
    case SimulationState::stopped: return "stopped";
  }
  return "unloaded";
}

void SimulationEngine::ModelDeleter::operator()(mjModel* value) const noexcept { if (value) mj_deleteModel(value); }
void SimulationEngine::DataDeleter::operator()(mjData* value) const noexcept { if (value) mj_deleteData(value); }

SimulationEngine::SimulationEngine(std::filesystem::path resource_root, PoseSink pose_sink)
    : resource_root_(std::move(resource_root)), pose_sink_(std::move(pose_sink)),
      physics_thread_(&SimulationEngine::physics_loop, this) {}

SimulationEngine::~SimulationEngine() { shutdown(); }

void SimulationEngine::shutdown() {
  {
    std::lock_guard lock(mutex_);
    if (quitting_) return;
    quitting_ = true;
    state_ = SimulationState::stopped;
  }
  condition_.notify_all();
  if (physics_thread_.joinable()) physics_thread_.join();
}

EngineResult SimulationEngine::load_model(const std::string& model_id) {
  const auto definition = model_definition(model_id);
  if (!definition) return error("UNKNOWN_MODEL");
  {
    std::lock_guard lock(mutex_);
    if (state_ == SimulationState::running) state_ = SimulationState::stopped;
  }
  condition_.notify_all();
  std::error_code ec;
  const auto root = std::filesystem::canonical(resource_root_, ec);
  if (ec) return error("MODEL_LOAD_FAILED");
  const auto path = std::filesystem::canonical(root / definition->relative_path, ec);
  const auto resolved_relative = std::filesystem::relative(path, root, ec);
  const bool escapes_root = ec || resolved_relative.is_absolute() ||
      std::any_of(resolved_relative.begin(), resolved_relative.end(),
                  [](const auto& component) { return component == ".."; });
  if (escapes_root || !std::filesystem::is_regular_file(path, ec) || ec) return error("MODEL_LOAD_FAILED");
  char load_error[1024]{};
  ModelPtr candidate(mj_loadXML(path.string().c_str(), nullptr, load_error, sizeof(load_error)));
  if (!candidate) return error("MODEL_LOAD_FAILED");
  DataPtr candidate_data(mj_makeData(candidate.get()));
  if (!candidate_data || mjVERSION_HEADER != 3011000 || mj_version() != mjVERSION_HEADER ||
      std::abs(candidate->opt.timestep - kTimestep) > 1e-12 || candidate->nu != 12) {
    return error("MODEL_LOAD_FAILED");
  }
  std::vector<int> qpos_addresses;
  std::vector<int> dof_addresses;
  for (const char* name : *definition->joints) {
    const int id = mj_name2id(candidate.get(), mjOBJ_JOINT, name);
    if (id < 0 || candidate->jnt_type[id] != mjJNT_HINGE) return error("MODEL_LOAD_FAILED");
    if (model_id == "unitree-go2-menagerie") {
      const std::size_t index = qpos_addresses.size();
      const std::array<double, 3> expected_axis = index % 3 == 0
          ? std::array<double, 3>{1.0, 0.0, 0.0}
          : std::array<double, 3>{0.0, 1.0, 0.0};
      for (std::size_t component = 0; component < expected_axis.size(); ++component) {
        if (std::abs(candidate->jnt_axis[id * 3 + static_cast<int>(component)] -
                     expected_axis[component]) > 1e-12) return error("MODEL_LOAD_FAILED");
      }
    }
    qpos_addresses.push_back(candidate->jnt_qposadr[id]);
    dof_addresses.push_back(candidate->jnt_dofadr[id]);
  }
  int free_joints = 0;
  for (int index = 0; index < candidate->njnt; ++index) if (candidate->jnt_type[index] == mjJNT_FREE) ++free_joints;
  const int home_keyframe = mj_name2id(candidate.get(), mjOBJ_KEY, "home");
  if (free_joints != 1 || home_keyframe < 0) return error("MODEL_LOAD_FAILED");
  for (int index = 0; index < candidate->nu; ++index) {
    const int joint_id = mj_name2id(candidate.get(), mjOBJ_JOINT, (*definition->joints)[static_cast<std::size_t>(index)]);
    if (candidate->actuator_trntype[index] != mjTRN_JOINT || candidate->actuator_trnid[index * 2] != joint_id) {
      return error("MODEL_LOAD_FAILED");
    }
  }
  mj_resetDataKeyframe(candidate.get(), candidate_data.get(), home_keyframe);
  mj_forward(candidate.get(), candidate_data.get());
  std::vector<double> home_positions;
  for (const int address : qpos_addresses) home_positions.push_back(candidate_data->qpos[address]);
  {
    std::lock_guard lock(mutex_);
    state_ = SimulationState::loaded;
    model_ = std::move(candidate);
    data_ = std::move(candidate_data);
    joint_qpos_addresses_ = std::move(qpos_addresses);
    joint_dof_addresses_ = std::move(dof_addresses);
    joint_names_.assign(definition->joints->begin(), definition->joints->end());
    home_joint_positions_ = std::move(home_positions);
    home_keyframe_ = home_keyframe;
    test_pose_hold_ = definition->test_pose_hold;
    sequence_ = 0;
    control_phase_ = 0;
    speed_ = 1.0;
    mj_resetDataKeyframe(model_.get(), data_.get(), home_keyframe_);
    mj_forward(model_.get(), data_.get());
    latest_pose_ = pose_locked(false);
    return {true, Json{{"modelId", model_id}, {"timestep", model_->opt.timestep},
                       {"jointCount", joint_names_.size()}, {"actuatorCount", model_->nu},
                       {"bodyCount", model_->nbody}}, {}};
  }
}

EngineResult SimulationEngine::invalid_state() const { return error("INVALID_SIMULATION_STATE"); }
Json SimulationEngine::state_payload_locked() const { return Json{{"state", simulation_state_name(state_)}, {"speed", speed_}}; }

EngineResult SimulationEngine::start() {
  std::lock_guard lock(mutex_);
  if (!model_ || !(state_ == SimulationState::loaded || state_ == SimulationState::paused || state_ == SimulationState::stopped)) return invalid_state();
  state_ = SimulationState::running;
  condition_.notify_all();
  return {true, state_payload_locked(), {}};
}

EngineResult SimulationEngine::pause() {
  Json pose;
  EngineResult result;
  {
    std::lock_guard lock(mutex_);
    if (state_ != SimulationState::running) return invalid_state();
    state_ = SimulationState::paused;
    pose = pose_locked(true);
    result = {true, state_payload_locked(), {}};
  }
  pose_sink_(std::move(pose));
  return result;
}

EngineResult SimulationEngine::step(const int steps) {
  std::lock_guard lock(mutex_);
  if (!model_ || !(state_ == SimulationState::loaded || state_ == SimulationState::paused || state_ == SimulationState::stopped)) return invalid_state();
  if (steps < 1 || steps > 1000) return error("INVALID_PAYLOAD");
  for (int index = 0; index < steps; ++index) step_once_locked();
  latest_pose_ = pose_locked(true);
  return {true, latest_pose_, {}};
}

EngineResult SimulationEngine::reset() {
  Json pose;
  EngineResult result;
  {
    std::lock_guard lock(mutex_);
    if (!model_ || state_ == SimulationState::running) return invalid_state();
    mj_resetDataKeyframe(model_.get(), data_.get(), home_keyframe_);
    mj_forward(model_.get(), data_.get());
    sequence_ = 0;
    control_phase_ = 0;
    state_ = SimulationState::loaded;
    pose = pose_locked(false);
    latest_pose_ = pose;
    result = {true, state_payload_locked(), {}};
  }
  pose_sink_(std::move(pose));
  return result;
}

EngineResult SimulationEngine::stop() {
  std::lock_guard lock(mutex_);
  if (!model_ || state_ == SimulationState::unloaded) return invalid_state();
  state_ = SimulationState::stopped;
  return {true, state_payload_locked(), {}};
}

EngineResult SimulationEngine::set_speed(const double speed) {
  std::lock_guard lock(mutex_);
  if (!std::isfinite(speed) || speed < 0.25 || speed > 4.0) return error("INVALID_PAYLOAD");
  speed_ = speed;
  return {true, state_payload_locked(), {}};
}

SimulationState SimulationEngine::state() const { std::lock_guard lock(mutex_); return state_; }
Json SimulationEngine::latest_pose() const { std::lock_guard lock(mutex_); return latest_pose_; }

Json SimulationEngine::pose_locked(const bool advance_sequence) {
  if (advance_sequence) ++sequence_;
  const auto position = convert_position({data_->qpos[0], data_->qpos[1], data_->qpos[2]});
  const auto orientation = convert_quaternion_wxyz({data_->qpos[3], data_->qpos[4], data_->qpos[5], data_->qpos[6]});
  Json joints = Json::array();
  for (std::size_t index = 0; index < joint_names_.size(); ++index) {
    joints.push_back(Json{{"name", joint_names_[index]}, {"position", data_->qpos[joint_qpos_addresses_[index]]}});
  }
  return Json{{"sequence", sequence_}, {"simulationTime", data_->time}, {"wallTime", unix_milliseconds()},
              {"rootPosition", position}, {"rootOrientation", orientation}, {"joints", std::move(joints)}};
}

void SimulationEngine::step_once_locked() {
  if (test_pose_hold_) {
    // Menagerie Go2 uses direct-torque motor actuators. This bounded PD term is only a
    // stationary preview hold; it is deliberately not presented as a gait controller.
    constexpr double kPositionGain = 35.0;
    constexpr double kVelocityGain = 1.5;
    for (int index = 0; index < model_->nu; ++index) {
      const double target = home_joint_positions_[static_cast<std::size_t>(index)];
      const double position = data_->qpos[joint_qpos_addresses_[static_cast<std::size_t>(index)]];
      const double velocity = data_->qvel[joint_dof_addresses_[static_cast<std::size_t>(index)]];
      const double effort = kPositionGain * (target - position) - kVelocityGain * velocity;
      data_->ctrl[index] = std::clamp(effort, model_->actuator_ctrlrange[index * 2],
                                     model_->actuator_ctrlrange[index * 2 + 1]);
    }
  } else if (control_phase_ == 0 && model_->nkey > 0 && model_->key_ctrl != nullptr) {
    for (int index = 0; index < model_->nu; ++index) data_->ctrl[index] = model_->key_ctrl[index];
  }
  control_phase_ = (control_phase_ + 1U) % 5U;
  mj_step(model_.get(), data_.get());
}

void SimulationEngine::physics_loop() {
  using Clock = std::chrono::steady_clock;
  auto next = Clock::now();
  auto last_publish = Clock::now() - std::chrono::duration_cast<Clock::duration>(
                                         std::chrono::duration<double>(kPosePeriod));
  std::unique_lock lock(mutex_);
  while (!quitting_) {
    condition_.wait(lock, [this] { return quitting_ || state_ == SimulationState::running; });
    if (quitting_) break;
    next = Clock::now();
    last_publish = next - std::chrono::duration_cast<Clock::duration>(
                              std::chrono::duration<double>(kPosePeriod));
    while (!quitting_ && state_ == SimulationState::running) {
      const auto interval = std::chrono::duration<double>(kTimestep / speed_);
      next += std::chrono::duration_cast<Clock::duration>(interval);
      const auto now = Clock::now();
      int steps = 1;
      if (now > next) {
        const auto behind = std::chrono::duration<double>(now - next).count();
        steps = std::min(kMaximumCatchupSteps, 1 + static_cast<int>(behind / interval.count()));
      }
      if (steps > 1) {
        next += std::chrono::duration_cast<Clock::duration>(interval * (steps - 1));
      }
      for (int index = 0; index < steps; ++index) step_once_locked();
      Json pose;
      const auto publish_period = std::chrono::duration_cast<Clock::duration>(
          std::chrono::duration<double>(kPosePeriod));
      if (now - last_publish >= publish_period) {
        pose = pose_locked(true);
        latest_pose_ = pose;
        last_publish += publish_period;
        if (now - last_publish > publish_period) last_publish = now;
      }
      lock.unlock();
      if (!pose.is_null()) pose_sink_(std::move(pose));
      const auto coarse_deadline = next - std::chrono::microseconds(1500);
      if (Clock::now() < coarse_deadline) std::this_thread::sleep_until(coarse_deadline);
      while (Clock::now() < next) {
        // A short spin avoids Windows scheduler quantization at the 2 ms physics cadence.
      }
      lock.lock();
      if (Clock::now() - next > std::chrono::milliseconds(100)) next = Clock::now();
    }
  }
}

}  // namespace sidecar

#include "simulation.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <optional>
#include <system_error>

namespace sidecar {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr double kTimestep = 0.002;
constexpr double kPosePeriod = 1.0 / 60.0;
constexpr int kMaximumCatchupSteps = 10;
constexpr double kContactThresholdNewton = 0.01;
constexpr double kFallDebounceSeconds = 0.2;
constexpr double kImpactCooldownSeconds = 0.5;
constexpr const char* kEnvironmentId = "flat-ground-v1";
constexpr const char* kGroundGeomName = "flat-ground-v1-floor";
constexpr std::array<const char*, 4> kFootLabels = {"FL", "FR", "RL", "RR"};
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
constexpr std::array<const char*, 4> kMinimalFootGeoms = {
    "front_left_foot", "front_right_foot", "rear_left_foot", "rear_right_foot"};
constexpr std::array<const char*, 4> kGo2FootGeoms = {"FL", "FR", "RL", "RR"};

struct ModelDefinition {
  std::filesystem::path relative_path;
  const std::array<const char*, 12>* joints;
  const std::array<const char*, 4>* foot_geoms;
  const char* imu_site;
  bool test_pose_hold;
  double fall_height_threshold;
  double impact_threshold;
};

std::optional<ModelDefinition> model_definition(const std::string& model_id) {
  if (model_id == "minimal-quadruped-v1") {
    return ModelDefinition{std::filesystem::path("resources") / "simulation" / "models" /
      "minimal-quadruped-v1.xml", &kMinimalJointNames, &kMinimalFootGeoms, nullptr, false,
      0.30, 120.0};
  }
  if (model_id == "unitree-go2-menagerie") {
    return ModelDefinition{std::filesystem::path("resources") / "simulation" / "models" /
      "unitree-go2-flat-ground-v1.xml", &kGo2JointNames,
      &kGo2FootGeoms, "imu", true, 0.16, 180.0};
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

double norm3(const std::array<double, 3>& value) {
  return std::sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

Json vector3(const std::array<double, 3>& value) {
  return Json::array({value[0], value[1], value[2]});
}

Json quaternion(const std::array<double, 4>& value) {
  return Json::array({value[0], value[1], value[2], value[3]});
}

EngineResult error(const char* code) { return {false, Json::object(), code}; }

bool exact_name(const char* value, const std::initializer_list<const char*> names) {
  if (!value) return false;
  return std::any_of(names.begin(), names.end(), [value](const char* name) {
    return std::string_view(value) == name;
  });
}

CollisionCategory category_for_geom(const mjModel* model, const int geom_id,
                                    const std::string& model_id,
                                    const std::array<int, 4>& foot_ids) {
  if (std::find(foot_ids.begin(), foot_ids.end(), geom_id) != foot_ids.end()) {
    return CollisionCategory::feet;
  }
  const int body_id = model->geom_bodyid[geom_id];
  if (body_id == 0) return CollisionCategory::environment;
  const char* body = mj_id2name(model, mjOBJ_BODY, body_id);
  const char* geom = mj_id2name(model, mjOBJ_GEOM, geom_id);
  if (model_id == "minimal-quadruped-v1") {
    if (geom && std::string_view(geom) == "trunk_collision") return CollisionCategory::torso;
    if (geom && std::string_view(geom) == "head_collision") return CollisionCategory::head;
    if (exact_name(body, {"front_left_hip", "front_right_hip", "rear_left_hip", "rear_right_hip"})) return CollisionCategory::hips;
    if (exact_name(body, {"front_left_thigh", "front_right_thigh", "rear_left_thigh", "rear_right_thigh"})) return CollisionCategory::thighs;
    if (exact_name(body, {"front_left_shin", "front_right_shin", "rear_left_shin", "rear_right_shin"})) return CollisionCategory::calves;
  } else {
    if (exact_name(body, {"FL_hip", "FR_hip", "RL_hip", "RR_hip"})) return CollisionCategory::hips;
    if (exact_name(body, {"FL_thigh", "FR_thigh", "RL_thigh", "RR_thigh"})) return CollisionCategory::thighs;
    if (exact_name(body, {"FL_calf", "FR_calf", "RL_calf", "RR_calf"})) return CollisionCategory::calves;
    if (body && std::string_view(body) == "base") {
      int collision_ordinal = 0;
      for (int index = 0; index < geom_id; ++index) {
        if (model->geom_bodyid[index] == body_id && model->geom_contype[index] != 0) ++collision_ordinal;
      }
      return collision_ordinal == 0 ? CollisionCategory::torso : CollisionCategory::head;
    }
  }
  return CollisionCategory::other_robot;
}

std::string profile_geom_name(const mjModel* model, const int geom_id,
                              const CollisionCategory category) {
  if (const char* name = mj_id2name(model, mjOBJ_GEOM, geom_id)) return name;
  const int body_id = model->geom_bodyid[geom_id];
  const char* body = mj_id2name(model, mjOBJ_BODY, body_id);
  int ordinal = 0;
  for (int index = 0; index < geom_id; ++index) {
    if (model->geom_bodyid[index] == body_id && model->geom_contype[index] != 0) ++ordinal;
  }
  return std::string(body ? body : "robot") + "_" + collision_category_name(category) +
      "_collision_" + std::to_string(ordinal);
}

Json environment_json(const EnvironmentMetadata& value) {
  return Json{{"id", value.id}, {"displayName", value.display_name},
    {"floorHeight", value.floor_height}, {"halfExtent", value.half_extent},
    {"demoBoundaryHalfExtent", value.demo_boundary_half_extent},
    {"spawnPosition", vector3(value.spawn_position)},
    {"spawnOrientation", quaternion(value.spawn_orientation)},
    {"friction", Json::array({value.friction[0], value.friction[1], value.friction[2]})},
    {"solref", Json::array({value.solref[0], value.solref[1]})},
    {"solimp", Json::array({value.solimp[0], value.solimp[1], value.solimp[2]})}};
}
}  // namespace

const EnvironmentMetadata& flat_ground_environment() {
  static const EnvironmentMetadata metadata{};
  return metadata;
}

const char* collision_category_name(const CollisionCategory category) {
  switch (category) {
    case CollisionCategory::feet: return "feet";
    case CollisionCategory::calves: return "calves";
    case CollisionCategory::thighs: return "thighs";
    case CollisionCategory::hips: return "hips";
    case CollisionCategory::torso: return "torso";
    case CollisionCategory::head: return "head";
    case CollisionCategory::other_robot: return "otherRobot";
    case CollisionCategory::environment: return "environment";
  }
  return "otherRobot";
}

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

bool valid_motion_command(const MotionCommand& command) {
  return std::isfinite(command.forward_velocity) &&
      std::isfinite(command.lateral_velocity) && std::isfinite(command.yaw_rate) &&
      std::isfinite(command.body_height) &&
      command.forward_velocity >= -1.5 && command.forward_velocity <= 1.5 &&
      command.lateral_velocity >= -1.0 && command.lateral_velocity <= 1.0 &&
      command.yaw_rate >= -2.0 && command.yaw_rate <= 2.0 &&
      command.body_height >= 0.18 && command.body_height <= 0.40 &&
      command.valid_for_ms >= 100 && command.valid_for_ms <= 2000;
}

void SimulationEngine::ModelDeleter::operator()(mjModel* value) const noexcept { if (value) mj_deleteModel(value); }
void SimulationEngine::DataDeleter::operator()(mjData* value) const noexcept { if (value) mj_deleteData(value); }

SimulationEngine::SimulationEngine(std::filesystem::path resource_root, EventSink event_sink)
    : resource_root_(std::move(resource_root)), event_sink_(std::move(event_sink)),
      physics_thread_(&SimulationEngine::physics_loop, this) {}

SimulationEngine::SimulationEngine(std::filesystem::path resource_root, LegacyPoseSink pose_sink)
    : SimulationEngine(std::move(resource_root),
        [sink = std::move(pose_sink)](const EventKind kind, Json payload) {
          if (kind == EventKind::pose) sink(std::move(payload));
          return false;
        }) {}

SimulationEngine::~SimulationEngine() { shutdown(); }

void SimulationEngine::shutdown() {
  {
    std::lock_guard lock(mutex_);
    if (quitting_) return;
    quitting_ = true;
    state_ = SimulationState::stopped;
    clear_motion_locked();
  }
  condition_.notify_all();
  if (physics_thread_.joinable()) physics_thread_.join();
}

EngineResult SimulationEngine::load_model(const std::string& model_id,
                                          const std::string& environment_id) {
  if (environment_id != kEnvironmentId) return error("UNKNOWN_ENVIRONMENT");
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
  std::vector<int> joint_ids;
  std::vector<int> qpos_addresses;
  std::vector<int> dof_addresses;
  std::vector<int> actuator_ids;
  for (const char* name : *definition->joints) {
    const int id = mj_name2id(candidate.get(), mjOBJ_JOINT, name);
    if (id < 0 || candidate->jnt_type[id] != mjJNT_HINGE) return error("MODEL_LOAD_FAILED");
    joint_ids.push_back(id);
    qpos_addresses.push_back(candidate->jnt_qposadr[id]);
    dof_addresses.push_back(candidate->jnt_dofadr[id]);
    int actuator_id = -1;
    for (int index = 0; index < candidate->nu; ++index) {
      if (candidate->actuator_trntype[index] == mjTRN_JOINT &&
          candidate->actuator_trnid[index * 2] == id) {
        if (actuator_id >= 0) return error("MODEL_LOAD_FAILED");
        actuator_id = index;
      }
    }
    if (actuator_id < 0) return error("MODEL_LOAD_FAILED");
    actuator_ids.push_back(actuator_id);
  }
  int root_body_id = -1;
  int free_joints = 0;
  for (int index = 0; index < candidate->njnt; ++index) {
    if (candidate->jnt_type[index] == mjJNT_FREE) {
      ++free_joints;
      root_body_id = candidate->jnt_bodyid[index];
    }
  }
  std::array<int, 4> foot_geom_ids{};
  for (std::size_t index = 0; index < foot_geom_ids.size(); ++index) {
    foot_geom_ids[index] = mj_name2id(candidate.get(), mjOBJ_GEOM, (*definition->foot_geoms)[index]);
    if (foot_geom_ids[index] < 0 || candidate->geom_bodyid[foot_geom_ids[index]] == 0) return error("MODEL_LOAD_FAILED");
  }
  const int ground_geom_id = mj_name2id(candidate.get(), mjOBJ_GEOM, kGroundGeomName);
  if (ground_geom_id < 0 || candidate->geom_bodyid[ground_geom_id] != 0 ||
      candidate->geom_type[ground_geom_id] != mjGEOM_PLANE ||
      std::abs(candidate->geom_pos[ground_geom_id * 3 + 2]) > 1e-12 ||
      std::abs(candidate->geom_size[ground_geom_id * 3] - 10.0) > 1e-12 ||
      std::abs(candidate->geom_size[ground_geom_id * 3 + 1] - 10.0) > 1e-12) {
    return error("MODEL_LOAD_FAILED");
  }
  std::vector<CollisionCategory> geom_categories;
  std::vector<std::string> geom_profile_names;
  geom_categories.reserve(static_cast<std::size_t>(candidate->ngeom));
  geom_profile_names.reserve(static_cast<std::size_t>(candidate->ngeom));
  for (int geom = 0; geom < candidate->ngeom; ++geom) {
    const auto category = category_for_geom(candidate.get(), geom, model_id, foot_geom_ids);
    geom_categories.push_back(category);
    geom_profile_names.push_back(profile_geom_name(candidate.get(), geom, category));
  }
  const int imu_site_id = definition->imu_site
      ? mj_name2id(candidate.get(), mjOBJ_SITE, definition->imu_site) : -1;
  const int home_keyframe = mj_name2id(candidate.get(), mjOBJ_KEY, "home");
  if (free_joints != 1 || root_body_id <= 0 || home_keyframe < 0 ||
      (definition->imu_site && imu_site_id < 0)) return error("MODEL_LOAD_FAILED");
  mj_resetDataKeyframe(candidate.get(), candidate_data.get(), home_keyframe);
  mj_forward(candidate.get(), candidate_data.get());
  std::vector<double> home_positions;
  for (const int address : qpos_addresses) home_positions.push_back(candidate_data->qpos[address]);
  {
    std::lock_guard lock(mutex_);
    state_ = SimulationState::loaded;
    model_ = std::move(candidate);
    data_ = std::move(candidate_data);
    model_id_ = model_id;
    environment_id_ = environment_id;
    joint_ids_ = std::move(joint_ids);
    joint_qpos_addresses_ = std::move(qpos_addresses);
    joint_dof_addresses_ = std::move(dof_addresses);
    actuator_ids_ = std::move(actuator_ids);
    joint_names_.assign(definition->joints->begin(), definition->joints->end());
    foot_geom_ids_ = foot_geom_ids;
    ground_geom_id_ = ground_geom_id;
    geom_categories_ = std::move(geom_categories);
    geom_profile_names_ = std::move(geom_profile_names);
    root_body_id_ = root_body_id;
    imu_site_id_ = imu_site_id;
    home_joint_positions_ = std::move(home_positions);
    home_keyframe_ = home_keyframe;
    test_pose_hold_ = definition->test_pose_hold;
    fall_height_threshold_ = definition->fall_height_threshold;
    impact_threshold_ = definition->impact_threshold;
    pose_sequence_ = 0;
    telemetry_sequence_ = 0;
    control_phase_ = 0;
    speed_ = 1.0;
    telemetry_rate_hz_ = 50;
    clear_motion_locked();
    pending_collision_events_.clear();
    non_foot_collision_active_ = false;
    fallen_ = false;
    out_of_bounds_ = false;
    fall_candidate_since_ = -1.0;
    last_impact_time_ = -1.0;
    reset_statistics_locked();
    mj_resetDataKeyframe(model_.get(), data_.get(), home_keyframe_);
    mj_forward(model_.get(), data_.get());
    latest_pose_ = pose_locked(false);
    latest_collision_ = collision_telemetry_locked();
    latest_telemetry_ = telemetry_locked(false);
    auto environment = flat_ground_environment();
    environment.spawn_position = convert_position({data_->qpos[0], data_->qpos[1], data_->qpos[2]});
    environment.spawn_orientation = convert_quaternion_wxyz(
        {data_->qpos[3], data_->qpos[4], data_->qpos[5], data_->qpos[6]});
    return {true, Json{{"modelId", model_id}, {"environmentId", environment_id_},
                       {"environment", environment_json(environment)},
                       {"timestep", model_->opt.timestep},
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
  reset_statistics_locked();
  condition_.notify_all();
  return {true, state_payload_locked(), {}};
}

EngineResult SimulationEngine::pause() {
  Json pose;
  Json telemetry;
  EngineResult result;
  {
    std::lock_guard lock(mutex_);
    if (state_ != SimulationState::running) return invalid_state();
    state_ = SimulationState::paused;
    pose = pose_locked(true);
    telemetry = telemetry_locked(true);
    result = {true, state_payload_locked(), {}};
  }
  publish(EventKind::pose, std::move(pose));
  publish(EventKind::telemetry, std::move(telemetry));
  return result;
}

EngineResult SimulationEngine::step(const int steps) {
  Json pose;
  Json telemetry;
  std::vector<Json> collision_events;
  {
    std::lock_guard lock(mutex_);
    if (!model_ || !(state_ == SimulationState::loaded || state_ == SimulationState::paused || state_ == SimulationState::stopped)) return invalid_state();
    if (steps < 1 || steps > 1000) return error("INVALID_PAYLOAD");
    for (int index = 0; index < steps; ++index) step_once_locked();
    pose = pose_locked(true);
    latest_pose_ = pose;
    telemetry = telemetry_locked(true);
    collision_events = take_collision_events_locked();
  }
  publish(EventKind::telemetry, std::move(telemetry));
  for (auto& event : collision_events) publish(EventKind::collision, std::move(event));
  return {true, std::move(pose), {}};
}

EngineResult SimulationEngine::reset() {
  Json pose;
  Json telemetry;
  std::vector<Json> collision_events;
  EngineResult result;
  {
    std::lock_guard lock(mutex_);
    if (!model_ || state_ == SimulationState::running) return invalid_state();
    mj_resetDataKeyframe(model_.get(), data_.get(), home_keyframe_);
    mj_forward(model_.get(), data_.get());
    pose_sequence_ = 0;
    telemetry_sequence_ = 0;
    control_phase_ = 0;
    state_ = SimulationState::loaded;
    clear_motion_locked();
    if (fallen_) {
      pending_collision_events_.push_back(Json{{"kind", "recovered"},
        {"simulationTime", 0.0}, {"category", "torso"}, {"bodyName", ""},
        {"geomName", ""}, {"normalForce", 0.0},
        {"positionWorld", Json::array({0.0, 0.0, 0.0})}});
    }
    non_foot_collision_active_ = false;
    fallen_ = false;
    out_of_bounds_ = false;
    fall_candidate_since_ = -1.0;
    last_impact_time_ = -1.0;
    reset_statistics_locked();
    pose = pose_locked(false);
    latest_pose_ = pose;
    latest_collision_ = collision_telemetry_locked();
    telemetry = telemetry_locked(false);
    collision_events = take_collision_events_locked();
    result = {true, state_payload_locked(), {}};
  }
  publish(EventKind::pose, std::move(pose));
  publish(EventKind::telemetry, std::move(telemetry));
  for (auto& event : collision_events) publish(EventKind::collision, std::move(event));
  return result;
}

EngineResult SimulationEngine::stop() {
  Json telemetry;
  EngineResult result;
  {
    std::lock_guard lock(mutex_);
    if (!model_ || state_ == SimulationState::unloaded) return invalid_state();
    state_ = SimulationState::stopped;
    clear_motion_locked();
    telemetry = telemetry_locked(true);
    result = {true, state_payload_locked(), {}};
  }
  publish(EventKind::telemetry, std::move(telemetry));
  return result;
}

EngineResult SimulationEngine::set_speed(const double speed) {
  std::lock_guard lock(mutex_);
  if (!std::isfinite(speed) || speed < 0.25 || speed > 4.0) return error("INVALID_PAYLOAD");
  speed_ = speed;
  return {true, state_payload_locked(), {}};
}

EngineResult SimulationEngine::set_motion_command(const MotionCommand& input) {
  Json status;
  Json telemetry;
  {
    std::lock_guard lock(mutex_);
    if (!model_) return invalid_state();
    if (!valid_motion_command(input)) return error("INVALID_PAYLOAD");
    motion_command_ = input;
    if (motion_command_.mode == MotionMode::stand) {
      motion_command_.forward_velocity = 0.0;
      motion_command_.lateral_velocity = 0.0;
      motion_command_.yaw_rate = 0.0;
    }
    motion_received_at_ = Clock::now();
    motion_timed_out_ = false;
    status = motion_status_locked();
    telemetry = telemetry_locked(true);
    latest_telemetry_ = telemetry;
  }
  publish(EventKind::motion_command, status);
  publish(EventKind::telemetry, std::move(telemetry));
  return {true, std::move(status), {}};
}

EngineResult SimulationEngine::clear_motion_command() {
  Json status;
  Json telemetry;
  {
    std::lock_guard lock(mutex_);
    if (!model_) return invalid_state();
    clear_motion_locked();
    status = motion_status_locked();
    telemetry = telemetry_locked(true);
    latest_telemetry_ = telemetry;
  }
  publish(EventKind::motion_command, status);
  publish(EventKind::telemetry, std::move(telemetry));
  return {true, std::move(status), {}};
}

EngineResult SimulationEngine::set_telemetry_rate(const int hz) {
  Json config;
  {
    std::lock_guard lock(mutex_);
    if (hz < 10 || hz > 100) return error("INVALID_PAYLOAD");
    telemetry_rate_hz_ = hz;
    config = Json{{"rateHz", telemetry_rate_hz_}};
  }
  publish(EventKind::telemetry_config, config);
  return {true, std::move(config), {}};
}

EngineResult SimulationEngine::get_latest_telemetry() {
  std::lock_guard lock(mutex_);
  if (!model_) return invalid_state();
  latest_telemetry_ = telemetry_locked(false);
  return {true, latest_telemetry_, {}};
}

SimulationState SimulationEngine::state() const { std::lock_guard lock(mutex_); return state_; }
Json SimulationEngine::latest_pose() const { std::lock_guard lock(mutex_); return latest_pose_; }

#ifdef SIDECAR_TESTING
Json SimulationEngine::test_collision_profile() const {
  std::lock_guard lock(mutex_);
  Json result = Json::array();
  if (!model_) return result;
  for (int geom = 0; geom < model_->ngeom; ++geom) {
    if (model_->geom_contype[geom] == 0 && geom != ground_geom_id_) continue;
    const int body_id = model_->geom_bodyid[geom];
    const char* body = mj_id2name(model_.get(), mjOBJ_BODY, body_id);
    result.push_back(Json{{"geomName", geom_profile_names_[static_cast<std::size_t>(geom)]},
      {"bodyName", body ? body : "world"},
      {"category", collision_category_name(geom_categories_[static_cast<std::size_t>(geom)])}});
  }
  return result;
}

bool SimulationEngine::test_set_root_state(const std::array<double, 3>& position,
                                           const std::array<double, 4>& quaternion_wxyz) {
  std::lock_guard lock(mutex_);
  if (!model_ || !data_) return false;
  for (double value : position) if (!std::isfinite(value)) return false;
  double norm = 0.0;
  for (double value : quaternion_wxyz) {
    if (!std::isfinite(value)) return false;
    norm += value * value;
  }
  if (norm <= std::numeric_limits<double>::epsilon()) return false;
  norm = std::sqrt(norm);
  for (int axis = 0; axis < 3; ++axis) data_->qpos[axis] = position[static_cast<std::size_t>(axis)];
  for (int axis = 0; axis < 4; ++axis) data_->qpos[axis + 3] = quaternion_wxyz[static_cast<std::size_t>(axis)] / norm;
  std::fill(data_->qvel, data_->qvel + model_->nv, 0.0);
  mj_forward(model_.get(), data_.get());
  update_collision_state_locked();
  latest_pose_ = pose_locked(false);
  latest_telemetry_ = telemetry_locked(false);
  return true;
}
#endif

Json SimulationEngine::pose_locked(const bool advance_sequence) {
  if (advance_sequence) ++pose_sequence_;
  const auto position = convert_position({data_->qpos[0], data_->qpos[1], data_->qpos[2]});
  const auto orientation = convert_quaternion_wxyz({data_->qpos[3], data_->qpos[4], data_->qpos[5], data_->qpos[6]});
  Json joints = Json::array();
  for (std::size_t index = 0; index < joint_names_.size(); ++index) {
    joints.push_back(Json{{"name", joint_names_[index]}, {"position", data_->qpos[joint_qpos_addresses_[index]]}});
  }
  return Json{{"sequence", pose_sequence_}, {"simulationTime", data_->time}, {"wallTime", unix_milliseconds()},
              {"rootPosition", position}, {"rootOrientation", orientation}, {"joints", std::move(joints)}};
}

Json SimulationEngine::motion_status_locked() const {
  const auto age = motion_received_at_ == Clock::time_point{}
      ? 0LL : std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - motion_received_at_).count();
  const bool stand = motion_command_.mode == MotionMode::stand;
  return Json{{"sequence", motion_command_.sequence}, {"mode", stand ? "stand" : "locomotion"},
              {"forwardVelocity", motion_command_.forward_velocity},
              {"lateralVelocity", motion_command_.lateral_velocity}, {"yawRate", motion_command_.yaw_rate},
              {"bodyHeight", motion_command_.body_height}, {"validForMs", motion_command_.valid_for_ms},
              {"ageMs", std::max<std::int64_t>(0, age)}, {"timedOut", motion_timed_out_},
              {"appliedByController", stand}, {"bodyHeightApplied", false},
              {"controllerAvailability", stand ? "stand-hold" : "not-implemented"}};
}

Json SimulationEngine::collision_telemetry_locked() {
  int total_contacts = 0;
  int foot_contacts = 0;
  int non_foot_contacts = 0;
  int torso_contacts = 0;
  int head_contacts = 0;
  int limb_contacts = 0;
  double max_normal_force = 0.0;
  double total_normal_force = 0.0;
  Json strongest = nullptr;
  for (int contact_index = 0; contact_index < data_->ncon; ++contact_index) {
    const mjContact& contact = data_->contact[contact_index];
    const bool ground_is_geom1 = contact.geom1 == ground_geom_id_;
    const bool ground_is_geom2 = contact.geom2 == ground_geom_id_;
    if (!ground_is_geom1 && !ground_is_geom2) continue;
    const int robot_geom = ground_is_geom1 ? contact.geom2 : contact.geom1;
    if (robot_geom < 0 || robot_geom >= model_->ngeom || model_->geom_bodyid[robot_geom] == 0) continue;
    const auto category = geom_categories_[static_cast<std::size_t>(robot_geom)];
    mjtNum contact_force[6]{};
    mj_contactForce(model_.get(), data_.get(), contact_index, contact_force);
    const double normal_force = std::max(0.0, static_cast<double>(contact_force[0]));
    ++total_contacts;
    total_normal_force += normal_force;
    if (category == CollisionCategory::feet) ++foot_contacts;
    else {
      ++non_foot_contacts;
      if (category == CollisionCategory::torso) ++torso_contacts;
      else if (category == CollisionCategory::head) ++head_contacts;
      else ++limb_contacts;
    }
    if (normal_force >= max_normal_force) {
      max_normal_force = normal_force;
      const int body_id = model_->geom_bodyid[robot_geom];
      const char* body = mj_id2name(model_.get(), mjOBJ_BODY, body_id);
      const auto position = convert_position({contact.pos[0], contact.pos[1], contact.pos[2]});
      strongest = Json{{"category", collision_category_name(category)},
        {"bodyName", body ? body : "robot"},
        {"geomName", geom_profile_names_[static_cast<std::size_t>(robot_geom)]},
        {"normalForce", normal_force}, {"positionWorld", vector3(position)}};
    }
  }
  const auto orientation = convert_quaternion_wxyz(
      {data_->qpos[3], data_->qpos[4], data_->qpos[5], data_->qpos[6]});
  const double x = orientation[0], y = orientation[1], z = orientation[2], w = orientation[3];
  const double roll = std::atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
  const double pitch = std::asin(std::clamp(2.0 * (w * y - z * x), -1.0, 1.0));
  const double root_height = data_->qpos[2];
  const bool torso_condition = torso_contacts > 0 || head_contacts > 0;
  const bool orientation_condition = std::abs(roll) > fall_orientation_threshold_ ||
      std::abs(pitch) > fall_orientation_threshold_;
  const bool height_condition = root_height < fall_height_threshold_;
  const int fall_conditions = static_cast<int>(torso_condition) +
      static_cast<int>(orientation_condition) + static_cast<int>(height_condition);
  const char* fall_reason = "none";
  if (fallen_) {
    if (fall_conditions > 1) fall_reason = "multiple";
    else if (torso_condition) fall_reason = "torso-contact";
    else if (orientation_condition) fall_reason = "orientation";
    else if (height_condition) fall_reason = "height";
  }
  const auto root_position = convert_position({data_->qpos[0], data_->qpos[1], data_->qpos[2]});
  const bool outside = std::abs(root_position[0]) > flat_ground_environment().demo_boundary_half_extent ||
      std::abs(root_position[2]) > flat_ground_environment().demo_boundary_half_extent;
  return Json{{"environmentId", environment_id_}, {"totalEnvironmentContacts", total_contacts},
    {"footContacts", foot_contacts}, {"nonFootContacts", non_foot_contacts},
    {"torsoContacts", torso_contacts}, {"headContacts", head_contacts},
    {"limbContacts", limb_contacts}, {"maxNormalForce", max_normal_force},
    {"totalNormalForce", total_normal_force}, {"strongestContact", std::move(strongest)},
    {"isFallen", fallen_}, {"fallReason", fall_reason}, {"isOutOfBounds", outside},
    {"rootHeightAboveFloor", root_height}, {"roll", roll}, {"pitch", pitch}};
}

void SimulationEngine::update_collision_state_locked() {
  Json current = collision_telemetry_locked();
  const bool non_foot = current["nonFootContacts"].get<int>() > 0;
  const bool torso = current["torsoContacts"].get<int>() > 0 || current["headContacts"].get<int>() > 0;
  const bool orientation = std::abs(current["roll"].get<double>()) > fall_orientation_threshold_ ||
      std::abs(current["pitch"].get<double>()) > fall_orientation_threshold_;
  const bool height = current["rootHeightAboveFloor"].get<double>() < fall_height_threshold_;
  const bool fall_candidate = torso || orientation || height;
  auto event_from_strongest = [&](const char* kind) {
    Json event{{"kind", kind}, {"simulationTime", data_->time},
      {"category", "otherRobot"}, {"bodyName", ""}, {"geomName", ""},
      {"normalForce", 0.0}, {"positionWorld", Json::array({0.0, 0.0, 0.0})}};
    if (!current["strongestContact"].is_null()) {
      const auto& contact = current["strongestContact"];
      event["category"] = contact["category"];
      event["bodyName"] = contact["bodyName"];
      event["geomName"] = contact["geomName"];
      event["normalForce"] = contact["normalForce"];
      event["positionWorld"] = contact["positionWorld"];
    }
    pending_collision_events_.push_back(std::move(event));
  };
  if (non_foot && !non_foot_collision_active_) event_from_strongest("collision_started");
  if (!non_foot && non_foot_collision_active_) event_from_strongest("collision_ended");
  non_foot_collision_active_ = non_foot;
  const double strongest_force = current["strongestContact"].is_null()
      ? 0.0 : current["strongestContact"]["normalForce"].get<double>();
  const std::string strongest_category = current["strongestContact"].is_null()
      ? "" : current["strongestContact"]["category"].get<std::string>();
  if (non_foot && strongest_category != "feet" && strongest_force >= impact_threshold_ &&
      (last_impact_time_ < 0.0 || data_->time - last_impact_time_ >= kImpactCooldownSeconds)) {
    last_impact_time_ = data_->time;
    event_from_strongest("impact_detected");
  }
  if (fall_candidate) {
    if (fall_candidate_since_ < 0.0) fall_candidate_since_ = data_->time;
    if (!fallen_ && data_->time - fall_candidate_since_ >= kFallDebounceSeconds) {
      fallen_ = true;
      event_from_strongest("fall_detected");
    }
  } else {
    fall_candidate_since_ = -1.0;
    if (fallen_) {
      fallen_ = false;
      event_from_strongest("recovered");
    }
  }
  const bool outside = current["isOutOfBounds"].get<bool>();
  if (outside && !out_of_bounds_) event_from_strongest("out_of_bounds");
  if (!outside && out_of_bounds_) event_from_strongest("returned_in_bounds");
  out_of_bounds_ = outside;
  latest_collision_ = collision_telemetry_locked();
}

std::vector<Json> SimulationEngine::take_collision_events_locked() {
  std::vector<Json> result;
  result.swap(pending_collision_events_);
  return result;
}

Json SimulationEngine::telemetry_locked(const bool advance_sequence, const bool) {
  update_command_timeout_locked();
  if (advance_sequence) ++telemetry_sequence_;
  const auto root_position = convert_position({data_->qpos[0], data_->qpos[1], data_->qpos[2]});
  const auto root_orientation = convert_quaternion_wxyz({data_->qpos[3], data_->qpos[4], data_->qpos[5], data_->qpos[6]});
  mjtNum velocity_world[6]{};
  mj_objectVelocity(model_.get(), data_.get(), mjOBJ_BODY, root_body_id_, velocity_world, 0);
  const auto angular_world = convert_position({velocity_world[0], velocity_world[1], velocity_world[2]});
  const auto linear_world = convert_position({velocity_world[3], velocity_world[4], velocity_world[5]});
  mjtNum velocity_body[6]{};
  mjtNum acceleration_body[6]{};
  const mjtObj imu_object_type = imu_site_id_ >= 0 ? mjOBJ_SITE : mjOBJ_BODY;
  const int imu_object_id = imu_site_id_ >= 0 ? imu_site_id_ : root_body_id_;
  mj_objectVelocity(model_.get(), data_.get(), imu_object_type, imu_object_id, velocity_body, 1);
  mj_objectAcceleration(model_.get(), data_.get(), imu_object_type, imu_object_id, acceleration_body, 1);

  Json joints = Json::array();
  for (std::size_t index = 0; index < joint_names_.size(); ++index) {
    const int joint_id = joint_ids_[index];
    const int actuator_id = actuator_ids_[index];
    const bool limited = model_->jnt_limited[joint_id] != 0;
    joints.push_back(Json{{"name", joint_names_[index]},
      {"position", data_->qpos[joint_qpos_addresses_[index]]},
      {"velocity", data_->qvel[joint_dof_addresses_[index]]},
      {"actuatorTorque", data_->qfrc_actuator[joint_dof_addresses_[index]]},
      {"actuatorForce", data_->actuator_force[actuator_id]},
      {"controlTarget", home_joint_positions_[index]},
      {"lowerLimit", limited ? Json(model_->jnt_range[joint_id * 2]) : Json(nullptr)},
      {"upperLimit", limited ? Json(model_->jnt_range[joint_id * 2 + 1]) : Json(nullptr)},
      {"limited", limited}});
  }

  std::array<int, 4> contact_counts{};
  std::array<double, 4> normal_forces{};
  std::array<std::array<double, 3>, 4> foot_forces{};
  for (int contact_index = 0; contact_index < data_->ncon; ++contact_index) {
    const mjContact& contact = data_->contact[contact_index];
    for (std::size_t foot = 0; foot < foot_geom_ids_.size(); ++foot) {
      const bool foot_is_geom1 = contact.geom1 == foot_geom_ids_[foot];
      const bool foot_is_geom2 = contact.geom2 == foot_geom_ids_[foot];
      if (!foot_is_geom1 && !foot_is_geom2) continue;
      const int other_geom = foot_is_geom1 ? contact.geom2 : contact.geom1;
      if (other_geom < 0 || model_->geom_bodyid[other_geom] != 0) continue;
      mjtNum contact_force[6]{};
      mj_contactForce(model_.get(), data_.get(), contact_index, contact_force);
      const double sign = foot_is_geom2 ? 1.0 : -1.0;
      std::array<double, 3> force_mujoco{};
      for (int world_axis = 0; world_axis < 3; ++world_axis) {
        for (int contact_axis = 0; contact_axis < 3; ++contact_axis) {
          force_mujoco[world_axis] += sign * contact.frame[contact_axis * 3 + world_axis] * contact_force[contact_axis];
        }
      }
      const auto force_output = convert_position(force_mujoco);
      for (int axis = 0; axis < 3; ++axis) foot_forces[foot][axis] += force_output[axis];
      normal_forces[foot] += std::max(0.0, contact_force[0]);
      ++contact_counts[foot];
    }
  }
  Json feet = Json::array();
  for (std::size_t index = 0; index < foot_geom_ids_.size(); ++index) {
    const int geom = foot_geom_ids_[index];
    const auto position = convert_position({data_->geom_xpos[geom * 3], data_->geom_xpos[geom * 3 + 1], data_->geom_xpos[geom * 3 + 2]});
    feet.push_back(Json{{"name", kFootLabels[index]}, {"inContact", normal_forces[index] > kContactThresholdNewton},
      {"contactCount", contact_counts[index]}, {"normalForce", normal_forces[index]},
      {"forceWorld", vector3(foot_forces[index])}, {"positionWorld", vector3(position)}});
  }

  const auto performance_now = Clock::now();
  const double elapsed = std::max(1e-9, std::chrono::duration<double>(performance_now - stats_started_at_).count());
  const bool active = state_ == SimulationState::running;
  const double real_time_factor = active ? std::max(0.0, (data_->time - stats_simulation_started_) / elapsed) : 0.0;
  Json current_performance{{"physicsFrequencyHz", physics_steps_ / elapsed},
                   {"controlFrequencyHz", control_steps_ / elapsed},
                   {"posePublishFrequencyHz", pose_publishes_ / elapsed},
                   {"telemetryPublishFrequencyHz", telemetry_publishes_ / elapsed},
                   {"realTimeFactor", real_time_factor},
                   {"physicsStepMeanMs", physics_steps_ ? physics_step_total_ms_ / physics_steps_ : 0.0},
                   {"physicsStepMaxMs", physics_step_max_ms_},
                   {"controlStepMeanMs", control_steps_ ? control_step_total_ms_ / control_steps_ : 0.0},
                   {"controlStepMaxMs", control_step_max_ms_},
                   {"droppedPoseEvents", dropped_pose_events_},
                   {"droppedTelemetryEvents", dropped_telemetry_events_},
                   {"catchUpStepCount", catch_up_steps_}};
  if (performance_snapshot_.is_null() || elapsed >= 1.0) performance_snapshot_ = current_performance;
  Json performance = performance_snapshot_;
  if (elapsed >= 1.0) {
    stats_started_at_ = performance_now;
    stats_simulation_started_ = data_->time;
    physics_steps_ = control_steps_ = pose_publishes_ = telemetry_publishes_ = 0;
    physics_step_total_ms_ = physics_step_max_ms_ = 0.0;
    control_step_total_ms_ = control_step_max_ms_ = 0.0;
  }
  return Json{{"sequence", telemetry_sequence_}, {"simulationTime", data_->time},
    {"wallTime", unix_milliseconds()}, {"modelId", model_id_},
    {"source", Json{{"kind", "mujoco-simulation"}, {"connectedToPhysicalRobot", false}}},
    {"root", Json{{"position", vector3(root_position)}, {"orientation", quaternion(root_orientation)},
      {"linearVelocityWorld", vector3(linear_world)}, {"angularVelocityWorld", vector3(angular_world)},
      {"linearSpeed", norm3(linear_world)}, {"angularSpeed", norm3(angular_world)}}},
    {"imu", Json{{"orientation", quaternion(root_orientation)},
      {"angularVelocityBody", Json::array({velocity_body[0], velocity_body[1], velocity_body[2]})},
      {"linearAccelerationBody", Json::array({acceleration_body[3], acceleration_body[4], acceleration_body[5]})},
      {"frame", "body"}, {"includesGravity", false},
      {"source", imu_site_id_ >= 0 ? "official-imu-site-state" : "root-body-state"}}},
    {"joints", std::move(joints)}, {"feet", std::move(feet)},
    {"collision", latest_collision_.is_null() ? collision_telemetry_locked() : latest_collision_},
    {"command", motion_status_locked()}, {"performance", std::move(performance)}};
}

void SimulationEngine::clear_motion_locked() {
  motion_command_ = MotionCommand{};
  motion_received_at_ = Clock::time_point{};
  motion_timed_out_ = false;
}

void SimulationEngine::reset_statistics_locked() {
  stats_started_at_ = Clock::now();
  stats_simulation_started_ = data_ ? data_->time : 0.0;
  physics_steps_ = control_steps_ = pose_publishes_ = telemetry_publishes_ = 0;
  dropped_pose_events_ = dropped_telemetry_events_ = catch_up_steps_ = 0;
  physics_step_total_ms_ = physics_step_max_ms_ = 0.0;
  control_step_total_ms_ = control_step_max_ms_ = 0.0;
  performance_snapshot_ = Json();
}

void SimulationEngine::update_command_timeout_locked() {
  if (motion_timed_out_ || motion_received_at_ == Clock::time_point{}) return;
  const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - motion_received_at_).count();
  if (age > motion_command_.valid_for_ms) {
    motion_command_.forward_velocity = 0.0;
    motion_command_.lateral_velocity = 0.0;
    motion_command_.yaw_rate = 0.0;
    motion_timed_out_ = true;
  }
}

void SimulationEngine::step_once_locked() {
  update_command_timeout_locked();
  const auto control_started = Clock::now();
  const bool control_tick = control_phase_ == 0;
  if (test_pose_hold_) {
    constexpr double kPositionGain = 35.0;
    constexpr double kVelocityGain = 1.5;
    if (control_tick) {
      for (int index = 0; index < model_->nu; ++index) {
        const double target = home_joint_positions_[static_cast<std::size_t>(index)];
        const double position = data_->qpos[joint_qpos_addresses_[static_cast<std::size_t>(index)]];
        const double velocity = data_->qvel[joint_dof_addresses_[static_cast<std::size_t>(index)]];
        const double effort = kPositionGain * (target - position) - kVelocityGain * velocity;
        data_->ctrl[actuator_ids_[static_cast<std::size_t>(index)]] = std::clamp(
            effort, model_->actuator_ctrlrange[actuator_ids_[static_cast<std::size_t>(index)] * 2],
            model_->actuator_ctrlrange[actuator_ids_[static_cast<std::size_t>(index)] * 2 + 1]);
      }
    }
  } else if (control_tick && model_->nkey > 0 && model_->key_ctrl != nullptr) {
    for (int index = 0; index < model_->nu; ++index) data_->ctrl[index] = model_->key_ctrl[index];
  }
  if (control_tick) {
    const double elapsed = std::chrono::duration<double, std::milli>(Clock::now() - control_started).count();
    ++control_steps_;
    control_step_total_ms_ += elapsed;
    control_step_max_ms_ = std::max(control_step_max_ms_, elapsed);
  }
  control_phase_ = (control_phase_ + 1U) % 5U;
  const auto physics_started = Clock::now();
  mj_step(model_.get(), data_.get());
  update_collision_state_locked();
  const double elapsed = std::chrono::duration<double, std::milli>(Clock::now() - physics_started).count();
  ++physics_steps_;
  physics_step_total_ms_ += elapsed;
  physics_step_max_ms_ = std::max(physics_step_max_ms_, elapsed);
}

void SimulationEngine::publish(const EventKind kind, Json payload) {
  const bool dropped = event_sink_(kind, std::move(payload));
  if (dropped) {
    std::lock_guard lock(mutex_);
    if (kind == EventKind::pose) ++dropped_pose_events_;
    if (kind == EventKind::telemetry) ++dropped_telemetry_events_;
  }
}

void SimulationEngine::physics_loop() {
  auto next = Clock::now();
  auto last_pose_publish = Clock::now();
  auto last_telemetry_publish = Clock::now();
  std::unique_lock lock(mutex_);
  while (!quitting_) {
    condition_.wait(lock, [this] { return quitting_ || state_ == SimulationState::running; });
    if (quitting_) break;
    next = Clock::now();
    last_pose_publish = next - std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(kPosePeriod));
    last_telemetry_publish = next - std::chrono::milliseconds(20);
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
        catch_up_steps_ += static_cast<std::uint64_t>(steps - 1);
        next += std::chrono::duration_cast<Clock::duration>(interval * (steps - 1));
      }
      for (int index = 0; index < steps; ++index) step_once_locked();
      Json pose;
      Json telemetry;
      std::vector<Json> collision_events;
      const auto pose_period = std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(kPosePeriod));
      const auto telemetry_period = std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(1.0 / telemetry_rate_hz_));
      if (now - last_pose_publish >= pose_period) {
        pose = pose_locked(true);
        latest_pose_ = pose;
        ++pose_publishes_;
        last_pose_publish += pose_period;
      }
      if (now - last_telemetry_publish >= telemetry_period) {
        telemetry = telemetry_locked(true);
        latest_telemetry_ = telemetry;
        ++telemetry_publishes_;
        last_telemetry_publish += telemetry_period;
      }
      collision_events = take_collision_events_locked();
      lock.unlock();
      if (!pose.is_null()) publish(EventKind::pose, std::move(pose));
      if (!telemetry.is_null()) publish(EventKind::telemetry, std::move(telemetry));
      for (auto& event : collision_events) publish(EventKind::collision, std::move(event));
      const auto coarse_deadline = next - std::chrono::microseconds(1500);
      if (Clock::now() < coarse_deadline) std::this_thread::sleep_until(coarse_deadline);
      while (Clock::now() < next) {}
      lock.lock();
      if (Clock::now() - next > std::chrono::milliseconds(100)) next = Clock::now();
    }
  }
}

}  // namespace sidecar

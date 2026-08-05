#include "controllers/low_level_joint_command.hpp"
#include "controllers/mpc/centroidal_dynamics.hpp"
#include "controllers/mpc/convex_mpc.hpp"
#include "controllers/mpc/foothold_planner.hpp"
#include "controllers/mpc/gait_generator.hpp"
#include "controllers/mpc/leg_controller.hpp"
#include "controllers/mpc/mujoco_state_provider.hpp"
#include "controllers/mpc/qp_solver.hpp"
#include "controllers/mpc/swing_trajectory.hpp"
#include "controllers/mpc/touchdown_tracker.hpp"

#include <array>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include <Eigen/Eigenvalues>
#include <mujoco/mujoco.h>
#include <osqp.h>

namespace {

int checks = 0;
void expect(const bool value, const char* name) {
  ++checks;
  if (!value) {
    std::cerr << "FAILED: " << name << '\n';
    std::exit(1);
  }
}

struct ModelDeleter { void operator()(mjModel* value) const noexcept { mj_deleteModel(value); } };
struct DataDeleter { void operator()(mjData* value) const noexcept { mj_deleteData(value); } };

}  // namespace

int main() {
  using namespace sidecar::controllers;
  using namespace sidecar::controllers::mpc;
  expect(EIGEN_WORLD_VERSION == 3 && EIGEN_MAJOR_VERSION == 4 && EIGEN_MINOR_VERSION == 0,
         "Eigen version lock");
  expect(std::string(osqp_version()) == "v1.0.0", "OSQP version lock");
  expect(kLegNames == std::array<const char*, 4>{{"FL", "FR", "RL", "RR"}}, "leg order lock");
  expect(LowLevelJointCommand{0.0, 0.0, 1.0, 1.0, 0.0}.finite(), "low level finite");
  expect(!LowLevelJointCommand{0.0, 0.0, -1.0, 1.0, 0.0}.finite(), "low level rejects negative gain");

  const auto model_path = std::filesystem::path(TEST_RESOURCE_ROOT) / "resources" / "simulation" /
      "models" / "unitree-go2-flat-ground-v1.xml";
  char error[1024]{};
  std::unique_ptr<mjModel, ModelDeleter> model(mj_loadXML(model_path.string().c_str(), nullptr, error, sizeof(error)));
  expect(model != nullptr, "MPC test Go2 model loads");
  std::unique_ptr<mjData, DataDeleter> data(mj_makeData(model.get()));
  expect(data != nullptr, "MPC test data allocates");
  const int home = mj_name2id(model.get(), mjOBJ_KEY, "home");
  expect(home >= 0, "MPC test home key");
  mj_resetDataKeyframe(model.get(), data.get(), home);
  mj_forward(model.get(), data.get());

  std::vector<int> joint_ids, qpos_addresses, dof_addresses, actuator_ids;
  for (const char* name : kGo2JointNames) {
    const int joint = mj_name2id(model.get(), mjOBJ_JOINT, name);
    joint_ids.push_back(joint);
    qpos_addresses.push_back(model->jnt_qposadr[joint]);
    dof_addresses.push_back(model->jnt_dofadr[joint]);
    int actuator = -1;
    for (int candidate = 0; candidate < model->nu; ++candidate) {
      if (model->actuator_trntype[candidate] == mjTRN_JOINT &&
          model->actuator_trnid[candidate * 2] == joint) actuator = candidate;
    }
    actuator_ids.push_back(actuator);
  }
  std::array<int, kLegCount> foot_geoms{};
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    foot_geoms[leg] = mj_name2id(model.get(), mjOBJ_GEOM, kLegNames[leg]);
  }
  const int ground = mj_name2id(model.get(), mjOBJ_GEOM, "flat-ground-v1-floor");
  int root = -1;
  for (int joint = 0; joint < model->njnt; ++joint) {
    if (model->jnt_type[joint] == mjJNT_FREE) root = model->jnt_bodyid[joint];
  }
  MujocoStateProvider provider;
  std::string state_error;
  expect(provider.initialize(model.get(), joint_ids, qpos_addresses, dof_addresses, actuator_ids,
                             foot_geoms, ground, root, state_error), "state provider strict mapping");
  auto wrong_ids = joint_ids;
  std::swap(wrong_ids[0], wrong_ids[3]);
  MujocoStateProvider wrong_provider;
  expect(!wrong_provider.initialize(model.get(), wrong_ids, qpos_addresses, dof_addresses, actuator_ids,
                                    foot_geoms, ground, root, state_error), "state provider rejects wrong order");
  RobotState state;
  expect(provider.update(model.get(), data.get(), false, false, false, state, state_error),
         "state provider reads finite MuJoCo state");
  expect(state.total_mass > 10.0 && state.total_mass < 20.0, "total mass physical");
  expect(state.center_of_mass.z() > 0.15 && state.center_of_mass.z() < 0.35, "CoM Z-up");
  expect(state.centroidal_inertia_world.determinant() > 0.0, "centroidal inertia positive");
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    expect(state.foot_position_world[leg].z() >= 0.0 && state.foot_jacobian_world[leg].array().isFinite().all(),
           "foot position and Jacobian finite");
  }

  GaitGenerator gait;
  gait.reset(state.simulation_time);
  const ContactVector overlap = gait.contacts(state.simulation_time);
  expect(overlap == ContactVector{{true, true, true, true}}, "trot starts in double-support overlap");
  const ContactVector first_diagonal = gait.contacts(state.simulation_time + 0.70 / gait.frequency_hz());
  expect(first_diagonal == ContactVector{{false, true, true, false}}, "trot FL RR swing diagonal");
  const ContactVector second_diagonal = gait.contacts(state.simulation_time + 0.20 / gait.frequency_hz());
  expect(second_diagonal == ContactVector{{true, false, false, true}}, "trot FR RL swing diagonal");
  expect(gait.contact_horizon(state.simulation_time, 10, 0.02).size() == 10,
         "gait horizon length locked");

  ContactVector touchdown_expected{{true, true, true, true}};
  ContactVector touchdown_actual{{true, true, true, true}};
  TouchdownTracker touchdown;
  touchdown.reset(touchdown_actual);
  touchdown_expected[0] = false;
  touchdown_actual[0] = false;
  touchdown.update(0.004, touchdown_expected, touchdown_actual);
  touchdown.update(0.008, touchdown_expected, touchdown_actual);
  touchdown_expected[0] = true;
  touchdown.update(0.100, touchdown_expected, touchdown_actual);
  touchdown_actual[0] = true;
  touchdown.update(0.104, touchdown_expected, touchdown_actual);
  touchdown_actual[0] = false;
  touchdown.update(0.108, touchdown_expected, touchdown_actual);
  expect(touchdown.metrics().touchdown_event_count == 0,
         "single-sample touchdown noise is ignored");
  touchdown_actual[0] = true;
  touchdown.update(0.110, touchdown_expected, touchdown_actual);
  touchdown.update(0.114, touchdown_expected, touchdown_actual);
  auto touchdown_metrics = touchdown.metrics();
  expect(touchdown_metrics.touchdown_event_count == 1 &&
             touchdown_metrics.on_time_touchdown_count == 1 &&
             std::abs(touchdown_metrics.touchdown_latency_mean_ms - 10.0) < 1e-9,
         "debounced on-time touchdown records exactly once");
  touchdown.update(0.120, touchdown_expected, touchdown_actual);
  expect(touchdown.metrics().touchdown_event_count == 1,
         "sustained stance contact does not duplicate touchdown");

  touchdown.reset(ContactVector{{true, true, true, true}});
  touchdown_expected.fill(true);
  touchdown_actual.fill(true);
  auto record_touchdown = [&](const double start, const double latency) {
    touchdown_expected[0] = false;
    touchdown_actual[0] = false;
    touchdown.update(start, touchdown_expected, touchdown_actual);
    touchdown.update(start + 0.004, touchdown_expected, touchdown_actual);
    if (latency < 0.0) {
      touchdown_actual[0] = true;
      touchdown.update(start + 0.100 + latency, touchdown_expected, touchdown_actual);
      touchdown.update(start + 0.104 + latency, touchdown_expected, touchdown_actual);
    }
    touchdown_expected[0] = true;
    touchdown.update(start + 0.100, touchdown_expected, touchdown_actual);
    if (latency >= 0.0) {
      touchdown_actual[0] = true;
      touchdown.update(start + 0.100 + latency, touchdown_expected, touchdown_actual);
      touchdown.update(start + 0.104 + latency, touchdown_expected, touchdown_actual);
    }
  };
  record_touchdown(1.0, -0.040);
  record_touchdown(1.3, 0.004);
  record_touchdown(1.6, 0.020);
  touchdown_metrics = touchdown.metrics();
  expect(touchdown_metrics.touchdown_event_count == 3 &&
             touchdown_metrics.early_touchdown_event_count == 1 &&
             touchdown_metrics.on_time_touchdown_count == 1 &&
             touchdown_metrics.late_touchdown_event_count == 1,
         "early on-time and late touchdown outcomes partition events");
  expect(std::abs(touchdown_metrics.touchdown_latency_mean_ms + 16.0 / 3.0) < 1e-9 &&
             std::abs(touchdown_metrics.touchdown_latency_max_ms - 20.0) < 1e-9 &&
             std::abs(touchdown_metrics.touchdown_latency_p95_ms - 20.0) < 1e-9,
         "signed touchdown latency statistics are deterministic");
  const auto paused_metrics = touchdown.metrics();
  expect(touchdown.metrics().touchdown_event_count == paused_metrics.touchdown_event_count &&
             touchdown.metrics().latency_sample_count == paused_metrics.latency_sample_count,
         "touchdown metrics remain unchanged without a simulation update");

  touchdown.reset(ContactVector{{true, true, true, true}});
  touchdown_expected.fill(true);
  touchdown_actual.fill(true);
  touchdown_expected[0] = false;
  touchdown_actual[0] = false;
  touchdown.update(2.000, touchdown_expected, touchdown_actual);
  touchdown.update(2.004, touchdown_expected, touchdown_actual);
  touchdown_expected[0] = true;
  touchdown.update(2.100, touchdown_expected, touchdown_actual);
  touchdown.update(2.204, touchdown_expected, touchdown_actual);
  touchdown.update(2.208, touchdown_expected, touchdown_actual);
  touchdown_metrics = touchdown.metrics();
  expect(touchdown_metrics.touchdown_event_count == 1 &&
             touchdown_metrics.touchdown_timeout_count == 1 &&
             touchdown_metrics.latency_sample_count == 0,
         "touchdown timeout is one separate outcome without latency sample");
  touchdown_expected.fill(true);
  touchdown_actual.fill(true);
  touchdown.update(2.300, touchdown_expected, touchdown_actual);
  expect(touchdown.metrics().touchdown_event_count == 1,
         "late contact after timeout does not create a second outcome");
  touchdown.reset(touchdown_actual);
  expect(touchdown.metrics().touchdown_event_count == 0,
         "touchdown reset clears session diagnostics");
  touchdown.update(3.000, touchdown_expected, touchdown_actual);
  expect(touchdown.metrics().touchdown_event_count == 0,
         "stance-only legs never create touchdown events");

  touchdown.reset(ContactVector{{true, true, true, true}});
  touchdown_expected.fill(true);
  touchdown_actual.fill(true);
  for (int cycle = 0; cycle < 130; ++cycle) {
    record_touchdown(4.0 + static_cast<double>(cycle) * 0.2, 0.020);
  }
  touchdown_metrics = touchdown.metrics();
  expect(touchdown_metrics.touchdown_event_count == 130 &&
             touchdown_metrics.late_touchdown_event_count == 130,
         "successive gait cycles each record one touchdown outcome");
  expect(touchdown_metrics.latency_sample_count == TouchdownTracker::kLatencyCapacity,
         "touchdown latency history is bounded");

  SwingTrajectory swing_path;
  const Eigen::Vector3d swing_start(0.1, 0.2, 0.022), swing_target(0.2, 0.18, 0.022);
  swing_path.configure(swing_start, swing_target, 1.0, 0.2, 0.05);
  const SwingSample swing_begin = swing_path.sample(1.0);
  const SwingSample swing_apex = swing_path.sample(1.1);
  const SwingSample swing_end = swing_path.sample(1.2);
  expect((swing_begin.position - swing_start).norm() < 1e-12 && swing_begin.velocity.norm() < 1e-12 &&
         swing_begin.acceleration.norm() < 1e-10, "swing quintic start boundary");
  expect((swing_end.position - swing_target).norm() < 1e-12 && swing_end.velocity.norm() < 1e-10 &&
         swing_end.acceleration.norm() < 1e-8, "swing quintic end boundary");
  expect(std::abs(swing_apex.position.z() - 0.072) < 1e-10 && swing_apex.velocity.z() < 1e-9,
         "swing quintic finite apex");

  FootholdPlanner footholds;
  footholds.initialize(state);
  const Eigen::Vector3d forward_foot = footholds.plan(state, MotionTarget{0.15, 0.0, 0.3, true}, 0,
                                                       gait.stance_duration());
  const Eigen::Vector3d reverse_foot = footholds.plan(state, MotionTarget{-0.10, 0.0, 0.3, true}, 0,
                                                       gait.stance_duration());
  const Eigen::Vector3d neutral_foot = footholds.plan(state, MotionTarget{0.0, 0.0, 0.3, true}, 0,
                                                       gait.stance_duration());
  const Eigen::Vector3d body_forward = state.base_rotation.col(0);
  expect((forward_foot - neutral_foot).dot(body_forward) > 0.0 &&
         (reverse_foot - neutral_foot).dot(body_forward) < 0.0,
         "Raibert foothold is symmetric in command direction");
  const Eigen::Vector3d yaw_foot = footholds.plan(state, MotionTarget{0.0, 0.3, 0.3, true}, 0,
                                                   gait.stance_duration());
  const Eigen::Vector3d nominal_body = state.base_rotation.transpose() *
      (state.foot_position_world[0] - state.base_position);
  const Eigen::Vector3d yaw_delta_body = state.base_rotation.transpose() * (yaw_foot - neutral_foot);
  expect(yaw_delta_body.head<2>().dot(Eigen::Vector2d(-nominal_body.y(), nominal_body.x())) > 0.0,
         "positive yaw foothold follows positive tangent");

  LegController leg_controller;
  JointVector home_joint_vector = state.joint_position;
  FootVectors test_forces{};
  test_forces[0] = Eigen::Vector3d(1.0, -2.0, 30.0);
  std::array<SwingSample, kLegCount> swing_samples{};
  std::array<LowLevelJointCommand, kJointCount> low_level{};
  leg_controller.compute(state, home_joint_vector, ContactVector{{true, true, true, true}}, test_forces,
                         swing_samples, low_level);
  const Eigen::Vector3d expected_reaction_compensation =
      -state.foot_jacobian_world[0].transpose() * test_forces[0];
  expect(std::abs(low_level[0].tau_feedforward - expected_reaction_compensation.x()) < 1e-12 &&
         std::abs(low_level[1].tau_feedforward - expected_reaction_compensation.y()) < 1e-12 &&
         std::abs(low_level[2].tau_feedforward - expected_reaction_compensation.z()) < 1e-12,
         "stance reaction force maps through signed Jacobian transpose");

  const auto dynamics = discretize_centroidal_dynamics(state, 0.02);
  expect(dynamics.a.rows() == 12 && dynamics.b.cols() == 12 && dynamics.a.array().isFinite().all() &&
         dynamics.b.array().isFinite().all(), "SRBD dimensions finite");
  expect(std::abs(dynamics.a(3, 9) - 0.02) < 1e-12 && std::abs(dynamics.gravity[11] + 0.1962) < 1e-12,
         "SRBD Euler discretization");

  ConvexMpc controller;
  ContactHorizon all_stance(static_cast<std::size_t>(controller.config().horizon_steps),
                            ContactVector{{true, true, true, true}});
  MotionTarget stand_target{0.0, 0.0, state.base_position.z(), false};
  const QpProblem problem = controller.build_problem(state, stand_target, all_stance);
  expect(problem.hessian.rows() == 120 && problem.constraint_matrix.rows() == 280,
         "QP dimensions locked");
  expect((problem.hessian - problem.hessian.transpose()).norm() < 1e-8, "Hessian symmetric");
  Eigen::SelfAdjointEigenSolver<Eigen::MatrixXd> eigenvalues(problem.hessian);
  expect(eigenvalues.info() == Eigen::Success && eigenvalues.eigenvalues().minCoeff() > 0.0,
         "Hessian regularized positive definite");
  const MpcSolution standing = controller.solve(state, stand_target, all_stance);
  expect(standing.solved, "static MPC solves");
  Eigen::Vector3d total_force = Eigen::Vector3d::Zero();
  Eigen::Vector3d total_moment = Eigen::Vector3d::Zero();
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    const auto& force = standing.ground_forces_world[leg];
    expect(force.z() >= -1e-6 && std::abs(force.x()) <= controller.config().friction_coefficient * force.z() + 1e-5 &&
           std::abs(force.y()) <= controller.config().friction_coefficient * force.z() + 1e-5,
           "static force satisfies friction pyramid");
    total_force += force;
    total_moment += (state.foot_position_world[leg] - state.center_of_mass).cross(force);
  }
  const double weight = state.total_mass * 9.81;
  std::cout << "D5V_MPC_STATIC_FORCE=" << total_force.transpose()
            << " WEIGHT=" << weight << " MOMENT=" << total_moment.transpose()
            << " STATUS=" << standing.status << " ITER=" << standing.iterations
            << " MS=" << standing.solve_ms << '\n';
  expect(std::abs(total_force.z() - weight) < weight * 0.20, "static MPC balances mg");
  expect(total_force.head<2>().norm() < weight * 0.08, "static horizontal force near zero");
  expect(total_moment.head<2>().norm() < 5.0, "static roll pitch moment near zero");

  ContactHorizon swing = all_stance;
  for (auto& contacts : swing) contacts[0] = false;
  controller.reset();
  const MpcSolution swing_solution = controller.solve(state, stand_target, swing);
  expect(swing_solution.solved && swing_solution.ground_forces_world[0].norm() < 1e-3,
         "swing foot force constrained to zero");

  RobotState invalid_state = state;
  invalid_state.center_of_mass.x() = std::numeric_limits<double>::quiet_NaN();
  invalid_state.finite = false;
  expect(!controller.solve(invalid_state, stand_target, all_stance).solved, "MPC rejects NaN state");

  QpProblem infeasible;
  infeasible.hessian = Eigen::MatrixXd::Identity(1, 1);
  infeasible.gradient = Eigen::VectorXd::Zero(1);
  infeasible.constraint_matrix.resize(2, 1);
  infeasible.constraint_matrix.insert(0, 0) = 1.0;
  infeasible.constraint_matrix.insert(1, 0) = 1.0;
  infeasible.lower_bound = Eigen::Vector2d(1.0, -std::numeric_limits<double>::infinity());
  infeasible.upper_bound = Eigen::Vector2d(std::numeric_limits<double>::infinity(), 0.0);
  OsqpSolver direct_solver;
  const QpResult infeasible_result = direct_solver.solve(infeasible, 100, 1e-4, 1e-4, 0.01);
  expect(!infeasible_result.solved && infeasible_result.status.find("infeasible") != std::string::npos,
         "OSQP infeasible safe failure");

  std::cout << "D5V_MPC_CORE_CHECKS=" << checks << '\n';
  return 0;
}

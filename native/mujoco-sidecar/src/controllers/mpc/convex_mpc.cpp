#include "controllers/mpc/convex_mpc.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

#include <Eigen/SparseCore>

#include "controllers/mpc/centroidal_dynamics.hpp"

namespace sidecar::controllers::mpc {
namespace {

double wrap_angle(double value) {
  constexpr double kPi = 3.14159265358979323846;
  while (value > kPi) value -= 2.0 * kPi;
  while (value < -kPi) value += 2.0 * kPi;
  return value;
}

}  // namespace

QpProblem ConvexMpc::build_problem(const RobotState& state, const MotionTarget& target,
                                   const ContactHorizon& contacts) const {
  const int horizon = config_.horizon_steps;
  const int state_count = horizon * kMpcStateSize;
  const int variable_count = horizon * kMpcInputSize;
  const int constraint_count = horizon * static_cast<int>(kLegCount) * 7;
  QpProblem problem;
  problem.hessian = Eigen::MatrixXd::Zero(variable_count, variable_count);
  problem.gradient = Eigen::VectorXd::Zero(variable_count);
  problem.constraint_matrix.resize(constraint_count, variable_count);
  problem.lower_bound = Eigen::VectorXd::Constant(constraint_count, -std::numeric_limits<double>::infinity());
  problem.upper_bound = Eigen::VectorXd::Constant(constraint_count, std::numeric_limits<double>::infinity());
  if (!state.finite || static_cast<int>(contacts.size()) != horizon) {
    problem.hessian.setConstant(std::numeric_limits<double>::quiet_NaN());
    return problem;
  }

  const DiscreteCentroidalDynamics dynamics = discretize_centroidal_dynamics(state, config_.node_dt);
  Eigen::MatrixXd state_from_initial = Eigen::MatrixXd::Zero(state_count, kMpcStateSize);
  Eigen::MatrixXd state_from_inputs = Eigen::MatrixXd::Zero(state_count, variable_count);
  Eigen::VectorXd gravity = Eigen::VectorXd::Zero(state_count);
  MpcStateMatrix a_power = MpcStateMatrix::Identity();
  for (int step = 0; step < horizon; ++step) {
    a_power = dynamics.a * a_power;
    state_from_initial.block(step * kMpcStateSize, 0, kMpcStateSize, kMpcStateSize) = a_power;
    MpcStateMatrix transfer = MpcStateMatrix::Identity();
    for (int input_step = step; input_step >= 0; --input_step) {
      state_from_inputs.block(step * kMpcStateSize, input_step * kMpcInputSize,
                              kMpcStateSize, kMpcInputSize) = transfer * dynamics.b;
      transfer = transfer * dynamics.a;
    }
    MpcStateVector accumulated_gravity = MpcStateVector::Zero();
    transfer.setIdentity();
    for (int gravity_step = 0; gravity_step <= step; ++gravity_step) {
      accumulated_gravity += transfer * dynamics.gravity;
      transfer = transfer * dynamics.a;
    }
    gravity.segment(step * kMpcStateSize, kMpcStateSize) = accumulated_gravity;
  }

  Eigen::VectorXd reference(state_count);
  const MpcStateVector initial = centroidal_state_vector(state);
  const double com_height_offset = state.center_of_mass.z() - state.base_position.z();
  const Eigen::Vector3d commanded_velocity_world =
      state.base_rotation * Eigen::Vector3d(target.forward_velocity, 0.0, 0.0);
  for (int step = 0; step < horizon; ++step) {
    MpcStateVector desired = initial;
    const double time = (step + 1) * config_.node_dt;
    desired[0] = 0.0;
    desired[1] = 0.0;
    desired[2] = wrap_angle(initial[2] + target.yaw_rate * time);
    desired.segment<2>(3) = initial.segment<2>(3) + commanded_velocity_world.head<2>() * time;
    desired[5] = target.body_height + com_height_offset;
    desired.segment<3>(6) = Eigen::Vector3d(0.0, 0.0, target.yaw_rate);
    desired.segment<3>(9) = commanded_velocity_world;
    reference.segment(step * kMpcStateSize, kMpcStateSize) = desired;
  }
  Eigen::VectorXd state_weights(state_count);
  for (int step = 0; step < horizon; ++step) {
    for (int index = 0; index < kMpcStateSize; ++index) {
      state_weights[step * kMpcStateSize + index] = config_.state_weights[static_cast<std::size_t>(index)];
    }
  }
  const Eigen::MatrixXd weighted_inputs = state_weights.asDiagonal() * state_from_inputs;
  const Eigen::VectorXd prediction_error = state_from_initial * initial + gravity - reference;
  problem.hessian = 2.0 * (state_from_inputs.transpose() * weighted_inputs +
      Eigen::MatrixXd::Identity(variable_count, variable_count) * config_.force_weight);
  problem.hessian.diagonal().array() += config_.hessian_regularization;
  problem.gradient = 2.0 * state_from_inputs.transpose() * state_weights.asDiagonal() * prediction_error;

  std::vector<Eigen::Triplet<double>> triplets;
  triplets.reserve(static_cast<std::size_t>(constraint_count * 3));
  int row = 0;
  for (int step = 0; step < horizon; ++step) {
    for (std::size_t leg = 0; leg < kLegCount; ++leg) {
      const int force = step * kMpcInputSize + static_cast<int>(leg * 3);
      const double mu = config_.friction_coefficient;
      triplets.emplace_back(row, force, 1.0); triplets.emplace_back(row, force + 2, -mu);
      problem.upper_bound[row++] = 0.0;
      triplets.emplace_back(row, force, -1.0); triplets.emplace_back(row, force + 2, -mu);
      problem.upper_bound[row++] = 0.0;
      triplets.emplace_back(row, force + 1, 1.0); triplets.emplace_back(row, force + 2, -mu);
      problem.upper_bound[row++] = 0.0;
      triplets.emplace_back(row, force + 1, -1.0); triplets.emplace_back(row, force + 2, -mu);
      problem.upper_bound[row++] = 0.0;
      for (int axis = 0; axis < 3; ++axis) triplets.emplace_back(row + axis, force + axis, 1.0);
      if (contacts[static_cast<std::size_t>(step)][leg]) {
        problem.lower_bound[row + 2] = 0.0;
        problem.upper_bound[row + 2] = config_.maximum_normal_force;
      } else {
        for (int axis = 0; axis < 3; ++axis) {
          problem.lower_bound[row + axis] = 0.0;
          problem.upper_bound[row + axis] = 0.0;
        }
      }
      row += 3;
    }
  }
  problem.constraint_matrix.setFromTriplets(triplets.begin(), triplets.end());
  return problem;
}

MpcSolution ConvexMpc::solve(const RobotState& state, const MotionTarget& target,
                             const ContactHorizon& contacts) {
  MpcSolution solution;
  const QpResult result = solver_.solve(build_problem(state, target, contacts), config_.maximum_iterations,
                                        config_.absolute_tolerance, config_.relative_tolerance,
                                        config_.solve_budget_ms / 1000.0);
  solution.status = result.status;
  solution.iterations = result.iterations;
  solution.solve_ms = result.solve_ms;
  solution.solved = result.solved && result.primal.size() >= kMpcInputSize;
  if (!solution.solved) return solution;
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    solution.ground_forces_world[leg] = result.primal.segment<3>(static_cast<int>(leg * 3));
    if (!solution.ground_forces_world[leg].array().isFinite().all()) {
      solution.solved = false;
      solution.status = "non_finite_force";
      for (auto& force : solution.ground_forces_world) force.setZero();
      break;
    }
  }
  return solution;
}

void ConvexMpc::reset() { solver_.reset_warm_start(); }

}  // namespace sidecar::controllers::mpc

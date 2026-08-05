#include "controllers/mpc/mujoco_state_provider.hpp"

#include <algorithm>
#include <cmath>
#include <string_view>

#include <Eigen/Eigenvalues>

namespace sidecar::controllers::mpc {
namespace {

bool finite_matrix(const Eigen::MatrixXd& value) { return value.array().isFinite().all(); }

Eigen::Matrix3d matrix3(const mjtNum* value) {
  Eigen::Matrix3d result;
  for (int row = 0; row < 3; ++row) {
    for (int column = 0; column < 3; ++column) result(row, column) = value[row * 3 + column];
  }
  return result;
}

Eigen::Vector3d vector3(const mjtNum* value) { return {value[0], value[1], value[2]}; }

}  // namespace

bool MujocoStateProvider::initialize(const mjModel* model, const std::vector<int>& joint_ids,
                                     const std::vector<int>& joint_qpos_addresses,
                                     const std::vector<int>& joint_dof_addresses,
                                     const std::vector<int>& actuator_ids,
                                     const std::array<int, kLegCount>& foot_geom_ids,
                                     const int ground_geom_id, const int root_body_id,
                                     std::string& error) {
  initialized_ = false;
  if (!model || joint_ids.size() != kJointCount || joint_qpos_addresses.size() != kJointCount ||
      joint_dof_addresses.size() != kJointCount || actuator_ids.size() != kJointCount ||
      ground_geom_id < 0 || root_body_id <= 0) {
    error = "invalid-mapping-size";
    return false;
  }
  for (std::size_t index = 0; index < kJointCount; ++index) {
    const int joint = joint_ids[index];
    const int actuator = actuator_ids[index];
    const char* joint_name = mj_id2name(model, mjOBJ_JOINT, joint);
    if (!joint_name || std::string_view(joint_name) != kGo2JointNames[index] ||
        model->jnt_type[joint] != mjJNT_HINGE ||
        model->jnt_qposadr[joint] != joint_qpos_addresses[index] ||
        model->jnt_dofadr[joint] != joint_dof_addresses[index] || actuator < 0 ||
        model->actuator_trntype[actuator] != mjTRN_JOINT ||
        model->actuator_trnid[actuator * 2] != joint) {
      error = "joint-actuator-order-mismatch";
      return false;
    }
    joint_ids_[index] = joint;
    qpos_addresses_[index] = joint_qpos_addresses[index];
    dof_addresses_[index] = joint_dof_addresses[index];
    actuator_ids_[index] = actuator;
  }
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    const int geom = foot_geom_ids[leg];
    const char* geom_name = mj_id2name(model, mjOBJ_GEOM, geom);
    if (geom < 0 || !geom_name || std::string_view(geom_name) != kLegNames[leg] ||
        model->geom_bodyid[geom] <= 0) {
      error = "foot-order-mismatch";
      return false;
    }
    foot_geom_ids_[leg] = geom;
    foot_body_ids_[leg] = model->geom_bodyid[geom];
  }
  ground_geom_id_ = ground_geom_id;
  root_body_id_ = root_body_id;
  initialized_ = true;
  error.clear();
  return true;
}

bool MujocoStateProvider::update(const mjModel* model, mjData* data,
                                 const bool non_foot_collision, const bool fallen,
                                 const bool out_of_bounds, RobotState& state,
                                 std::string& error) const {
  if (!initialized_ || !model || !data) {
    error = "state-provider-not-initialized";
    return false;
  }
  state = RobotState{};
  state.simulation_time = data->time;
  state.base_position = vector3(data->xpos + root_body_id_ * 3);
  state.base_rotation = matrix3(data->xmat + root_body_id_ * 9);
  state.base_orientation = Eigen::Quaterniond(state.base_rotation).normalized();

  mjtNum velocity[6]{};
  mj_objectVelocity(model, data, mjOBJ_BODY, root_body_id_, velocity, 0);
  state.base_angular_velocity_world = vector3(velocity);
  state.base_linear_velocity_world = vector3(velocity + 3);
  state.base_angular_velocity_body = state.base_rotation.transpose() * state.base_angular_velocity_world;
  state.base_linear_velocity_body = state.base_rotation.transpose() * state.base_linear_velocity_world;

  mj_subtreeVel(model, data);
  state.center_of_mass = vector3(data->subtree_com + root_body_id_ * 3);
  state.center_of_mass_velocity = vector3(data->subtree_linvel + root_body_id_ * 3);
  state.total_mass = 0.0;
  state.centroidal_inertia_world.setZero();
  for (int body = 1; body < model->nbody; ++body) {
    const double mass = model->body_mass[body];
    state.total_mass += mass;
    const Eigen::Matrix3d rotation = matrix3(data->ximat + body * 9);
    const Eigen::Vector3d diagonal(model->body_inertia[body * 3], model->body_inertia[body * 3 + 1],
                                   model->body_inertia[body * 3 + 2]);
    const Eigen::Vector3d offset = vector3(data->xipos + body * 3) - state.center_of_mass;
    state.centroidal_inertia_world += rotation * diagonal.asDiagonal() * rotation.transpose() +
        mass * (offset.squaredNorm() * Eigen::Matrix3d::Identity() - offset * offset.transpose());
  }

  for (std::size_t index = 0; index < kJointCount; ++index) {
    state.joint_position[static_cast<int>(index)] = data->qpos[qpos_addresses_[index]];
    state.joint_velocity[static_cast<int>(index)] = data->qvel[dof_addresses_[index]];
  }
  std::vector<mjtNum> jacobian(static_cast<std::size_t>(3 * model->nv));
  for (std::size_t leg = 0; leg < kLegCount; ++leg) {
    const int geom = foot_geom_ids_[leg];
    state.foot_position_world[leg] = vector3(data->geom_xpos + geom * 3);
    std::fill(jacobian.begin(), jacobian.end(), 0.0);
    mj_jacGeom(model, data, jacobian.data(), nullptr, geom);
    for (int row = 0; row < 3; ++row) {
      for (int column = 0; column < 3; ++column) {
        state.foot_jacobian_world[leg](row, column) =
            jacobian[static_cast<std::size_t>(row * model->nv + dof_addresses_[leg * 3 + column])];
      }
    }
    state.foot_velocity_world[leg].setZero();
    for (int row = 0; row < 3; ++row) {
      for (int dof = 0; dof < model->nv; ++dof) {
        state.foot_velocity_world[leg][row] +=
            jacobian[static_cast<std::size_t>(row * model->nv + dof)] * data->qvel[dof];
      }
    }
  }

  for (int contact_index = 0; contact_index < data->ncon; ++contact_index) {
    const mjContact& contact = data->contact[contact_index];
    for (std::size_t leg = 0; leg < kLegCount; ++leg) {
      const bool foot_is_geom1 = contact.geom1 == foot_geom_ids_[leg];
      const bool foot_is_geom2 = contact.geom2 == foot_geom_ids_[leg];
      if ((!foot_is_geom1 && !foot_is_geom2) ||
          (foot_is_geom1 ? contact.geom2 : contact.geom1) != ground_geom_id_) continue;
      mjtNum contact_force[6]{};
      mj_contactForce(model, data, contact_index, contact_force);
      Eigen::Vector3d world_force = Eigen::Vector3d::Zero();
      for (int world_axis = 0; world_axis < 3; ++world_axis) {
        for (int contact_axis = 0; contact_axis < 3; ++contact_axis) {
          world_force[world_axis] += contact.frame[contact_axis * 3 + world_axis] * contact_force[contact_axis];
        }
      }
      if (foot_is_geom1) world_force = -world_force;
      state.actual_contact_force_world[leg] += world_force;
      state.contacts[leg] = true;
    }
  }
  state.non_foot_collision = non_foot_collision;
  state.fallen = fallen;
  state.out_of_bounds = out_of_bounds;
  Eigen::SelfAdjointEigenSolver<Eigen::Matrix3d> inertia_solver(state.centroidal_inertia_world);
  state.finite = true;
  if (!std::isfinite(state.simulation_time) || !std::isfinite(state.total_mass) || state.total_mass <= 1.0) {
    error = "invalid-time-or-mass";
    state.finite = false;
  } else if (!finite_matrix(state.base_position) || !finite_matrix(state.base_rotation) ||
             !finite_matrix(state.base_linear_velocity_world) || !finite_matrix(state.base_angular_velocity_world)) {
    error = "invalid-base-state";
    state.finite = false;
  } else if (!finite_matrix(state.center_of_mass) || !finite_matrix(state.center_of_mass_velocity)) {
    error = "invalid-com-state";
    state.finite = false;
  } else if (!finite_matrix(state.centroidal_inertia_world) || inertia_solver.info() != Eigen::Success ||
             inertia_solver.eigenvalues().minCoeff() <= 1e-6) {
    error = "invalid-centroidal-inertia";
    state.finite = false;
  } else if (!finite_matrix(state.joint_position) || !finite_matrix(state.joint_velocity)) {
    error = "invalid-joint-state";
    state.finite = false;
  }
  for (std::size_t leg = 0; leg < kLegCount && state.finite; ++leg) {
    state.finite = finite_matrix(state.foot_position_world[leg]) && finite_matrix(state.foot_velocity_world[leg]) &&
        finite_matrix(state.actual_contact_force_world[leg]) && finite_matrix(state.foot_jacobian_world[leg]);
    if (!state.finite) error = "invalid-foot-state-" + std::to_string(leg);
  }
  if (!state.finite) {
    return false;
  }
  error.clear();
  return true;
}

}  // namespace sidecar::controllers::mpc

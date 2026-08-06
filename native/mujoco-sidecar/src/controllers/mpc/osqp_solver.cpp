#include "controllers/mpc/qp_solver.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

#include <osqp.h>

namespace sidecar::controllers::mpc {
namespace {

struct CscStorage {
  std::vector<OSQPFloat> values;
  std::vector<OSQPInt> row_indices;
  std::vector<OSQPInt> column_pointers;
  OSQPCscMatrix matrix{};
};

CscStorage dense_upper_to_csc(const Eigen::MatrixXd& input) {
  CscStorage result;
  result.column_pointers.reserve(static_cast<std::size_t>(input.cols() + 1));
  for (int column = 0; column < input.cols(); ++column) {
    result.column_pointers.push_back(static_cast<OSQPInt>(result.values.size()));
    for (int row = 0; row <= column; ++row) {
      const double value = input(row, column);
      if (std::abs(value) <= 1e-14) continue;
      result.row_indices.push_back(static_cast<OSQPInt>(row));
      result.values.push_back(value);
    }
  }
  result.column_pointers.push_back(static_cast<OSQPInt>(result.values.size()));
  OSQPCscMatrix_set_data(&result.matrix, static_cast<OSQPInt>(input.rows()),
                         static_cast<OSQPInt>(input.cols()),
                         static_cast<OSQPInt>(result.values.size()), result.values.data(),
                         result.row_indices.data(), result.column_pointers.data());
  return result;
}

CscStorage sparse_to_csc(const Eigen::SparseMatrix<double>& input) {
  Eigen::SparseMatrix<double> compressed = input;
  compressed.makeCompressed();
  CscStorage result;
  result.values.reserve(static_cast<std::size_t>(compressed.nonZeros()));
  result.row_indices.reserve(static_cast<std::size_t>(compressed.nonZeros()));
  result.column_pointers.reserve(static_cast<std::size_t>(compressed.cols() + 1));
  for (int column = 0; column < compressed.cols(); ++column) {
    result.column_pointers.push_back(static_cast<OSQPInt>(result.values.size()));
    for (Eigen::SparseMatrix<double>::InnerIterator item(compressed, column); item; ++item) {
      result.row_indices.push_back(static_cast<OSQPInt>(item.row()));
      result.values.push_back(item.value());
    }
  }
  result.column_pointers.push_back(static_cast<OSQPInt>(result.values.size()));
  OSQPCscMatrix_set_data(&result.matrix, static_cast<OSQPInt>(compressed.rows()),
                         static_cast<OSQPInt>(compressed.cols()),
                         static_cast<OSQPInt>(result.values.size()), result.values.data(),
                         result.row_indices.data(), result.column_pointers.data());
  return result;
}

bool finite_problem(const QpProblem& problem) {
  return problem.hessian.rows() == problem.hessian.cols() &&
      problem.gradient.size() == problem.hessian.rows() &&
      problem.constraint_matrix.cols() == problem.hessian.cols() &&
      problem.constraint_matrix.rows() == problem.lower_bound.size() &&
      problem.lower_bound.size() == problem.upper_bound.size() &&
      problem.hessian.array().isFinite().all() && problem.gradient.array().isFinite().all() &&
      problem.constraint_matrix.coeffs().isFinite().all() &&
      !problem.lower_bound.array().isNaN().any() && !problem.upper_bound.array().isNaN().any() &&
      (problem.lower_bound.array() <= problem.upper_bound.array()).all();
}

}  // namespace

QpResult OsqpSolver::solve(const QpProblem& problem, const int maximum_iterations,
                           const double absolute_tolerance, const double relative_tolerance,
                           const double time_limit_seconds) {
  QpResult result;
  if (!finite_problem(problem) || maximum_iterations <= 0 || absolute_tolerance <= 0.0 ||
      relative_tolerance <= 0.0 || time_limit_seconds <= 0.0) {
    result.status = "invalid_problem";
    return result;
  }
  CscStorage p = dense_upper_to_csc(problem.hessian);
  CscStorage a = sparse_to_csc(problem.constraint_matrix);
  std::vector<OSQPFloat> q(problem.gradient.data(), problem.gradient.data() + problem.gradient.size());
  std::vector<OSQPFloat> lower(static_cast<std::size_t>(problem.lower_bound.size()));
  std::vector<OSQPFloat> upper(static_cast<std::size_t>(problem.upper_bound.size()));
  for (int index = 0; index < problem.lower_bound.size(); ++index) {
    lower[static_cast<std::size_t>(index)] = std::clamp(problem.lower_bound[index], -OSQP_INFTY, OSQP_INFTY);
    upper[static_cast<std::size_t>(index)] = std::clamp(problem.upper_bound[index], -OSQP_INFTY, OSQP_INFTY);
  }
  OSQPSettings settings{};
  osqp_set_default_settings(&settings);
  settings.verbose = 0;
  settings.warm_starting = 1;
  settings.polishing = 0;
  settings.max_iter = maximum_iterations;
  settings.eps_abs = absolute_tolerance;
  settings.eps_rel = relative_tolerance;
  settings.check_termination = 10;
  settings.scaling = 5;
  settings.time_limit = time_limit_seconds;
  OSQPSolver* solver = nullptr;
  const OSQPInt setup_status = osqp_setup(&solver, &p.matrix, q.data(), &a.matrix, lower.data(), upper.data(),
                                          static_cast<OSQPInt>(a.matrix.m), static_cast<OSQPInt>(p.matrix.n), &settings);
  if (setup_status != 0 || !solver) {
    result.status = "setup_failed_" + std::to_string(setup_status);
    return result;
  }
  if (previous_primal_.size() == problem.gradient.size() &&
      previous_dual_.size() == problem.lower_bound.size() && previous_primal_.array().isFinite().all() &&
      previous_dual_.array().isFinite().all()) {
    osqp_warm_start(solver, previous_primal_.data(), previous_dual_.data());
  }
  const OSQPInt solve_status = osqp_solve(solver);
  result.status = solver->info ? solver->info->status : "missing_info";
  result.iterations = solver->info ? static_cast<int>(solver->info->iter) : 0;
  result.solve_ms = solver->info ? solver->info->run_time * 1000.0 : 0.0;
  result.solved = solve_status == 0 && solver->info &&
      (solver->info->status_val == OSQP_SOLVED || solver->info->status_val == OSQP_SOLVED_INACCURATE) &&
      solver->solution && solver->solution->x;
  if (result.solved) {
    result.primal = Eigen::Map<Eigen::VectorXd>(solver->solution->x, problem.gradient.size());
    result.dual = Eigen::Map<Eigen::VectorXd>(solver->solution->y, problem.lower_bound.size());
    result.solved = result.primal.array().isFinite().all() && result.dual.array().isFinite().all();
    if (result.solved) {
      previous_primal_ = result.primal;
      previous_dual_ = result.dual;
    } else {
      result.status = "non_finite_solution";
      reset_warm_start();
    }
  }
  osqp_cleanup(solver);
  return result;
}

void OsqpSolver::reset_warm_start() {
  previous_primal_.resize(0);
  previous_dual_.resize(0);
}

}  // namespace sidecar::controllers::mpc

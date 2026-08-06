#pragma once

#include <string>

#include <Eigen/Core>
#include <Eigen/SparseCore>

namespace sidecar::controllers::mpc {

struct QpProblem {
  Eigen::MatrixXd hessian;
  Eigen::VectorXd gradient;
  Eigen::SparseMatrix<double> constraint_matrix;
  Eigen::VectorXd lower_bound;
  Eigen::VectorXd upper_bound;
};

struct QpResult {
  Eigen::VectorXd primal;
  Eigen::VectorXd dual;
  std::string status{"not_run"};
  int iterations{0};
  double solve_ms{0.0};
  bool solved{false};
};

class OsqpSolver {
 public:
  QpResult solve(const QpProblem& problem, int maximum_iterations,
                 double absolute_tolerance, double relative_tolerance,
                 double time_limit_seconds);
  void reset_warm_start();

 private:
  Eigen::VectorXd previous_primal_;
  Eigen::VectorXd previous_dual_;
};

}  // namespace sidecar::controllers::mpc

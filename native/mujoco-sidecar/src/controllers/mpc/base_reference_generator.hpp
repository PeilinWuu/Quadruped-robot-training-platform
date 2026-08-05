#pragma once

#include "controllers/locomotion_types.hpp"

namespace sidecar::controllers::mpc {

class BaseReferenceGenerator {
 public:
  MotionTarget update(const MotionTarget& command, double dt);
  void reset(double body_height);

 private:
  MotionTarget filtered_{};
};

}  // namespace sidecar::controllers::mpc

/*
 * Lightweight monitoring UI actions. These actions intentionally do not own
 * renderer resources and are consumed on the application thread.
 */
#pragma once

#include <cstdint>

namespace vk_gaussian_splatting {

enum class ControlMode
{
  Autonomous,
  Assisted,
  Manual,
};

enum class TrainingCommand
{
  Start,
  Pause,
  Resume,
  Stop,
};

enum class CommandStatus
{
  Idle,
  Pending,
  Succeeded,
  Failed,
};

struct SetControlModeAction
{
  ControlMode mode{ControlMode::Autonomous};
  uint64_t    requestId{0};
};

struct TrainingAction
{
  TrainingCommand command{TrainingCommand::Start};
  uint64_t        requestId{0};
};

}  // namespace vk_gaussian_splatting

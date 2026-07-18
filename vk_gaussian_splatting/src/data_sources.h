#pragma once

#include <chrono>

#include "application_state.h"

namespace vk_gaussian_splatting {

class IRobotDataSource
{
public:
  virtual ~IRobotDataSource() = default;
  virtual void              reset(std::chrono::steady_clock::time_point now) = 0;
  virtual void              update(std::chrono::steady_clock::time_point now) = 0;
  virtual const RobotState& snapshot() const = 0;
  virtual void              requestControlMode(ControlMode mode) = 0;
};

class ISensorDataSource
{
public:
  virtual ~ISensorDataSource() = default;
  virtual void               reset(std::chrono::steady_clock::time_point now) = 0;
  virtual void               update(std::chrono::steady_clock::time_point now) = 0;
  virtual const SensorState& snapshot() const = 0;
};

class ITrainingDataSource
{
public:
  virtual ~ITrainingDataSource() = default;
  virtual void                 reset(std::chrono::steady_clock::time_point now) = 0;
  virtual void                 update(std::chrono::steady_clock::time_point now) = 0;
  virtual const TrainingState& snapshot() const = 0;
  virtual void                 request(TrainingCommand command) = 0;
};

}  // namespace vk_gaussian_splatting

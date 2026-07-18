#pragma once

#include "data_sources.h"

namespace vk_gaussian_splatting {

class MockRobotDataSource final : public IRobotDataSource
{
public:
  void              reset(std::chrono::steady_clock::time_point now) override;
  void              update(std::chrono::steady_clock::time_point now) override;
  const RobotState& snapshot() const override { return m_state; }
  void              requestControlMode(ControlMode mode) override;

private:
  RobotState                              m_state;
  std::chrono::steady_clock::time_point  m_started{};
  std::chrono::steady_clock::time_point  m_nextUpdate{};
};

class MockSensorDataSource final : public ISensorDataSource
{
public:
  void               reset(std::chrono::steady_clock::time_point now) override;
  void               update(std::chrono::steady_clock::time_point now) override;
  const SensorState& snapshot() const override { return m_state; }

private:
  SensorState                             m_state;
  std::chrono::steady_clock::time_point  m_started{};
  std::chrono::steady_clock::time_point  m_nextUpdate{};
};

class MockTrainingDataSource final : public ITrainingDataSource
{
public:
  void                 reset(std::chrono::steady_clock::time_point now) override;
  void                 update(std::chrono::steady_clock::time_point now) override;
  const TrainingState& snapshot() const override { return m_state; }
  void                 request(TrainingCommand command) override;

private:
  void transition(TrainingRunState state, std::chrono::steady_clock::time_point now);

  TrainingState                           m_state;
  std::chrono::steady_clock::time_point  m_nextUpdate{};
  std::chrono::steady_clock::time_point  m_lastTick{};
  std::chrono::steady_clock::time_point  m_pausedAt{};
  bool                                    m_completedAutomaticPause{false};
};

}  // namespace vk_gaussian_splatting

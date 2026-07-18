#include "mock_data_sources.h"

#include <algorithm>
#include <cmath>

namespace vk_gaussian_splatting {

using namespace std::chrono_literals;

void MockRobotDataSource::reset(std::chrono::steady_clock::time_point now)
{
  m_state      = RobotState{};
  m_started    = now;
  m_nextUpdate = now;
  m_state.lastUpdate = now;
}

void MockRobotDataSource::requestControlMode(ControlMode mode)
{
  m_state.requestedControlMode = mode;
  m_state.commandStatus        = CommandStatus::Pending;
}

void MockRobotDataSource::update(std::chrono::steady_clock::time_point now)
{
  if(now < m_nextUpdate)
    return;
  m_nextUpdate = now + 200ms;

  const float seconds = std::chrono::duration<float>(now - m_started).count();
  m_state.batteryPercent  = std::max(15.0F, 78.0F - seconds * 0.015F);
  m_state.linearVelocity  = 0.72F + 0.13F * std::sin(seconds * 0.45F);
  m_state.angularVelocity = 0.05F * std::sin(seconds * 0.31F);
  m_state.position        = {23.5F + seconds * 0.03F, 14.2F + 0.25F * std::sin(seconds * 0.18F), 0.28F};
  m_state.orientationRpy  = {0.01F * std::sin(seconds * 0.3F), 0.0F, 0.35F + 0.02F * std::sin(seconds * 0.2F)};
  if(m_state.commandStatus == CommandStatus::Pending)
  {
    m_state.appliedControlMode = m_state.requestedControlMode;
    m_state.commandStatus      = CommandStatus::Succeeded;
  }
  m_state.lastUpdate = now;
}

void MockSensorDataSource::reset(std::chrono::steady_clock::time_point now)
{
  m_state      = SensorState{};
  m_started    = now;
  m_nextUpdate = now;
  m_state.lastUpdate = now;
}

void MockSensorDataSource::update(std::chrono::steady_clock::time_point now)
{
  if(now < m_nextUpdate)
    return;
  m_nextUpdate = now + 250ms;

  const float seconds = std::chrono::duration<float>(now - m_started).count();
  m_state.temperatureC    = 62.3F + 1.4F * std::sin(seconds * 0.12F);
  m_state.smokeDensity    = 0.65F + 0.025F * std::sin(seconds * 0.17F);
  m_state.visibilityMeters = 3.8F - 0.25F * std::sin(seconds * 0.17F);
  m_state.oxygenPercent   = 18.6F - 0.15F * std::sin(seconds * 0.09F);
  m_state.lastUpdate      = now;
}

void MockTrainingDataSource::reset(std::chrono::steady_clock::time_point now)
{
  m_state                    = TrainingState{};
  m_nextUpdate               = now;
  m_lastTick                 = now;
  m_pausedAt                 = now;
  m_completedAutomaticPause = false;
  m_state.lastUpdate         = now;
}

void MockTrainingDataSource::transition(TrainingRunState state, std::chrono::steady_clock::time_point now)
{
  m_state.state         = state;
  m_state.commandStatus = CommandStatus::Succeeded;
  if(state == TrainingRunState::Paused)
    m_pausedAt = now;
}

void MockTrainingDataSource::request(TrainingCommand command)
{
  const auto now = std::chrono::steady_clock::now();
  m_state.commandStatus = CommandStatus::Pending;
  switch(command)
  {
    case TrainingCommand::Start:
      if(m_state.state == TrainingRunState::Idle || m_state.state == TrainingRunState::Stopped)
      {
        m_state = TrainingState{};
        m_state.state = TrainingRunState::Running;
        m_completedAutomaticPause = false;
        m_lastTick = now;
      }
      break;
    case TrainingCommand::Pause:
      if(m_state.state == TrainingRunState::Running)
      {
        m_state.state = TrainingRunState::Paused;
        m_pausedAt    = now;
      }
      break;
    case TrainingCommand::Resume:
      if(m_state.state == TrainingRunState::Paused)
      {
        m_state.state = TrainingRunState::Running;
        m_completedAutomaticPause = true;
        m_lastTick = now;
      }
      break;
    case TrainingCommand::Stop:
      m_state.state = TrainingRunState::Stopped;
      break;
  }
}

void MockTrainingDataSource::update(std::chrono::steady_clock::time_point now)
{
  if(now < m_nextUpdate)
    return;
  m_nextUpdate = now + 200ms;

  const auto delta = now - m_lastTick;
  m_lastTick       = now;
  if(m_state.state == TrainingRunState::Idle)
    transition(TrainingRunState::Running, now);
  else if(m_state.state == TrainingRunState::Running)
  {
    m_state.elapsed += delta;
    const float elapsedSeconds = std::chrono::duration<float>(m_state.elapsed).count();
    if(!m_completedAutomaticPause && elapsedSeconds >= 8.0F)
      transition(TrainingRunState::Paused, now);
    else if(m_completedAutomaticPause && elapsedSeconds >= 16.0F)
      transition(TrainingRunState::Stopped, now);
  }
  else if(m_state.state == TrainingRunState::Paused && now - m_pausedAt >= 3s)
  {
    m_completedAutomaticPause = true;
    transition(TrainingRunState::Running, now);
  }

  const float elapsedSeconds = std::chrono::duration<float>(m_state.elapsed).count();
  m_state.episode     = 806U + static_cast<uint32_t>(elapsedSeconds / 4.0F);
  m_state.step        = static_cast<uint32_t>(elapsedSeconds * 20.0F);
  m_state.reward      = -35.0F + elapsedSeconds * 8.0F + 4.0F * std::sin(elapsedSeconds * 0.6F);
  m_state.loss        = std::max(0.02F, 0.82F * std::exp(-elapsedSeconds / 11.0F));
  m_state.successRate = std::min(96.0F, 18.0F + elapsedSeconds * 3.2F);
  m_state.lastUpdate  = now;
  if(m_state.commandStatus == CommandStatus::Pending)
    m_state.commandStatus = CommandStatus::Succeeded;
}

}  // namespace vk_gaussian_splatting

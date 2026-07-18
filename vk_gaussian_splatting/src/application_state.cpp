#include "application_state.h"

namespace vk_gaussian_splatting {

const char* toString(DataSourceKind value)
{
  switch(value)
  {
    case DataSourceKind::Mock:
      return "MOCK";
    case DataSourceKind::Real:
      return "REAL";
  }
  return "UNKNOWN";
}

const char* toString(ConnectionState value)
{
  switch(value)
  {
    case ConnectionState::Offline:
      return "OFFLINE";
    case ConnectionState::Online:
      return "ONLINE";
    case ConnectionState::Error:
      return "ERROR";
  }
  return "UNKNOWN";
}

const char* toString(SceneLoadState value)
{
  switch(value)
  {
    case SceneLoadState::Empty:
      return "EMPTY";
    case SceneLoadState::Loading:
      return "LOADING";
    case SceneLoadState::Ready:
      return "READY";
    case SceneLoadState::Failed:
      return "FAILED";
  }
  return "UNKNOWN";
}

const char* toString(SimulationState value)
{
  switch(value)
  {
    case SimulationState::Idle:
      return "IDLE";
    case SimulationState::Running:
      return "RUNNING";
    case SimulationState::Paused:
      return "PAUSED";
    case SimulationState::Stopped:
      return "STOPPED";
  }
  return "UNKNOWN";
}

const char* toString(TrainingRunState value)
{
  switch(value)
  {
    case TrainingRunState::Idle:
      return "IDLE";
    case TrainingRunState::Running:
      return "RUNNING";
    case TrainingRunState::Paused:
      return "PAUSED";
    case TrainingRunState::Stopped:
      return "STOPPED";
  }
  return "UNKNOWN";
}

const char* toString(ControlMode value)
{
  switch(value)
  {
    case ControlMode::Autonomous:
      return "AUTONOMOUS";
    case ControlMode::Assisted:
      return "ASSISTED";
    case ControlMode::Manual:
      return "MANUAL";
  }
  return "UNKNOWN";
}

const char* toString(CommandStatus value)
{
  switch(value)
  {
    case CommandStatus::Idle:
      return "IDLE";
    case CommandStatus::Pending:
      return "PENDING";
    case CommandStatus::Succeeded:
      return "SUCCEEDED";
    case CommandStatus::Failed:
      return "FAILED";
  }
  return "UNKNOWN";
}

}  // namespace vk_gaussian_splatting

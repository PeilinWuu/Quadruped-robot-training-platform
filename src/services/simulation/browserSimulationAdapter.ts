import type { SimulationAdapter, SimulationStatus } from './types'
import { FLAT_GROUND_ENVIRONMENT } from './types'

const MESSAGE = '机器人预览仅桌面版可用'
const STATUS: SimulationStatus = {
  state: 'unavailable', simulationState: 'unloaded', sidecarVersion: null,
  model: null, speed: 1, startedAt: null,
  error: { code: 'DESKTOP_ONLY', message: MESSAGE },
}
function unavailable<T>(): Promise<T> {
  return Promise.reject(new Error(MESSAGE))
}

export const browserSimulationAdapter: SimulationAdapter = {
  desktop: false,
  startSidecar: unavailable,
  getStatus: async () => ({ ...STATUS }),
  ping: unavailable,
  stopSidecar: unavailable,
  loadModel: unavailable,
  listAvailableEnvironments: async () => [{ ...FLAT_GROUND_ENVIRONMENT }],
  getCurrentEnvironment: async () => null,
  getLatestCollisionState: async () => null,
  getLatestCollisionEvent: async () => null,
  startSimulation: unavailable,
  pauseSimulation: unavailable,
  stepSimulation: unavailable,
  resetSimulation: unavailable,
  stopSimulation: unavailable,
  setSpeed: unavailable,
  getLatestPose: async () => null,
  setMotionCommand: unavailable,
  clearMotionCommand: unavailable,
  setTelemetryRate: unavailable,
  getLatestTelemetry: async () => null,
  subscribe: async () => ({ unsubscribe: async () => undefined }),
}

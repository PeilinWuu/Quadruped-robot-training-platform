import type { SimulationAdapter, SimulationStatus } from './types'

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
  loadDefaultModel: unavailable,
  startSimulation: unavailable,
  pauseSimulation: unavailable,
  stepSimulation: unavailable,
  resetSimulation: unavailable,
  stopSimulation: unavailable,
  setSpeed: unavailable,
  getLatestPose: async () => null,
  subscribe: async () => ({ unsubscribe: async () => undefined }),
}

import { create } from 'zustand'
import type { ControlMode, EnvironmentParams, RobotState, Scene, SensorSnapshot, SimulationStatus, TrainingMetrics, TrainingTask } from '../types'
import { services } from '../services'

interface AppState {
  scenes: Scene[]; activeSceneId: string; status: SimulationStatus; speed: number; activeSensor: string; elapsed: number
  robot: RobotState | null; sensor: SensorSnapshot | null; task: TrainingTask | null; metrics: TrainingMetrics[]
  initialize: () => Promise<void>; selectScene: (id: string) => void; updateEnvironment: (key: keyof EnvironmentParams, value: number) => void
  setStatus: (status: SimulationStatus) => void; setSpeed: (speed: number) => void; setSensor: (sensor: string) => void; setControlMode: (mode: ControlMode) => void; tick: () => void; appendMetrics: () => void
}

export const useAppStore = create<AppState>((set) => ({
  scenes: [], activeSceneId: '', status: 'running', speed: 1, activeSensor: 'all', elapsed: 765, robot: null, sensor: null, task: null, metrics: [],
  initialize: async () => { const [sceneResult, robotResult, sensorResult, taskResult, metricsResult] = await Promise.all([services.scene.list(), services.robot.getState(), services.sensor.getSnapshot(), services.training.getTask(), services.training.getMetrics()]); set({ scenes: sceneResult.data, activeSceneId: sceneResult.data[0]?.id ?? '', robot: robotResult.data, sensor: sensorResult.data, task: taskResult.data, metrics: metricsResult.data }) },
  selectScene: (id) => set({ activeSceneId: id }),
  updateEnvironment: (key, value) => set((state) => ({ scenes: state.scenes.map((scene) => scene.id === state.activeSceneId ? { ...scene, environment: { ...scene.environment, [key]: value } } : scene) })),
  setStatus: (status) => set({ status }), setSpeed: (speed) => set({ speed }), setSensor: (activeSensor) => set({ activeSensor }),
  setControlMode: (controlMode) => set((state) => ({ robot: state.robot ? { ...state.robot, controlMode } : null })),
  tick: () => set((state) => state.status === 'running' ? { elapsed: state.elapsed + state.speed } : {}),
  appendMetrics: () => set((state) => { if (state.status !== 'running' || !state.metrics.length) return {}; const last = state.metrics[state.metrics.length - 1]; const next: TrainingMetrics = { episode: last.episode + 5, reward: Math.min(300, last.reward + (Math.random() - .38) * 18), successRate: Math.min(98, Math.max(0, last.successRate + (Math.random() - .4) * 3)), policyLoss: Math.max(.005, last.policyLoss * (.97 + Math.random() * .03)), valueLoss: Math.max(.008, last.valueLoss * (.965 + Math.random() * .04)) }; return { metrics: [...state.metrics.slice(-44), next] } }),
}))

import type { RobotService, SceneService, SensorService, SimulationService, TrainingService } from './contracts'

const unavailable = (): never => { throw new Error('真实数据适配器尚未接入，请配置后端接口') }
export const realSceneService: SceneService = { list: async () => unavailable(), get: async () => unavailable(), updateEnvironment: async () => unavailable() }
export const realSimulationService: SimulationService = { start: async () => unavailable(), pause: async () => unavailable(), stop: async () => unavailable(), reset: async () => unavailable(), setSpeed: async () => unavailable() }
export const realTrainingService: TrainingService = { getTask: async () => unavailable(), getMetrics: async () => unavailable() }
export const realRobotService: RobotService = { getState: async () => unavailable(), setControlMode: async () => unavailable() }
export const realSensorService: SensorService = { getSnapshot: async () => unavailable(), subscribe: () => unavailable() }

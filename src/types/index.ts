export type SimulationStatus = 'running' | 'paused' | 'stopped'
export type SensorType = 'rgb' | 'depth' | 'thermal' | 'lidar'
export type ControlMode = 'autonomous' | 'manual' | 'assisted'

export interface EnvironmentParams {
  fireIntensity: number
  smokeDensity: number
  ambientTemp: number
  obstacleDensity: number
}

export interface Scene {
  id: string
  name: string
  building: string
  area: number
  floor: string
  fireLocation: string
  risk: '高' | '中' | '低'
  description: string
  environment: EnvironmentParams
}

export interface TrainingMetrics {
  episode: number
  reward: number
  successRate: number
  policyLoss: number
  valueLoss: number
}

export interface RobotState {
  battery: number
  cpuTemp: number
  jointStatus: string
  gait: string
  position: [number, number, number]
  speed: number
  controlMode: ControlMode
}

export interface SensorSnapshot {
  temperature: number
  smoke: number
  visibility: number
  co: number
  oxygen: number
  wind: number
}

export interface TrainingTask {
  id: string
  name: string
  description: string
  status: '训练中' | '已暂停' | '未开始'
  progress: number
  currentReward: number
  elapsed: number
  duration: number
  episode: number
  maxEpisodes: number
}

export interface ServiceResult<T> { data: T; source: 'mock' | 'real' }

export type SimulationProcessState =
  | 'idle' | 'starting' | 'ready' | 'stopping' | 'failed' | 'crashed'
  | 'unresponsive' | 'unavailable'

export type SimulationState = 'unloaded' | 'loaded' | 'running' | 'paused' | 'stopped'
export type SimulationModelId = 'unitree-go2-menagerie' | 'minimal-quadruped-v1'
export interface SimulationModelDescription {
  id: SimulationModelId; displayName: string; source: string; isDefault: boolean
  visualProfile: string; description: string
}

export const SIMULATION_MODELS: readonly SimulationModelDescription[] = [
  { id: 'unitree-go2-menagerie', displayName: '宇树 Go2（实验室模型）', source: 'MuJoCo Menagerie / Unitree Go2', isDefault: true, visualProfile: 'Go2 基础几何预览', description: '当前仅保持站立，不包含步态控制' },
  { id: 'minimal-quadruped-v1', displayName: '最小四足（测试模型）', source: '项目测试模型', isDefault: false, visualProfile: '最小四足基础几何预览', description: '用于仿真链路回归测试' },
] as const
export const DEFAULT_SIMULATION_MODEL_ID: SimulationModelId = 'unitree-go2-menagerie'

export interface JointPose { name: string; position: number }

export interface RobotPose {
  sequence: number
  simulationTime: number
  wallTime: number
  rootPosition: [number, number, number]
  /** PlayCanvas Y-up quaternion in [x, y, z, w] order. */
  rootOrientation: [number, number, number, number]
  joints: JointPose[]
}
export interface ModelMetadata {
  modelId: string
  timestep: number
  jointCount: number
  actuatorCount: number
  bodyCount: number
}

export interface SimulationErrorInfo { code: string; message: string; recoverable?: boolean }

export interface SimulationStatus {
  state: SimulationProcessState
  simulationState: SimulationState
  sidecarVersion: string | null
  model: ModelMetadata | null
  speed: number
  startedAt: number | null
  error: SimulationErrorInfo | null
}

export type SimulationEvent =
  | { type: 'model_loaded'; payload: ModelMetadata }
  | { type: 'pose'; payload: RobotPose }
  | { type: 'state_changed'; payload: { state: SimulationState; speed?: number } }
  | { type: 'warning' | 'error'; payload: SimulationErrorInfo }

export interface SimulationSubscription { unsubscribe(): Promise<void> }
export type SimulationListener = (event: SimulationEvent) => void

export interface SimulationAdapter {
  readonly desktop: boolean
  startSidecar(): Promise<SimulationStatus>
  getStatus(): Promise<SimulationStatus>
  ping(): Promise<{ latencyMs: number; nonceVerified: boolean }>
  stopSidecar(): Promise<SimulationStatus>
  loadModel(modelId: SimulationModelId): Promise<ModelMetadata>
  startSimulation(): Promise<SimulationState>
  pauseSimulation(): Promise<SimulationState>
  stepSimulation(steps: number): Promise<RobotPose>
  resetSimulation(): Promise<SimulationState>
  stopSimulation(): Promise<SimulationState>
  setSpeed(speed: number): Promise<number>
  getLatestPose(): Promise<RobotPose | null>
  subscribe(listener: SimulationListener): Promise<SimulationSubscription>
}

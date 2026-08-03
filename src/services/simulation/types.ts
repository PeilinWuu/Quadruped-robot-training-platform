export type SimulationProcessState =
  | 'idle' | 'starting' | 'ready' | 'stopping' | 'failed' | 'crashed'
  | 'unresponsive' | 'unavailable'

export type SimulationState = 'unloaded' | 'loaded' | 'running' | 'paused' | 'stopped'

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
  loadDefaultModel(): Promise<ModelMetadata>
  startSimulation(): Promise<SimulationState>
  pauseSimulation(): Promise<SimulationState>
  stepSimulation(steps: number): Promise<RobotPose>
  resetSimulation(): Promise<SimulationState>
  stopSimulation(): Promise<SimulationState>
  setSpeed(speed: number): Promise<number>
  getLatestPose(): Promise<RobotPose | null>
  subscribe(listener: SimulationListener): Promise<SimulationSubscription>
}

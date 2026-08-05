export type SimulationProcessState =
  | 'idle' | 'starting' | 'ready' | 'stopping' | 'failed' | 'crashed'
  | 'unresponsive' | 'unavailable'

export type SimulationState = 'unloaded' | 'loaded' | 'running' | 'paused' | 'stopped'
export type SimulationModelId = 'unitree-go2-menagerie' | 'minimal-quadruped-v1'
export type EnvironmentId = 'flat-ground-v1'
export interface EnvironmentMetadata {
  id: EnvironmentId; displayName: string; floorHeight: number; halfExtent: number
  demoBoundaryHalfExtent: number; spawnPosition: [number, number, number]
  spawnOrientation: [number, number, number, number]
  friction: [number, number, number]; solref: [number, number]; solimp: [number, number, number]
}
export const FLAT_GROUND_ENVIRONMENT: EnvironmentMetadata = {
  id: 'flat-ground-v1', displayName: '纯平地演示场景', floorHeight: 0, halfExtent: 10,
  demoBoundaryHalfExtent: 8, spawnPosition: [0, 0, 0], spawnOrientation: [0, 0, 0, 1],
  friction: [.9, .1, .01], solref: [.02, 1], solimp: [.9, .95, .001],
}
export interface SimulationModelDescription {
  id: SimulationModelId; displayName: string; source: string; isDefault: boolean
  visualProfile: string; description: string
}

export const SIMULATION_MODELS: readonly SimulationModelDescription[] = [
  { id: 'unitree-go2-menagerie', displayName: '宇树 Go2（实验室模型）', source: 'MuJoCo Menagerie / Unitree Go2', isDefault: true, visualProfile: 'Go2 基础几何预览', description: '支持仿真专用 Go2 Convex MPC 步态演示' },
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
export type MotionCommandMode = 'stand' | 'locomotion'
export interface MotionCommand {
  sequence: number
  mode: MotionCommandMode
  forwardVelocity: number
  lateralVelocity: number
  yawRate: number
  bodyHeight: number
  validForMs: number
}
export interface MotionCommandStatus extends MotionCommand {
  ageMs: number
  timedOut: boolean
  appliedByController: boolean
  bodyHeightApplied: boolean
  controllerAvailability: 'stand-hold' | 'go2-convex-mpc-v1' | 'not-implemented'
}
export interface LocomotionTelemetry {
  controllerId: 'go2-convex-mpc-v1'; availability: 'available' | 'unavailable'
  state: 'standing' | 'entering_trot' | 'locomotion' | 'stopping' | 'fault'
  commandedForwardVelocity: number; filteredForwardVelocity: number
  commandedYawRate: number; filteredYawRate: number
  measuredForwardVelocity: number; measuredYawRate: number
  mpcFrequencyHz: number; legControllerFrequencyHz: number; horizonSteps: number
  gaitFrequencyHz: number; dutyFactor: number; gaitPhase: number
  expectedContacts: [boolean, boolean, boolean, boolean]
  actualContacts: [boolean, boolean, boolean, boolean]
  desiredGroundForces: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]]
  actualGroundForces: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]]
  solverStatus: string; solverIterations: number; solverMeanMs: number; solverMaxMs: number
  qpFailureCount: number
  touchdownEventCount: number; onTimeTouchdownCount: number
  lateTouchdownEventCount: number; earlyTouchdownEventCount: number; touchdownTimeoutCount: number
  touchdownLatencyMeanMs: number; touchdownLatencyMaxMs: number; touchdownLatencyP95Ms: number
  footSlipSummary: number; jointLimitClipCount: number; actuatorSaturationCount: number
  faultReason: string | null
}
export interface TelemetryConfig { rateHz: number }
export interface JointTelemetry {
  name: string; position: number; velocity: number; actuatorTorque: number
  actuatorForce: number; controlTarget: number; lowerLimit: number | null
  upperLimit: number | null; limited: boolean
}
export interface FootTelemetry {
  name: 'FL' | 'FR' | 'RL' | 'RR'; inContact: boolean; contactCount: number
  normalForce: number; forceWorld: [number, number, number]; positionWorld: [number, number, number]
}
export interface PerformanceTelemetry {
  physicsFrequencyHz: number; controlFrequencyHz: number; posePublishFrequencyHz: number
  telemetryPublishFrequencyHz: number; realTimeFactor: number
  physicsStepMeanMs: number; physicsStepMaxMs: number
  controlStepMeanMs: number; controlStepMaxMs: number
  droppedPoseEvents: number; droppedTelemetryEvents: number; catchUpStepCount: number
}
export type CollisionCategory = 'feet' | 'calves' | 'thighs' | 'hips' | 'torso' | 'head' | 'otherRobot'
export type FallReason = 'none' | 'torso-contact' | 'orientation' | 'height' | 'multiple'
export interface StrongestContact {
  category: CollisionCategory; bodyName: string; geomName: string; normalForce: number
  positionWorld: [number, number, number]
}
export interface CollisionTelemetry {
  environmentId: EnvironmentId; totalEnvironmentContacts: number; footContacts: number
  nonFootContacts: number; torsoContacts: number; headContacts: number; limbContacts: number
  maxNormalForce: number; totalNormalForce: number; strongestContact: StrongestContact | null
  isFallen: boolean; fallReason: FallReason; isOutOfBounds: boolean
  rootHeightAboveFloor: number; roll: number; pitch: number
}
export type CollisionEventKind = 'collision_started' | 'collision_ended' | 'impact_detected' | 'fall_detected' | 'recovered' | 'out_of_bounds' | 'returned_in_bounds'
export interface CollisionEvent {
  kind: CollisionEventKind; simulationTime: number; category: CollisionCategory
  bodyName: string; geomName: string; normalForce: number; positionWorld: [number, number, number]
}
export interface RobotTelemetry {
  sequence: number; simulationTime: number; wallTime: number; modelId: SimulationModelId
  source: { kind: 'mujoco-simulation'; connectedToPhysicalRobot: false }
  root: {
    position: [number, number, number]; orientation: [number, number, number, number]
    linearVelocityWorld: [number, number, number]; angularVelocityWorld: [number, number, number]
    linearSpeed: number; angularSpeed: number
  }
  imu: {
    orientation: [number, number, number, number]
    angularVelocityBody: [number, number, number]
    linearAccelerationBody: [number, number, number]
    frame: 'body'; includesGravity: boolean; source: string
  }
  joints: JointTelemetry[]
  feet: FootTelemetry[]
  collision: CollisionTelemetry
  command: MotionCommandStatus
  locomotion: LocomotionTelemetry
  performance: PerformanceTelemetry
}
export interface ModelMetadata {
  modelId: string
  environmentId: EnvironmentId
  environment: EnvironmentMetadata
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
  | { type: 'telemetry'; payload: RobotTelemetry }
  | { type: 'motion_command_changed'; payload: MotionCommandStatus }
  | { type: 'telemetry_config_changed'; payload: TelemetryConfig }
  | { type: 'collision'; payload: CollisionEvent }
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
  loadModel(modelId: SimulationModelId, environmentId?: EnvironmentId): Promise<ModelMetadata>
  listAvailableEnvironments(): Promise<EnvironmentMetadata[]>
  getCurrentEnvironment(): Promise<EnvironmentMetadata | null>
  getLatestCollisionState(): Promise<CollisionTelemetry | null>
  getLatestCollisionEvent(): Promise<CollisionEvent | null>
  startSimulation(): Promise<SimulationState>
  pauseSimulation(): Promise<SimulationState>
  stepSimulation(steps: number): Promise<RobotPose>
  resetSimulation(): Promise<SimulationState>
  stopSimulation(): Promise<SimulationState>
  setSpeed(speed: number): Promise<number>
  getLatestPose(): Promise<RobotPose | null>
  setMotionCommand(command: MotionCommand): Promise<MotionCommandStatus>
  clearMotionCommand(): Promise<MotionCommandStatus>
  setTelemetryRate(rateHz: number): Promise<TelemetryConfig>
  getLatestTelemetry(): Promise<RobotTelemetry | null>
  subscribe(listener: SimulationListener): Promise<SimulationSubscription>
}

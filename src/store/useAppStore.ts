import { create } from 'zustand'
import type {
  ControlMode, EnvironmentParams, RobotState, Scene, SensorSnapshot,
  SimulationStatus as DashboardSimulationStatus, TrainingMetrics, TrainingTask,
} from '../types'
import { services } from '../services'
import type {
  CollisionEvent, JointPose, ModelMetadata, MotionCommand, MotionCommandStatus, RobotPose, RobotTelemetry, SimulationEvent, SimulationProcessState,
  SimulationState, SimulationStatus, SimulationModelId,
} from '../services/simulation/types'
import { DEFAULT_SIMULATION_MODEL_ID } from '../services/simulation/types'
import type { Go2VisualMode } from '../features/gaussian-viewer/robot/go2VisualManifest'

export interface SimulationPoseSummary {
  sequence: number
  simulationTime: number
  rootPosition: [number, number, number]
  rootOrientation: [number, number, number, number]
  joints: JointPose[]
  updatedAt: number
}

export interface SimulationUiState {
  desktop: boolean
  selectedModelId: SimulationModelId
  processState: SimulationProcessState
  simulationState: SimulationState
  model: ModelMetadata | null
  speed: number
  lastError: string | null
  latestPose: SimulationPoseSummary | null
  latestTelemetry: RobotTelemetry | null
  latestMotionCommand: MotionCommandStatus | null
  latestCollisionEvent: CollisionEvent | null
  busy: boolean
  visualMode: Go2VisualMode | 'primitive-only'
  visualPhase: 'idle' | 'loading' | 'ready' | 'fallback'
  visualError: string | null
  followRobot: boolean
}

export interface SimulationActionResult { ok: boolean; error?: string }

interface AppState {
  scenes: Scene[]; activeSceneId: string; status: DashboardSimulationStatus; speed: number; activeSensor: string; elapsed: number
  robot: RobotState | null; sensor: SensorSnapshot | null; task: TrainingTask | null; metrics: TrainingMetrics[]
  simulation: SimulationUiState
  initialize: () => Promise<void>; selectScene: (id: string) => void; updateEnvironment: (key: keyof EnvironmentParams, value: number) => void
  setStatus: (status: DashboardSimulationStatus) => void; setSpeed: (speed: number) => void; setSensor: (sensor: string) => void; setControlMode: (mode: ControlMode) => void; tick: () => void; appendMetrics: () => void
  initializeSimulation: () => Promise<void>; refreshSimulation: () => Promise<void>
  startSimulation: () => Promise<SimulationActionResult>; pauseSimulation: () => Promise<SimulationActionResult>
  resumeSimulation: () => Promise<SimulationActionResult>; stepSimulation: () => Promise<SimulationActionResult>
  resetSimulation: () => Promise<SimulationActionResult>; stopSimulation: () => Promise<SimulationActionResult>
  setSimulationSpeed: (speed: number) => Promise<SimulationActionResult>; shutdownSimulation: () => Promise<void>
  selectSimulationModel: (modelId: SimulationModelId) => Promise<SimulationActionResult>
  setMotionCommand: (command: MotionCommand) => Promise<SimulationActionResult>
  clearMotionCommand: () => Promise<SimulationActionResult>
  setTelemetryRate: (rateHz: number) => Promise<SimulationActionResult>
  clearLatestCollisionEvent: () => void
  setFollowRobot: (enabled: boolean) => void
}

const INITIAL_SIMULATION: SimulationUiState = {
  desktop: services.simulation.desktop,
  selectedModelId: DEFAULT_SIMULATION_MODEL_ID,
  processState: services.simulation.desktop ? 'idle' : 'unavailable',
  simulationState: 'unloaded', model: null, speed: 1, lastError: null,
  latestPose: null, latestTelemetry: null, latestMotionCommand: null, latestCollisionEvent: null, busy: false,
  visualMode: 'official-mesh', visualPhase: 'idle', visualError: null,
  followRobot: true,
}

let eventCleanup: (() => void) | null = null
let telemetryCleanup: (() => void) | null = null
let poseTimer: number | null = null
let pendingPose: RobotPose | null = null
let lastPoseSummaryAt = 0

function safeSimulationError(error: unknown): string {
  if (error instanceof Error && (error.message.includes('桌面版') || error.message.includes('0.25'))) {
    return error.message
  }
  return '仿真操作失败，请检查桌面仿真服务后重试'
}

function statusPatch(status: SimulationStatus): Partial<SimulationUiState> {
  return {
    processState: status.state,
    simulationState: status.simulationState,
    model: status.model,
    speed: status.speed,
    lastError: status.error ? '仿真服务报告错误，请重试或重新启动仿真' : null,
    ...(status.model && ['unitree-go2-menagerie', 'minimal-quadruped-v1'].includes(status.model.modelId)
      ? { selectedModelId: status.model.modelId as SimulationModelId } : {}),
  }
}

function motionDisplayChanged(current: MotionCommandStatus | null, next: MotionCommandStatus): boolean {
  return !current
    || current.mode !== next.mode
    || current.forwardVelocity !== next.forwardVelocity
    || current.lateralVelocity !== next.lateralVelocity
    || current.yawRate !== next.yawRate
    || current.bodyHeight !== next.bodyHeight
    || current.timedOut !== next.timedOut
    || current.appliedByController !== next.appliedByController
    || current.bodyHeightApplied !== next.bodyHeightApplied
    || current.controllerAvailability !== next.controllerAvailability
}

// 页面组件只读写 store；完整 60Hz Pose 由 simulationService 直接转发给 Viewer。
export const useAppStore = create<AppState>((set, get) => {
  const runSimulationAction = async (
    operation: () => Promise<SimulationStatus>,
  ): Promise<SimulationActionResult> => {
    if (get().simulation.busy) return { ok: false, error: '仿真操作正在进行，请稍候' }
    set((state) => ({ simulation: { ...state.simulation, busy: true, lastError: null } }))
    try {
      ensureSimulationBridge()
      const status = await operation()
      set((state) => ({ simulation: { ...state.simulation, ...statusPatch(status), busy: false } }))
      return { ok: true }
    } catch (error: unknown) {
      const message = safeSimulationError(error)
      set((state) => ({ simulation: { ...state.simulation, busy: false, lastError: message } }))
      return { ok: false, error: message }
    }
  }

  return {
    scenes: [], activeSceneId: '', status: 'running', speed: 1, activeSensor: 'all', elapsed: 765,
    robot: null, sensor: null, task: null, metrics: [], simulation: INITIAL_SIMULATION,
    initialize: async () => {
      const [sceneResult, robotResult, sensorResult, taskResult, metricsResult] = await Promise.all([
        services.scene.list(), services.robot.getState(), services.sensor.getSnapshot(),
        services.training.getTask(), services.training.getMetrics(),
      ])
      set({ scenes: sceneResult.data, activeSceneId: sceneResult.data[0]?.id ?? '', robot: robotResult.data, sensor: sensorResult.data, task: taskResult.data, metrics: metricsResult.data })
    },
    selectScene: (id) => set({ activeSceneId: id }),
    updateEnvironment: (key, value) => set((state) => ({ scenes: state.scenes.map((scene) => scene.id === state.activeSceneId ? { ...scene, environment: { ...scene.environment, [key]: value } } : scene) })),
    setStatus: (status) => set({ status }), setSpeed: (speed) => set({ speed }), setSensor: (activeSensor) => set({ activeSensor }),
    setControlMode: (controlMode) => set((state) => ({ robot: state.robot ? { ...state.robot, controlMode } : null })),
    tick: () => set((state) => state.status === 'running' ? { elapsed: state.elapsed + state.speed } : {}),
    appendMetrics: () => set((state) => {
      if (state.status !== 'running' || !state.metrics.length) return {}
      const last = state.metrics[state.metrics.length - 1]
      const next: TrainingMetrics = { episode: last.episode + 5, reward: Math.min(300, last.reward + (Math.random() - .38) * 18), successRate: Math.min(98, Math.max(0, last.successRate + (Math.random() - .4) * 3)), policyLoss: Math.max(.005, last.policyLoss * (.97 + Math.random() * .03)), valueLoss: Math.max(.008, last.valueLoss * (.965 + Math.random() * .04)) }
      return { metrics: [...state.metrics.slice(-44), next] }
    }),
    initializeSimulation: async () => {
      ensureSimulationBridge()
      await get().refreshSimulation()
    },
    refreshSimulation: async () => {
      try {
        const status = await services.simulation.getStatus()
        set((state) => ({ simulation: { ...state.simulation, ...statusPatch(status) } }))
      } catch { /* Explicit actions surface sanitized errors. */ }
    },
    startSimulation: () => runSimulationAction(() => services.simulation.start()),
    pauseSimulation: () => runSimulationAction(() => services.simulation.pause()),
    resumeSimulation: () => runSimulationAction(() => services.simulation.resume()),
    stepSimulation: () => runSimulationAction(() => services.simulation.step()),
    resetSimulation: () => runSimulationAction(() => services.simulation.reset()),
    stopSimulation: () => runSimulationAction(() => services.simulation.stop()),
    setSimulationSpeed: (nextSpeed) => runSimulationAction(() => services.simulation.setSpeed(nextSpeed)),
    selectSimulationModel: (modelId) => runSimulationAction(() => services.simulation.selectModel(modelId)),
    setMotionCommand: async (command) => {
      if (get().simulation.busy) return { ok: false, error: '仿真操作正在进行，请稍候' }
      set((state) => ({ simulation: { ...state.simulation, busy: true, lastError: null } }))
      try {
        ensureSimulationBridge()
        const next = await services.simulation.setMotionCommand(command)
        set((state) => ({ simulation: { ...state.simulation, latestMotionCommand: next, busy: false } }))
        return { ok: true }
      } catch (error) {
        const message = safeSimulationError(error)
        set((state) => ({ simulation: { ...state.simulation, busy: false, lastError: message } }))
        return { ok: false, error: message }
      }
    },
    clearMotionCommand: async () => {
      if (get().simulation.busy) return { ok: false, error: '仿真操作正在进行，请稍候' }
      set((state) => ({ simulation: { ...state.simulation, busy: true, lastError: null } }))
      try {
        const next = await services.simulation.clearMotionCommand()
        set((state) => ({ simulation: { ...state.simulation, latestMotionCommand: next, busy: false } }))
        return { ok: true }
      } catch (error) {
        const message = safeSimulationError(error)
        set((state) => ({ simulation: { ...state.simulation, busy: false, lastError: message } }))
        return { ok: false, error: message }
      }
    },
    setTelemetryRate: async (rateHz) => {
      try { await services.simulation.setTelemetryRate(rateHz); return { ok: true } }
      catch (error) { return { ok: false, error: safeSimulationError(error) } }
    },
    clearLatestCollisionEvent: () => set((state) => ({ simulation: { ...state.simulation, latestCollisionEvent: null } })),
    setFollowRobot: (enabled) => set((state) => ({ simulation: { ...state.simulation, followRobot: enabled } })),
    shutdownSimulation: async () => {
      clearSimulationBridge()
      try {
        const status = await services.simulation.shutdown()
        set((state) => ({ simulation: { ...state.simulation, ...statusPatch(status), latestPose: null, latestTelemetry: null, latestMotionCommand: null, latestCollisionEvent: null, busy: false } }))
      } catch {
        set((state) => ({ simulation: { ...state.simulation, processState: 'failed', simulationState: 'unloaded', latestPose: null, latestTelemetry: null, latestMotionCommand: null, busy: false, lastError: '仿真服务清理失败，应用退出时将执行进程级清理' } }))
      }
    },
  }
})

function ensureSimulationBridge(): void {
  if (eventCleanup) return
  eventCleanup = services.simulation.onEvent(handleSimulationEvent)
  telemetryCleanup = services.simulation.subscribeTelemetry((telemetry) => {
    useAppStore.setState((state) => ({ simulation: {
      ...state.simulation,
      latestTelemetry: telemetry,
      latestMotionCommand: telemetry.command,
    } }))
  })
}

function clearSimulationBridge(): void {
  eventCleanup?.()
  eventCleanup = null
  telemetryCleanup?.()
  telemetryCleanup = null
  pendingPose = null
  if (poseTimer !== null) globalThis.clearTimeout(poseTimer)
  poseTimer = null
  lastPoseSummaryAt = 0
}

function handleSimulationEvent(event: SimulationEvent): void {
  if (event.type === 'pose') {
    pendingPose = event.payload
    const elapsed = performance.now() - lastPoseSummaryAt
    if (elapsed >= 100) flushPoseSummary()
    else if (poseTimer === null) poseTimer = globalThis.setTimeout(flushPoseSummary, 100 - elapsed)
    return
  }
  if (event.type === 'model_loaded') {
    useAppStore.setState((state) => ({ simulation: { ...state.simulation, selectedModelId: event.payload.modelId as SimulationModelId, model: event.payload, latestPose: null, latestTelemetry: null, latestMotionCommand: null, latestCollisionEvent: null } }))
  } else if (event.type === 'state_changed') {
    useAppStore.setState((state) => ({ simulation: {
      ...state.simulation,
      simulationState: event.payload.state,
      speed: event.payload.speed ?? state.simulation.speed,
    } }))
  } else if (event.type === 'error') {
    useAppStore.setState((state) => ({ simulation: { ...state.simulation, lastError: '仿真服务报告错误，请重试或重新启动仿真' } }))
  } else if (event.type === 'motion_command_changed') {
    const current = useAppStore.getState().simulation.latestMotionCommand
    if (motionDisplayChanged(current, event.payload)) {
      useAppStore.setState((state) => ({ simulation: { ...state.simulation, latestMotionCommand: event.payload } }))
    }
  } else if (event.type === 'collision') {
    useAppStore.setState((state) => ({ simulation: { ...state.simulation, latestCollisionEvent: event.payload } }))
  }
}

function flushPoseSummary(): void {
  poseTimer = null
  const pose = pendingPose
  pendingPose = null
  if (!pose) return
  lastPoseSummaryAt = performance.now()
  useAppStore.setState((state) => ({ simulation: {
    ...state.simulation,
    latestPose: {
      sequence: pose.sequence,
      simulationTime: pose.simulationTime,
      rootPosition: [...pose.rootPosition],
      rootOrientation: [...pose.rootOrientation],
      joints: pose.joints.map((joint) => ({ ...joint })),
      updatedAt: pose.wallTime,
    },
  } }))
}

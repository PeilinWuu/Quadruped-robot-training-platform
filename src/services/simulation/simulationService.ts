import { browserSimulationAdapter } from './browserSimulationAdapter'
import type {
  MotionCommand,
  MotionCommandStatus,
  RobotPose,
  RobotTelemetry,
  ModelMetadata,
  SimulationAdapter,
  SimulationEvent,
  SimulationListener,
  SimulationStatus,
  SimulationSubscription,
  SimulationModelDescription,
  SimulationModelId,
  TelemetryConfig,
  CollisionEvent,
  CollisionTelemetry,
  EnvironmentMetadata,
} from './types'
import { DEFAULT_SIMULATION_MODEL_ID, SIMULATION_MODELS } from './types'
import { RobotTelemetryBuffer, type TelemetryListener } from './RobotTelemetryBuffer'

let adapterPromise: Promise<SimulationAdapter> | null = null

export function simulationDesktopSupported(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
export function getSimulationAdapter(): Promise<SimulationAdapter> {
  if (!adapterPromise) {
    adapterPromise = simulationDesktopSupported()
      ? import('./tauriSimulationAdapter').then(({ tauriSimulationAdapter }) => tauriSimulationAdapter)
      : Promise.resolve(browserSimulationAdapter)
  }
  return adapterPromise
}

type AdapterLoader = () => Promise<SimulationAdapter>
type PoseListener = (pose: RobotPose) => void
type CollisionListener = (event: CollisionEvent) => void
type MotionWaiter = {
  resolve: (status: MotionCommandStatus) => void
  reject: (error: unknown) => void
}
type DesiredMotionOperation = {
  command: MotionCommand | null
  waiters: MotionWaiter[]
}

export interface MotionDispatchDiagnostics {
  requested: number
  dispatched: number
  completed: number
  coalesced: number
  inFlight: number
  maxInFlight: number
  lastInvokeLatencyMs: number
}

export class ManagedSimulationService {
  private readonly loadAdapter: AdapterLoader
  private adapter: SimulationAdapter | null = null
  private subscription: SimulationSubscription | null = null
  private subscriptionPromise: Promise<void> | null = null
  private latestPose: RobotPose | null = null
  private readonly telemetry = new RobotTelemetryBuffer()
  private selectedModelId: SimulationModelId = DEFAULT_SIMULATION_MODEL_ID
  private readonly poseListeners = new Set<PoseListener>()
  private readonly eventListeners = new Set<SimulationListener>()
  private readonly collisionListeners = new Set<CollisionListener>()
  private queue: Promise<void> = Promise.resolve()
  private desiredMotion: DesiredMotionOperation | null = null
  private motionInFlight = false
  private readonly motionDiagnostics: MotionDispatchDiagnostics = {
    requested: 0, dispatched: 0, completed: 0, coalesced: 0,
    inFlight: 0, maxInFlight: 0, lastInvokeLatencyMs: 0,
  }

  constructor(loadAdapter: AdapterLoader = getSimulationAdapter) {
    this.loadAdapter = loadAdapter
  }

  get desktop(): boolean { return simulationDesktopSupported() }
  getBufferedPose(): RobotPose | null { return this.latestPose }
  getBufferedTelemetry(): RobotTelemetry | null { return this.telemetry.getLatest() }
  getMotionDispatchDiagnostics(): MotionDispatchDiagnostics { return { ...this.motionDiagnostics } }
  listAvailableModels(): readonly SimulationModelDescription[] { return SIMULATION_MODELS }
  listAvailableEnvironments(): Promise<EnvironmentMetadata[]> { return this.withAdapter((adapter) => adapter.listAvailableEnvironments()) }
  getCurrentEnvironment(): Promise<EnvironmentMetadata | null> { return this.withAdapter((adapter) => adapter.getCurrentEnvironment()) }
  getLatestCollisionState(): Promise<CollisionTelemetry | null> { return this.withAdapter((adapter) => adapter.getLatestCollisionState()) }
  getLatestCollisionEvent(): Promise<CollisionEvent | null> { return this.withAdapter((adapter) => adapter.getLatestCollisionEvent()) }
  getSelectedModel(): SimulationModelDescription {
    return SIMULATION_MODELS.find((model) => model.id === this.selectedModelId)!
  }
  selectModel(modelId: SimulationModelId): Promise<SimulationStatus> {
    if (!SIMULATION_MODELS.some((model) => model.id === modelId)) return Promise.reject(new Error('不支持的仿真模型'))
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      const status = await adapter.getStatus()
      if (status.simulationState === 'running') throw new Error('仿真运行中不能切换模型，请先停止')
      this.selectedModelId = modelId
      this.latestPose = null
      this.telemetry.clear()
      if (status.state !== 'ready') return status
      if (!['unloaded', 'stopped'].includes(status.simulationState)) await adapter.stopSimulation()
      await adapter.loadModel(modelId, 'flat-ground-v1')
      return adapter.getStatus()
    })
  }
  loadSelectedModel(): Promise<ModelMetadata> {
    return this.withAdapter(async (adapter) => {
      this.latestPose = null
      return adapter.loadModel(this.selectedModelId, 'flat-ground-v1')
    })
  }
  onPose(listener: PoseListener): () => void {
    this.poseListeners.add(listener)
    return () => this.poseListeners.delete(listener)
  }
  onEvent(listener: SimulationListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }
  subscribeCollisionEvents(listener: CollisionListener): () => void {
    this.collisionListeners.add(listener)
    return () => this.collisionListeners.delete(listener)
  }
  subscribeTelemetry(listener: TelemetryListener): () => void {
    return this.telemetry.subscribe(listener)
  }

  setMotionCommand(command: MotionCommand): Promise<MotionCommandStatus> {
    return this.enqueueMotion(command)
  }
  clearMotionCommand(): Promise<MotionCommandStatus> {
    return this.enqueueMotion(null)
  }
  setTelemetryRate(rateHz: number): Promise<TelemetryConfig> {
    if (!Number.isInteger(rateHz) || rateHz < 10 || rateHz > 100) {
      return Promise.reject(new Error('遥测频率必须为 10～100 Hz 的整数'))
    }
    return this.serial(async () => (await this.adapterForUse()).setTelemetryRate(rateHz))
  }
  getLatestTelemetry(): Promise<RobotTelemetry | null> {
    return this.withAdapter((adapter) => adapter.getLatestTelemetry())
  }

  getStatus(): Promise<SimulationStatus> {
    return this.withAdapter((adapter) => adapter.getStatus())
  }

  start(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      let status = await adapter.getStatus()
      if (status.state !== 'ready') status = await adapter.startSidecar()
      if (status.model?.modelId !== this.selectedModelId) {
        if (!['unloaded', 'stopped'].includes(status.simulationState)) await adapter.stopSimulation()
        await adapter.loadModel(this.selectedModelId, 'flat-ground-v1')
        status = await adapter.getStatus()
      }
      await this.ensureSubscription(adapter)
      if (status.simulationState !== 'running') await adapter.startSimulation()
      return adapter.getStatus()
    })
  }

  pause(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      const status = await adapter.getStatus()
      if (status.simulationState === 'running') await adapter.pauseSimulation()
      return adapter.getStatus()
    })
  }

  resume(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      const status = await adapter.getStatus()
      if (status.simulationState !== 'running') await adapter.startSimulation()
      return adapter.getStatus()
    })
  }

  step(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      const status = await adapter.getStatus()
      if (status.simulationState === 'running') await adapter.pauseSimulation()
      const pose = await adapter.stepSimulation(1)
      this.dispatch({ type: 'pose', payload: pose })
      return adapter.getStatus()
    })
  }

  reset(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      const before = await adapter.getStatus()
      const resumeAfterReset = before.simulationState === 'running'
      this.telemetry.clear()
      if (resumeAfterReset) await adapter.pauseSimulation()
      await adapter.resetSimulation()
      const pose = await adapter.getLatestPose()
      if (pose) this.dispatch({ type: 'pose', payload: pose })
      if (resumeAfterReset) await adapter.startSimulation()
      return adapter.getStatus()
    })
  }

  stop(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      const status = await adapter.getStatus()
      if (!['unloaded', 'stopped'].includes(status.simulationState)) {
        await adapter.stopSimulation()
      }
      return adapter.getStatus()
    })
  }

  setSpeed(speed: number): Promise<SimulationStatus> {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      return Promise.reject(new Error('仿真倍速必须在 0.25～4.0 之间'))
    }
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      await adapter.setSpeed(speed)
      return adapter.getStatus()
    })
  }

  shutdown(): Promise<SimulationStatus> {
    return this.serial(async () => {
      await this.disposeSubscription()
      const adapter = await this.adapterForUse()
      let status = await adapter.getStatus()
      if (!['idle', 'unavailable'].includes(status.state)) status = await adapter.stopSidecar()
      this.latestPose = null
      this.telemetry.clear()
      return status
    })
  }

  private async adapterForUse(): Promise<SimulationAdapter> {
    this.adapter ??= await this.loadAdapter()
    return this.adapter
  }
  private withAdapter<T>(operation: (adapter: SimulationAdapter) => Promise<T>): Promise<T> {
    return this.adapterForUse().then(operation)
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private enqueueMotion(command: MotionCommand | null): Promise<MotionCommandStatus> {
    this.motionDiagnostics.requested += 1
    return new Promise((resolve, reject) => {
      const waiters = this.desiredMotion?.waiters ?? []
      if (this.desiredMotion) this.motionDiagnostics.coalesced += 1
      waiters.push({ resolve, reject })
      this.desiredMotion = { command, waiters }
      this.drainMotion()
    })
  }
  private drainMotion(): void {
    if (this.motionInFlight || !this.desiredMotion) return
    const desired = this.desiredMotion
    this.desiredMotion = null
    this.motionInFlight = true
    this.motionDiagnostics.dispatched += 1
    this.motionDiagnostics.inFlight = 1
    this.motionDiagnostics.maxInFlight = Math.max(this.motionDiagnostics.maxInFlight, 1)
    const startedAt = performance.now()
    void this.adapterForUse()
      .then((adapter) => desired.command
        ? adapter.setMotionCommand(desired.command)
        : adapter.clearMotionCommand())
      .then(
        (status) => {
          this.motionDiagnostics.completed += 1
          desired.waiters.forEach((waiter) => waiter.resolve(status))
        },
        (error) => desired.waiters.forEach((waiter) => waiter.reject(error)),
      )
      .finally(() => {
        this.motionDiagnostics.lastInvokeLatencyMs = performance.now() - startedAt
        this.motionDiagnostics.inFlight = 0
        this.motionInFlight = false
        this.drainMotion()
      })
  }
  private async ensureSubscription(adapter: SimulationAdapter): Promise<void> {
    if (this.subscription) return
    if (!this.subscriptionPromise) {
      this.subscriptionPromise = adapter.subscribe((event) => this.dispatch(event))
        .then((subscription) => { this.subscription = subscription })
        .finally(() => { this.subscriptionPromise = null })
    }
    await this.subscriptionPromise
  }
  private dispatch(event: SimulationEvent): void {
    if (event.type === 'telemetry') {
      if (event.payload.modelId !== this.selectedModelId) return
      this.telemetry.update(event.payload)
      return
    }
    if (event.type === 'pose') {
      const expected = this.selectedModelId === 'unitree-go2-menagerie' ? ['FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint'] : ['front_left_hip_abduction', 'front_left_hip_flexion', 'front_left_knee', 'front_right_hip_abduction', 'front_right_hip_flexion', 'front_right_knee', 'rear_left_hip_abduction', 'rear_left_hip_flexion', 'rear_left_knee', 'rear_right_hip_abduction', 'rear_right_hip_flexion', 'rear_right_knee']
      if (event.payload.joints.length !== expected.length || event.payload.joints.some((joint, index) => joint.name !== expected[index])) return
      this.latestPose = event.payload
      for (const listener of this.poseListeners) {
        try { listener(event.payload) } catch { /* Render listeners are isolated. */ }
      }
    }
    if (event.type === 'model_loaded') this.telemetry.clear()
    if (event.type === 'collision') {
      for (const listener of this.collisionListeners) {
        try { listener(event.payload) } catch { /* Collision listeners are isolated. */ }
      }
    }
    for (const listener of this.eventListeners) {
      try { listener(event) } catch { /* UI listeners cannot interrupt delivery. */ }
    }
  }
  private async disposeSubscription(): Promise<void> {
    if (this.subscriptionPromise) await this.subscriptionPromise.catch(() => undefined)
    const subscription = this.subscription
    this.subscription = null
    await subscription?.unsubscribe()
    this.telemetry.clear()
    this.collisionListeners.clear()
  }
}

export const simulationService = new ManagedSimulationService()

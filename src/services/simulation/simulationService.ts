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
  private queue: Promise<void> = Promise.resolve()

  constructor(loadAdapter: AdapterLoader = getSimulationAdapter) {
    this.loadAdapter = loadAdapter
  }

  get desktop(): boolean { return simulationDesktopSupported() }
  getBufferedPose(): RobotPose | null { return this.latestPose }
  getBufferedTelemetry(): RobotTelemetry | null { return this.telemetry.getLatest() }
  listAvailableModels(): readonly SimulationModelDescription[] { return SIMULATION_MODELS }
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
      await adapter.loadModel(modelId)
      return adapter.getStatus()
    })
  }
  loadSelectedModel(): Promise<ModelMetadata> {
    return this.withAdapter(async (adapter) => {
      this.latestPose = null
      return adapter.loadModel(this.selectedModelId)
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
  subscribeTelemetry(listener: TelemetryListener): () => void {
    return this.telemetry.subscribe(listener)
  }

  setMotionCommand(command: MotionCommand): Promise<MotionCommandStatus> {
    return this.serial(async () => (await this.adapterForUse()).setMotionCommand(command))
  }
  clearMotionCommand(): Promise<MotionCommandStatus> {
    return this.serial(async () => (await this.adapterForUse()).clearMotionCommand())
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
        await adapter.loadModel(this.selectedModelId)
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
      this.telemetry.clear()
      await adapter.resetSimulation()
      const pose = await adapter.getLatestPose()
      if (pose) this.dispatch({ type: 'pose', payload: pose })
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
  }
}

export const simulationService = new ManagedSimulationService()

import { browserSimulationAdapter } from './browserSimulationAdapter'
import type {
  RobotPose,
  SimulationAdapter,
  SimulationEvent,
  SimulationListener,
  SimulationStatus,
  SimulationSubscription,
} from './types'

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
  private readonly poseListeners = new Set<PoseListener>()
  private readonly eventListeners = new Set<SimulationListener>()
  private queue: Promise<void> = Promise.resolve()

  constructor(loadAdapter: AdapterLoader = getSimulationAdapter) {
    this.loadAdapter = loadAdapter
  }

  get desktop(): boolean { return simulationDesktopSupported() }
  getBufferedPose(): RobotPose | null { return this.latestPose }
  onPose(listener: PoseListener): () => void {
    this.poseListeners.add(listener)
    return () => this.poseListeners.delete(listener)
  }
  onEvent(listener: SimulationListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  getStatus(): Promise<SimulationStatus> {
    return this.withAdapter((adapter) => adapter.getStatus())
  }

  start(): Promise<SimulationStatus> {
    return this.serial(async () => {
      const adapter = await this.adapterForUse()
      let status = await adapter.getStatus()
      if (status.state !== 'ready') status = await adapter.startSidecar()
      if (!status.model) {
        await adapter.loadDefaultModel()
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
    if (event.type === 'pose') {
      this.latestPose = event.payload
      for (const listener of this.poseListeners) {
        try { listener(event.payload) } catch { /* Render listeners are isolated. */ }
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
  }
}

export const simulationService = new ManagedSimulationService()

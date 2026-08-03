import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  ModelMetadata, MotionCommand, MotionCommandStatus, RobotPose, RobotTelemetry,
  SimulationAdapter, SimulationEvent, TelemetryConfig,
  SimulationListener, SimulationState, SimulationSubscription,
} from './types'

let fallbackId = 0

function subscriptionId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `simulation-${Date.now().toString(36)}-${(++fallbackId).toString(36)}`
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args)
}

export const tauriSimulationAdapter: SimulationAdapter = {
  desktop: true,
  startSidecar: () => command('simulation_sidecar_start'),
  getStatus: () => command('simulation_sidecar_status'),
  ping: () => command('simulation_sidecar_ping'),
  stopSidecar: () => command('simulation_sidecar_stop'),
  loadModel: (modelId) => command<ModelMetadata>('simulation_load_model', { modelId }),
  startSimulation: () => command<SimulationState>('simulation_run_start'),
  pauseSimulation: () => command<SimulationState>('simulation_run_pause'),
  stepSimulation: (steps: number) => command<RobotPose>('simulation_run_step', { steps }),
  resetSimulation: () => command<SimulationState>('simulation_run_reset'),
  stopSimulation: () => command<SimulationState>('simulation_run_stop'),
  setSpeed: (speed: number) => command<number>('simulation_set_speed', { speed }),
  getLatestPose: () => command<RobotPose | null>('simulation_latest_pose'),
  setMotionCommand: (motion: MotionCommand) => command<MotionCommandStatus>('simulation_set_motion_command', { command: motion }),
  clearMotionCommand: () => command<MotionCommandStatus>('simulation_clear_motion_command'),
  setTelemetryRate: (rateHz: number) => command<TelemetryConfig>('simulation_set_telemetry_rate', { rateHz }),
  getLatestTelemetry: () => command<RobotTelemetry | null>('simulation_latest_telemetry'),
  subscribe: async (listener: SimulationListener): Promise<SimulationSubscription> => {
    const id = subscriptionId()
    const channel = new Channel<SimulationEvent>()
    let active = true
    channel.onmessage = (event) => {
      if (!active) return
      try { listener(event) } catch { /* A UI listener cannot break Channel delivery. */ }
    }
    await command<void>('simulation_subscribe', { subscriptionId: id, channel })
    return {
      unsubscribe: async () => {
        if (!active) return
        active = false
        channel.onmessage = () => undefined
        await command<void>('simulation_unsubscribe', { subscriptionId: id })
      },
    }
  },
}

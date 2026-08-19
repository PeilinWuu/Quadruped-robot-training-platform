import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type ControlSource = 'manual' | 'ros'
export type RosBridgeState = 'unavailable' | 'ready' | 'running' | 'fault'

export interface RosBridgeStatus {
  state: RosBridgeState
  available: boolean
  controlSource: ControlSource
  bridgeVersion: string | null
  lastCmdVelAgeMs: number | null
  watchdogState: 'idle' | 'armed' | 'triggered'
  error: string | null
}

export const UNAVAILABLE_ROS_BRIDGE: RosBridgeStatus = {
  state: 'unavailable',
  available: false,
  controlSource: 'manual',
  bridgeVersion: null,
  lastCmdVelAgeMs: null,
  watchdogState: 'idle',
  error: null,
}

function desktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// D6_ROS_PERF_DIAGNOSTIC: development-only counters; disabled unless localStorage is explicitly set.
const diagnostic = {
  startedAt: typeof performance === 'undefined' ? 0 : performance.now(),
  activeListeners: 0,
  maxActiveListeners: 0,
  events: 0,
  stateUpdates: 0,
  renders: 0,
}

function diagnosticEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false
  if (import.meta.env.VITE_D6_ROS_PERF_DIAGNOSTIC === '1') return true
  try { return window.localStorage.getItem('D6_ROS_PERF_DIAGNOSTIC') === '1' } catch { return false }
}

export const rosPerfDiagnostic = {
  enabled: diagnosticEnabled,
  recordStateUpdate: () => { if (diagnosticEnabled()) diagnostic.stateUpdates += 1 },
  recordRender: () => { if (diagnosticEnabled()) diagnostic.renders += 1 },
  snapshot: () => ({ ...diagnostic }),
}

export const rosBridgeService = {
  status: async (): Promise<RosBridgeStatus> => desktop()
    ? invoke<RosBridgeStatus>('ros_bridge_status')
    : UNAVAILABLE_ROS_BRIDGE,
  setControlSource: (source: ControlSource): Promise<RosBridgeStatus> =>
    invoke<RosBridgeStatus>('ros_bridge_set_control_source', { source }),
  subscribe: async (listener: (status: RosBridgeStatus) => void): Promise<UnlistenFn> => {
    if (!desktop()) return () => undefined
    const cleanup = await listen<RosBridgeStatus>('ros-bridge-status-changed', (event) => {
      if (diagnosticEnabled()) diagnostic.events += 1
      listener(event.payload)
    })
    if (!diagnosticEnabled()) return cleanup
    diagnostic.activeListeners += 1
    diagnostic.maxActiveListeners = Math.max(diagnostic.maxActiveListeners, diagnostic.activeListeners)
    let active = true
    return () => {
      if (!active) return
      active = false
      cleanup()
      diagnostic.activeListeners = Math.max(0, diagnostic.activeListeners - 1)
    }
  },
}

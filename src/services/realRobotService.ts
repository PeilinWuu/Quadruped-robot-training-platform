import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type RealRobotState = 'unavailable' | 'starting' | 'ready' | 'running' | 'fault'
export interface RealRobotStatus {
  state: RealRobotState; available: boolean; live: boolean; controlEnabled: boolean
  activeMove: boolean; gatewayVersion: string | null; lastAction: string | null
  robotOnline: boolean; telemetryAgeMs: number | null; telemetry: RealRobotTelemetry | null; error: string | null
}
export interface RealRobotTelemetry {
  lowState: null | { tick: number; batterySoc: number; powerVoltage: number; powerCurrent: number; rpy: number[]; gyroscope: number[]; accelerometer: number[]; footForce: number[]; joints: Array<{ position: number; velocity: number; torque: number; temperature: number }> }
  sportModeState: null | { errorCode: number; mode: number; gaitType: number; position: number[]; velocity: number[]; bodyHeight: number; yawSpeed: number }
}
export interface RealMoveCommand { forwardVelocity: number; lateralVelocity: number; yawRate: number; durationMs: number }
export type RealKeyboardMotionCommand = Omit<RealMoveCommand, 'durationMs'>
export const UNAVAILABLE_REAL_ROBOT: RealRobotStatus = {
  state: 'unavailable', available: false, live: false, controlEnabled: false,
  activeMove: false, gatewayVersion: null, lastAction: null, robotOnline: false,
  telemetryAgeMs: null, telemetry: null, error: null,
}
const desktop = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const realRobotService = {
  status: (): Promise<RealRobotStatus> => desktop() ? invoke<RealRobotStatus>('real_robot_status') : Promise.resolve(UNAVAILABLE_REAL_ROBOT),
  setEnabled: (enabled: boolean): Promise<RealRobotStatus> => invoke('real_robot_set_enabled', { enabled }),
  moveOnce: (command: RealMoveCommand): Promise<RealRobotStatus> => invoke('real_robot_move_once', { command }),
  keyboardMotion: (command: RealKeyboardMotionCommand): Promise<RealRobotStatus> => invoke('real_robot_keyboard_motion', { command }),
  stop: (): Promise<RealRobotStatus> => invoke('real_robot_stop'),
  standUp: (): Promise<RealRobotStatus> => invoke('real_robot_stand_up'),
  standDown: (): Promise<RealRobotStatus> => invoke('real_robot_stand_down'),
  setLidar: (enabled: boolean): Promise<RealRobotStatus> => invoke('real_robot_lidar', { enabled }),
  subscribe: async (listener: (status: RealRobotStatus) => void): Promise<UnlistenFn> => {
    if (!desktop()) return () => undefined
    return listen<RealRobotStatus>('real-robot-status-changed', (event) => listener(event.payload))
  },
}

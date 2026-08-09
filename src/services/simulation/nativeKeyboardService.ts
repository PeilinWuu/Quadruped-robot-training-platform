import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DemoSpeed, KeyboardLocomotionState } from './KeyboardLocomotionController'

export interface NativeKeyboardCapabilities {
  realtimeInputMode: 'native' | 'javascript'
  heartbeatPeriodMs: number
}

export interface NativeKeyboardState {
  native: boolean
  armed: boolean
  suppressInput: boolean
  windowFocused: boolean
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  resetting: boolean
  speed: DemoSpeed
  generation: number
  forwardVelocity: number
  yawRate: number
}

export interface NativeKeyboardDiagnostics {
  keyEvents: number
  desiredUpdates: number
  heartbeatSends: number
  heartbeatCompletions: number
  coalescedUpdates: number
  inFlight: number
  maxInFlight: number
  lastKeyPressed: boolean
  lastKeyEventUnixMicros: number
  lastDesiredStateUnixMicros: number
  lastHeartbeatSendUnixMicros: number
  lastSendLatencyMicros: number
  lastSidecarCommandAgeMs: number
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args)
}

export function keyboardUiState(state: NativeKeyboardState): KeyboardLocomotionState {
  const stopReason = state.resetting
    ? '正在重置机器人'
    : !state.armed
      ? '键盘控制默认未启用'
      : !state.windowFocused
        ? '窗口失焦，native 已自动停止'
        : state.suppressInput
          ? '输入控件聚焦，native 运动已抑制'
          : null
  return {
    enabled: state.armed,
    resetting: state.resetting,
    stopReason,
    speed: state.speed,
    forwardVelocity: state.forwardVelocity,
    yawRate: state.yawRate,
  }
}

export const shouldAutoDisarmKeyboard = (
  locomotionAllowed: boolean,
  nativeMode: boolean,
  resetting: boolean,
) => !locomotionAllowed && !(nativeMode && resetting)

export function editableElement(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
}

export const nativeKeyboardService = {
  capabilities: async (): Promise<NativeKeyboardCapabilities> => {
    try {
      return await command<NativeKeyboardCapabilities>('native_keyboard_capabilities')
    } catch {
      return { realtimeInputMode: 'javascript', heartbeatPeriodMs: 50 }
    }
  },
  state: () => command<NativeKeyboardState>('native_keyboard_state'),
  diagnostics: () => command<NativeKeyboardDiagnostics>('native_keyboard_diagnostics'),
  arm: () => command<NativeKeyboardState>('native_keyboard_arm'),
  disarm: () => command<NativeKeyboardState>('native_keyboard_disarm'),
  setSpeed: (speed: DemoSpeed) => command<NativeKeyboardState>('native_keyboard_set_speed', { speed }),
  setInputSuppressed: (suppressed: boolean) => command<NativeKeyboardState>('native_keyboard_set_input_suppressed', { suppressed }),
  subscribe: (listener: (state: NativeKeyboardState) => void): Promise<UnlistenFn> =>
    listen<NativeKeyboardState>('native-keyboard-state-changed', (event) => listener(event.payload)),
}

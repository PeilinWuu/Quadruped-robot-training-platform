export type KeyboardControlMode = 'simulation' | 'real'
export const KEYBOARD_CONTROL_MODE_EVENT = 'quadruped-keyboard-control-mode'

export function announceKeyboardControlMode(mode: KeyboardControlMode): void {
  window.dispatchEvent(new CustomEvent<KeyboardControlMode>(KEYBOARD_CONTROL_MODE_EVENT, { detail: mode }))
}

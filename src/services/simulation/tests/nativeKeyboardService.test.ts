// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))

import { editableElement, keyboardUiState, nativeKeyboardService, shouldAutoDisarmKeyboard, type NativeKeyboardState } from '../nativeKeyboardService'

const state: NativeKeyboardState = {
  native: true,
  armed: true,
  suppressInput: false,
  windowFocused: true,
  forward: true,
  backward: false,
  left: false,
  right: false,
  resetting: false,
  speed: 'low',
  generation: 2,
  forwardVelocity: 0.12,
  yawRate: 0,
}

describe('native keyboard frontend bridge', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
  })

  it('uses backend capability instead of a user-agent guess', async () => {
    mocks.invoke.mockResolvedValue({ realtimeInputMode: 'native', heartbeatPeriodMs: 50 })
    await expect(nativeKeyboardService.capabilities()).resolves.toEqual({ realtimeInputMode: 'native', heartbeatPeriodMs: 50 })
    expect(mocks.invoke).toHaveBeenCalledWith('native_keyboard_capabilities', undefined)
  })

  it('falls back to the existing JavaScript path outside Tauri', async () => {
    mocks.invoke.mockRejectedValue(new Error('not desktop'))
    await expect(nativeKeyboardService.capabilities()).resolves.toEqual({ realtimeInputMode: 'javascript', heartbeatPeriodMs: 50 })
  })

  it('arm, disarm and speed are state-change commands rather than heartbeat invokes', async () => {
    mocks.invoke.mockResolvedValue(state)
    await nativeKeyboardService.arm()
    await nativeKeyboardService.disarm()
    await nativeKeyboardService.setSpeed('medium')
    expect(mocks.invoke.mock.calls).toEqual([
      ['native_keyboard_arm', undefined],
      ['native_keyboard_disarm', undefined],
      ['native_keyboard_set_speed', { speed: 'medium' }],
    ])
  })

  it('editable suppression only sends focus transition state', async () => {
    mocks.invoke.mockResolvedValue(state)
    await nativeKeyboardService.setInputSuppressed(true)
    await nativeKeyboardService.setInputSuppressed(false)
    expect(mocks.invoke.mock.calls).toEqual([
      ['native_keyboard_set_input_suppressed', { suppressed: true }],
      ['native_keyboard_set_input_suppressed', { suppressed: false }],
    ])
  })

  it('maps native state changes into the existing keyboard UI observer', () => {
    expect(keyboardUiState(state)).toMatchObject({ enabled: true, resetting: false, forwardVelocity: 0.12, yawRate: 0, speed: 'low' })
    expect(keyboardUiState({ ...state, resetting: true })).toMatchObject({ enabled: true, resetting: true, stopReason: '正在重置机器人' })
    expect(keyboardUiState({ ...state, windowFocused: false })).toMatchObject({ enabled: true, forwardVelocity: 0.12, stopReason: '窗口失焦，native 已自动停止' })
  })

  it('keeps native keyboard armed only during the transient R reset states', () => {
    expect(shouldAutoDisarmKeyboard(false, true, true)).toBe(false)
    expect(shouldAutoDisarmKeyboard(false, true, false)).toBe(true)
    expect(shouldAutoDisarmKeyboard(false, false, true)).toBe(true)
  })

  it('protects input, textarea, select and contenteditable descendants', () => {
    const root = document.createElement('div')
    root.innerHTML = '<input><textarea></textarea><select></select><div contenteditable="true"><span></span></div><button></button>'
    expect(editableElement(root.querySelector('input'))).toBe(true)
    expect(editableElement(root.querySelector('textarea'))).toBe(true)
    expect(editableElement(root.querySelector('select'))).toBe(true)
    expect(editableElement(root.querySelector('span'))).toBe(true)
    expect(editableElement(root.querySelector('button'))).toBe(false)
  })

  it('observes native key state only on change events', async () => {
    const listener = vi.fn()
    mocks.listen.mockImplementation(async (_name, callback) => {
      callback({ payload: state })
      return vi.fn()
    })
    await nativeKeyboardService.subscribe(listener)
    expect(mocks.listen).toHaveBeenCalledWith('native-keyboard-state-changed', expect.any(Function))
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(state)
  })
})

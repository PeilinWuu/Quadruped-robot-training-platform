// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyboardLocomotionController } from '../KeyboardLocomotionController'
import type { MotionCommand } from '../types'

describe('KeyboardLocomotionController', () => {
  const commands: MotionCommand[] = []
  const clear = vi.fn(async () => undefined)
  const reset = vi.fn(async () => undefined)
  beforeEach(() => { vi.useFakeTimers(); commands.length = 0; clear.mockClear(); reset.mockClear() })
  afterEach(() => vi.useRealTimers())
  const make = () => new KeyboardLocomotionController({
    setMotionCommand: vi.fn(async (command) => { commands.push(command) }), clearMotionCommand: clear, reset,
  })
  const key = (type: 'keydown' | 'keyup', code: string, target: EventTarget = window, repeat = false) => {
    const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, repeat })
    target.dispatchEvent(event); return event
  }

  it('is opt-in and sends a 20 Hz bounded heartbeat only after enable', async () => {
    const controller = make(); key('keydown', 'KeyW'); expect(commands).toHaveLength(0)
    controller.enable(); await vi.advanceTimersByTimeAsync(100)
    expect(commands.length).toBeGreaterThanOrEqual(3)
    expect(commands.at(-1)).toMatchObject({ mode: 'locomotion', forwardVelocity: 0, lateralVelocity: 0, validForMs: 250 })
    key('keydown', 'KeyW'); await vi.runAllTicks(); expect(commands.at(-1)?.forwardVelocity).toBe(.12)
    controller.dispose()
  })

  it('maps combinations and conflicting keys deterministically', async () => {
    const controller = make(); controller.enable(); key('keydown', 'KeyW'); key('keydown', 'KeyA')
    await vi.runAllTicks(); expect(commands.at(-1)).toMatchObject({ forwardVelocity: .08, yawRate: .15 })
    key('keydown', 'KeyS'); key('keydown', 'KeyD'); await vi.runAllTicks()
    expect(commands.at(-1)).toMatchObject({ forwardVelocity: 0, yawRate: 0 })
    controller.setSpeed('medium'); key('keyup', 'KeyS'); key('keyup', 'KeyD'); await vi.runAllTicks()
    expect(commands.at(-1)).toMatchObject({ forwardVelocity: .08, yawRate: .15 })
    key('keyup', 'KeyW'); key('keyup', 'KeyA'); key('keydown', 'KeyS'); key('keydown', 'KeyD')
    await vi.runAllTicks(); expect(commands.at(-1)).toMatchObject({ forwardVelocity: -.08, yawRate: -.15 })
    controller.dispose()
  })

  it('protects editable controls and handles Space, R, Escape and blur', async () => {
    const controller = make(); controller.enable()
    const input = document.createElement('input'); document.body.append(input)
    key('keydown', 'KeyW', input); await vi.runAllTicks(); expect(commands.at(-1)?.forwardVelocity).toBe(0)
    expect(key('keydown', 'Space').defaultPrevented).toBe(true); expect(clear).toHaveBeenCalled()
    key('keydown', 'KeyR'); await vi.runAllTicks(); expect(clear).toHaveBeenCalledTimes(2); expect(reset).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('blur')); expect(clear.mock.calls.length).toBeGreaterThan(1)
    key('keydown', 'Escape'); expect(controller.isEnabled()).toBe(false)
    controller.dispose(); input.remove()
  })

  it('does not multiply repeat events and dispose removes listeners', async () => {
    const controller = make(); controller.enable(); key('keydown', 'KeyW'); const count = commands.length
    key('keydown', 'KeyW', window, true); expect(commands).toHaveLength(count)
    controller.dispose(); const after = commands.length; key('keydown', 'KeyS'); await vi.advanceTimersByTimeAsync(100)
    expect(commands).toHaveLength(after)
  })

  it('keeps reset available after fault-driven keyboard disable', async () => {
    const controller = make(); controller.enable(); controller.disable('仿真状态变化，已自动停止')
    key('keydown', 'KeyR'); await vi.runAllTicks()
    expect(reset).toHaveBeenCalledOnce()
    const input = document.createElement('input'); document.body.append(input)
    key('keydown', 'KeyR', input); await vi.runAllTicks()
    expect(reset).toHaveBeenCalledOnce()
    controller.dispose(); input.remove()
  })

  it('falls back to event.key when the Windows host omits a standard code', async () => {
    const controller = make(); controller.enable()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Esc', key: 'Escape', bubbles: true }))
    expect(controller.isEnabled()).toBe(false)
    controller.enable()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: '', key: 'w', bubbles: true }))
    await vi.runAllTicks(); expect(commands.at(-1)?.forwardVelocity).toBe(.12)
    controller.dispose()
  })
})

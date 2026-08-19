// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { RealKeyboardController, type RealKeyboardState } from './RealKeyboardController'
import type { MotionIntent, MotionIntentAdapter } from './motionIntent'

function deferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('RealKeyboardController', () => {
  const controllers: RealKeyboardController[] = []
  afterEach(() => controllers.splice(0).forEach((controller) => controller.dispose()))

  const make = (apply: Mock<(intent: MotionIntent | null) => Promise<unknown>> = vi.fn(async (_intent: MotionIntent | null) => undefined)) => {
    const states: RealKeyboardState[] = []
    const controller = new RealKeyboardController({ apply } satisfies MotionIntentAdapter, (state) => states.push(state))
    controllers.push(controller)
    return { controller, apply, states }
  }
  const key = (type: 'keydown' | 'keyup', code: string, target: EventTarget = window, repeat = false) => {
    const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, repeat })
    target.dispatchEvent(event)
    return event
  }
  const flush = async () => { await Promise.resolve(); await Promise.resolve() }

  it('maps WASD/QE combinations to one bounded real motion per state change', async () => {
    const { controller, apply } = make()
    controller.enable()
    key('keydown', 'KeyW')
    await flush()
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      forwardVelocity: .30, lateralVelocity: 0, yawRate: 0,
    }))
    const count = apply.mock.calls.length
    key('keydown', 'KeyW', window, true)
    await flush()
    expect(apply).toHaveBeenCalledTimes(count)

    key('keydown', 'KeyA'); key('keydown', 'KeyE')
    await flush()
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({
      forwardVelocity: .30, lateralVelocity: .30, yawRate: -.50,
    }))
    key('keyup', 'KeyW'); key('keyup', 'KeyA'); key('keyup', 'KeyE')
    await flush()
    expect(apply).toHaveBeenLastCalledWith(null)
  })

  it('refreshes a held Move intent without requiring browser repeat events', async () => {
    vi.useFakeTimers()
    const { controller, apply } = make()
    controller.enable(); key('keydown', 'KeyW'); await flush()
    expect(apply).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(750)
    expect(apply).toHaveBeenCalledTimes(4)
    expect(apply.mock.calls.every(([intent]) => intent && intent.forwardVelocity === .30)).toBe(true)
    key('keyup', 'KeyW'); await flush()
    expect(apply).toHaveBeenLastCalledWith(null)
    controller.dispose()
    vi.useRealTimers()
  })

  it('coalesces in-flight transitions with latest intent winning', async () => {
    const first = deferred()
    const apply = vi.fn((intent: MotionIntent | null) => apply.mock.calls.length === 1 ? first.promise : Promise.resolve(intent))
    const { controller } = make(apply)
    controller.enable()
    key('keydown', 'KeyW'); key('keyup', 'KeyW'); key('keydown', 'KeyS'); key('keydown', 'KeyQ')
    expect(apply).toHaveBeenCalledTimes(1)
    first.resolve(); await flush()
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ forwardVelocity: -.30, yawRate: .50 }))
  })

  it('stops for key release, Space, blur, hidden and Escape', async () => {
    const { controller, apply } = make()
    controller.enable(); key('keydown', 'KeyW'); key('keyup', 'KeyW'); await flush()
    expect(apply).toHaveBeenLastCalledWith(null)
    key('keydown', 'KeyW'); key('keydown', 'Space'); await flush()
    expect(apply).toHaveBeenLastCalledWith(null)
    key('keydown', 'KeyW'); window.dispatchEvent(new Event('blur')); await flush()
    expect(apply).toHaveBeenLastCalledWith(null)
    key('keydown', 'KeyW')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(apply).toHaveBeenLastCalledWith(null)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    key('keydown', 'Escape'); await flush()
    expect(controller.isEnabled()).toBe(false)
    expect(apply).toHaveBeenLastCalledWith(null)
  })

  it('ignores editable controls and does not emit repeat-key heartbeats', async () => {
    const { controller, apply } = make()
    const input = document.createElement('input'); document.body.append(input)
    controller.enable(); key('keydown', 'KeyW', input); await flush()
    expect(apply).not.toHaveBeenCalled()
    key('keydown', 'KeyW'); await flush()
    const count = apply.mock.calls.length
    key('keydown', 'KeyW', window, true); await flush()
    expect(apply).toHaveBeenCalledTimes(count)
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ forwardVelocity: .30 }))
    input.remove()
  })

  it('requests Stop after a failed motion and disarms if Stop also fails', async () => {
    const apply = vi.fn(async () => { throw new Error('transport failed') })
    const { controller, states } = make(apply)
    controller.enable(); key('keydown', 'KeyW'); await flush(); await flush()
    expect(apply).toHaveBeenNthCalledWith(2, null)
    expect(controller.isEnabled()).toBe(false)
    expect(states.at(-1)?.stopReason).toContain('命令发送失败')
    const count = apply.mock.calls.length
    key('keydown', 'KeyS'); await flush()
    expect(apply).toHaveBeenCalledTimes(count)
  })
})

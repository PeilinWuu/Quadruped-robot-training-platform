// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyboardLocomotionController } from '../KeyboardLocomotionController'
import type { MotionCommand } from '../types'

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('KeyboardLocomotionController', () => {
  const commands: MotionCommand[] = []
  const controllers: KeyboardLocomotionController[] = []
  const clear = vi.fn(async () => undefined)
  const reset = vi.fn(async () => undefined)
  beforeEach(() => { vi.useFakeTimers(); commands.length = 0; controllers.length = 0; clear.mockClear(); reset.mockClear() })
  afterEach(() => { controllers.forEach((controller) => controller.dispose()); vi.useRealTimers() })

  const make = (setMotionCommand: (command: MotionCommand) => Promise<unknown> = vi.fn(async (command: MotionCommand) => { commands.push(command) })) => {
    const controller = new KeyboardLocomotionController({ setMotionCommand, clearMotionCommand: clear, reset })
    controllers.push(controller)
    return controller
  }
  const flush = () => vi.advanceTimersByTimeAsync(0)
  const key = (type: 'keydown' | 'keyup', code: string, target: EventTarget = window, repeat = false) => {
    const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, repeat })
    target.dispatchEvent(event)
    return event
  }

  it('keeps the immediate transport at a 20 Hz bounded heartbeat', async () => {
    const controller = make()
    key('keydown', 'KeyW')
    expect(commands).toHaveLength(0)
    controller.enable()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(commands.length).toBeGreaterThanOrEqual(20)
    expect(commands.at(-1)).toMatchObject({ mode: 'locomotion', validForMs: 250 })
    expect(controller.getDiagnostics().maxInFlight).toBe(1)
    controller.dispose()
  })

  it.each([100, 500])('keeps one invoke in flight with a %i ms transport', async (latency) => {
    const invocations: Array<ReturnType<typeof deferred>> = []
    let pending = 0
    let maxPending = 0
    const controller = make(vi.fn((command: MotionCommand) => {
      commands.push(command)
      const call = deferred()
      invocations.push(call)
      pending += 1
      maxPending = Math.max(maxPending, pending)
      return call.promise.finally(() => { pending -= 1 })
    }))
    controller.enable()
    key('keydown', 'KeyW')
    await vi.advanceTimersByTimeAsync(latency)
    expect(invocations).toHaveLength(1)
    expect(controller.getDiagnostics().coalesced).toBeGreaterThan(0)
    invocations[0].resolve(undefined)
    await flush()
    expect(invocations).toHaveLength(2)
    expect(commands.at(-1)?.forwardVelocity).toBe(.30)
    expect(maxPending).toBe(1)
    controller.dispose()
    invocations.at(-1)?.resolve(undefined)
  })

  it('coalesces queued W heartbeats so keyup dispatches zero next', async () => {
    const calls: Array<{ command: MotionCommand; done: ReturnType<typeof deferred> }> = []
    const controller = make(vi.fn((command: MotionCommand) => {
      const done = deferred()
      calls.push({ command, done })
      return done.promise
    }))
    controller.enable()
    key('keydown', 'KeyW')
    await vi.advanceTimersByTimeAsync(250)
    key('keyup', 'KeyW')
    expect(calls).toHaveLength(1)
    calls[0].done.resolve(undefined)
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].command).toMatchObject({ forwardVelocity: 0, yawRate: 0 })
    controller.dispose()
    calls[1].done.resolve(undefined)
  })

  it('uses latest-wins for forward and lateral transitions', async () => {
    const calls: Array<{ command: MotionCommand; done: ReturnType<typeof deferred> }> = []
    const controller = make(vi.fn((command: MotionCommand) => {
      const done = deferred()
      calls.push({ command, done })
      return done.promise
    }))
    controller.enable()
    key('keydown', 'KeyW'); key('keyup', 'KeyW'); key('keydown', 'KeyS')
    key('keyup', 'KeyS'); key('keydown', 'KeyW'); key('keydown', 'KeyA'); key('keyup', 'KeyA'); key('keydown', 'KeyD')
    calls[0].done.resolve(undefined)
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].command).toMatchObject({ forwardVelocity: .30, lateralVelocity: -.30, yawRate: 0 })
    controller.dispose()
    calls[1].done.resolve(undefined)
  })

  it('maps A/D to lateral motion and Q/E to yaw with the same unified limits', async () => {
    const controller = make()
    controller.enable()
    key('keydown', 'KeyA'); key('keydown', 'KeyQ')
    await flush()
    expect(commands.at(-1)).toMatchObject({ forwardVelocity: 0, lateralVelocity: .30, yawRate: .50 })
    key('keyup', 'KeyA'); key('keyup', 'KeyQ'); key('keydown', 'KeyD'); key('keydown', 'KeyE')
    await flush()
    expect(commands.at(-1)).toMatchObject({ forwardVelocity: 0, lateralVelocity: -.30, yawRate: -.50 })
    controller.dispose()
  })

  it('gives Space, Escape, blur and hidden an immediate latest clear priority', async () => {
    const first = deferred()
    const setMotion = vi.fn(() => first.promise)
    const controller = make(setMotion)
    controller.enable(); key('keydown', 'KeyW')
    expect(key('keydown', 'Space').defaultPrevented).toBe(true)
    first.resolve(undefined)
    await flush()
    expect(clear).toHaveBeenCalledOnce()

    key('keydown', 'KeyW'); window.dispatchEvent(new Event('blur'))
    await flush()
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(2)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(3)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })

    key('keydown', 'Escape')
    await flush()
    expect(controller.isEnabled()).toBe(false)
    controller.dispose()
  })

  it('removes timers/listeners on unmount and is StrictMode mount-safe', async () => {
    const first = make(); first.enable(); first.dispose()
    const count = commands.length
    key('keydown', 'KeyW')
    await vi.advanceTimersByTimeAsync(200)
    expect(commands).toHaveLength(count)
    const second = make(); second.enable(); key('keydown', 'KeyW')
    await flush()
    expect(commands.at(-1)?.forwardVelocity).toBe(.30)
    second.dispose()
  })

  it('does not let an old generation completion overwrite a disarmed clear', async () => {
    const first = deferred()
    const controller = make(vi.fn(() => first.promise))
    controller.enable(); key('keydown', 'KeyW'); controller.disable('test disarm')
    first.resolve(undefined)
    await flush()
    expect(clear).toHaveBeenCalledOnce()
    expect(controller.isEnabled()).toBe(false)
    controller.dispose()
  })

  it('protects editable controls, repeat events and fallback event.key', async () => {
    const controller = make(); controller.enable()
    const input = document.createElement('input'); document.body.append(input)
    key('keydown', 'KeyW', input)
    await flush()
    expect(commands.at(-1)?.forwardVelocity).toBe(0)
    const count = commands.length
    key('keydown', 'KeyW'); key('keydown', 'KeyW', window, true)
    expect(commands).toHaveLength(count + 1)
    key('keyup', 'KeyW')
    window.dispatchEvent(new KeyboardEvent('keydown', { code: '', key: 's', bubbles: true }))
    await flush()
    expect(commands.at(-1)?.forwardVelocity).toBe(-.30)
    controller.dispose(); input.remove()
  })

  it('keeps sequence monotonic and validForMs unchanged while coalescing', async () => {
    const controller = make(); controller.enable(); key('keydown', 'KeyW')
    await vi.advanceTimersByTimeAsync(250)
    const sequences = commands.map((command) => command.sequence)
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(true)
    expect(commands.every((command) => command.validForMs === 250)).toBe(true)
    controller.dispose()
  })

  it('recovers on the next heartbeat after a rejected invoke without unhandled rejection', async () => {
    let attempts = 0
    const setMotion = vi.fn(async (command: MotionCommand) => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary')
      commands.push(command)
    })
    const controller = make(setMotion)
    controller.enable()
    await flush()
    expect(controller.isEnabled()).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(setMotion).toHaveBeenCalledTimes(2)
    expect(controller.getDiagnostics().rejected).toBe(1)
    expect(controller.getDiagnostics().completed).toBe(1)
    controller.dispose()
  })

  it('clears before reset and does not leave historical motion', async () => {
    const controller = make(); controller.enable(); key('keydown', 'KeyW'); key('keydown', 'KeyR')
    await flush()
    expect(clear).toHaveBeenCalled()
    expect(reset).toHaveBeenCalledOnce()
    controller.dispose()
  })
})

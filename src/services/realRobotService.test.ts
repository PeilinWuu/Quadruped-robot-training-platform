// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
import { realRobotService } from './realRobotService'

describe('realRobotService', () => {
  beforeEach(() => {
    mocks.invoke.mockReset(); mocks.listen.mockReset()
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  })
  afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

  it('uses dedicated bounded real-robot commands', async () => {
    mocks.invoke.mockResolvedValue({ state: 'ready' })
    await realRobotService.status()
    await realRobotService.setEnabled(true)
    await realRobotService.moveOnce({ forwardVelocity: .05, lateralVelocity: 0, yawRate: 0, durationMs: 500 })
    await realRobotService.keyboardMotion({ forwardVelocity: .05, lateralVelocity: .05, yawRate: -.1 })
    await realRobotService.stop()
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'real_robot_status')
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'real_robot_set_enabled', { enabled: true })
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'real_robot_move_once', { command: { forwardVelocity: .05, lateralVelocity: 0, yawRate: 0, durationMs: 500 } })
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, 'real_robot_keyboard_motion', { command: { forwardVelocity: .05, lateralVelocity: .05, yawRate: -.1 } })
    expect(mocks.invoke).toHaveBeenNthCalledWith(5, 'real_robot_stop')
  })

  it('subscribes only to low-rate status events', async () => {
    const cleanup = vi.fn(); mocks.listen.mockResolvedValue(cleanup)
    await expect(realRobotService.subscribe(vi.fn())).resolves.toBe(cleanup)
    expect(mocks.listen).toHaveBeenCalledWith('real-robot-status-changed', expect.any(Function))
  })
})

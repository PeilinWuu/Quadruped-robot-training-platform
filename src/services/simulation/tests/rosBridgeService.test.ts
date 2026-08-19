// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))

import { rosBridgeService } from '../rosBridgeService'

describe('rosBridgeService', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  })
  afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

  it('uses bounded Tauri commands for status and control source', async () => {
    mocks.invoke.mockResolvedValue({ state: 'ready', available: true, controlSource: 'manual' })
    await rosBridgeService.status()
    await rosBridgeService.setControlSource('ros')
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'ros_bridge_status')
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'ros_bridge_set_control_source', { source: 'ros' })
  })

  it('subscribes to low-rate bridge status events', async () => {
    const cleanup = vi.fn()
    mocks.listen.mockResolvedValue(cleanup)
    await expect(rosBridgeService.subscribe(vi.fn())).resolves.toBe(cleanup)
    expect(mocks.listen).toHaveBeenCalledWith('ros-bridge-status-changed', expect.any(Function))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimulationEvent } from '../types'
import { browserSimulationAdapter } from '../browserSimulationAdapter'

const mocks = vi.hoisted(() => {
  const invoke = vi.fn()
  class Channel<T> {
    onmessage: (message: T) => void = () => undefined
    emit(message: T) { this.onmessage(message) }
  }
  return { invoke, Channel }
})
vi.mock('@tauri-apps/api/core', () => mocks)

describe('simulation adapters', () => {
  beforeEach(() => mocks.invoke.mockReset())

  it('browser adapter reports desktop-only without invoking Tauri', async () => {
    expect(browserSimulationAdapter.desktop).toBe(false)
    expect((await browserSimulationAdapter.getStatus()).state).toBe('unavailable')
    await expect(browserSimulationAdapter.startSidecar()).rejects.toThrow('桌面版')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('maps process start, status and ping commands', async () => {
    mocks.invoke.mockResolvedValue({})
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    await adapter.startSidecar(); await adapter.getStatus(); await adapter.ping()
    expect(mocks.invoke.mock.calls.map((call) => call[0])).toEqual([
      'simulation_sidecar_start', 'simulation_sidecar_status', 'simulation_sidecar_ping',
    ])
  })

  it('does not confuse simulation stop with sidecar stop', async () => {
    mocks.invoke.mockResolvedValue({})
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    await adapter.stopSimulation(); await adapter.stopSidecar()
    expect(mocks.invoke.mock.calls.map((call) => call[0])).toEqual([
      'simulation_run_stop', 'simulation_sidecar_stop',
    ])
  })

  it('maps model and run controls with typed arguments', async () => {
    mocks.invoke.mockResolvedValue({})
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    await adapter.loadModel('unitree-go2-menagerie'); await adapter.startSimulation(); await adapter.pauseSimulation()
    await adapter.stepSimulation(3); await adapter.resetSimulation(); await adapter.setSpeed(2)
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_run_step', { steps: 3 })
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_set_speed', { speed: 2 })
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_load_model', {
      modelId: 'unitree-go2-menagerie',
      environmentId: 'flat-ground-v1',
    })
  })

  it('maps virtual motion and telemetry commands without arbitrary payloads', async () => {
    mocks.invoke.mockResolvedValue({})
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    const command = { sequence: 7, mode: 'locomotion' as const, forwardVelocity: .2, lateralVelocity: 0, yawRate: .1, bodyHeight: .3, validForMs: 500 }
    await adapter.setMotionCommand(command); await adapter.clearMotionCommand()
    await adapter.setTelemetryRate(25); await adapter.getLatestTelemetry()
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_set_motion_command', { command })
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_clear_motion_command', undefined)
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_set_telemetry_rate', { rateHz: 25 })
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_latest_telemetry', undefined)
  })

  it('delivers a strongly typed channel event', async () => {
    mocks.invoke.mockResolvedValue(undefined)
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    const listener = vi.fn()
    await adapter.subscribe(listener)
    const channel = mocks.invoke.mock.calls[0][1].channel as InstanceType<typeof mocks.Channel<SimulationEvent>>
    const event: SimulationEvent = { type: 'state_changed', payload: { state: 'running' } }
    channel.emit(event)
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('unsubscribes exactly once and disables channel delivery', async () => {
    mocks.invoke.mockResolvedValue(undefined)
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    const listener = vi.fn()
    const subscription = await adapter.subscribe(listener)
    const args = mocks.invoke.mock.calls[0][1]
    await subscription.unsubscribe(); await subscription.unsubscribe()
    expect(mocks.invoke).toHaveBeenCalledWith('simulation_unsubscribe', {
      subscriptionId: args.subscriptionId,
    })
    expect(mocks.invoke.mock.calls.filter((call) => call[0] === 'simulation_unsubscribe')).toHaveLength(1)
    args.channel.emit({ type: 'state_changed', payload: { state: 'paused' } })
    expect(listener).not.toHaveBeenCalled()
  })

  it('contains listener exceptions inside channel delivery', async () => {
    mocks.invoke.mockResolvedValue(undefined)
    const { tauriSimulationAdapter: adapter } = await import('../tauriSimulationAdapter')
    await adapter.subscribe(() => { throw new Error('listener') })
    const channel = mocks.invoke.mock.calls[0][1].channel
    expect(() => channel.emit({ type: 'state_changed', payload: { state: 'running' } })).not.toThrow()
  })
})

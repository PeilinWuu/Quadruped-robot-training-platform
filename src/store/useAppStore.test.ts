import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { services } from '../services'
import type { RobotPose, SimulationEvent, SimulationListener, SimulationStatus } from '../services/simulation/types'
import { useAppStore } from './useAppStore'
import { FLAT_GROUND_ENVIRONMENT } from '../services/simulation/types'

const READY: SimulationStatus = {
  state: 'ready', simulationState: 'running', sidecarVersion: 'test',
  model: { modelId: 'minimal-quadruped-v1', environmentId: 'flat-ground-v1', environment: FLAT_GROUND_ENVIRONMENT, timestep: .002, jointCount: 12, actuatorCount: 12, bodyCount: 14 },
  speed: 1, startedAt: 1, error: null,
}
const IDLE: SimulationStatus = { ...READY, state: 'idle', simulationState: 'unloaded', model: null }
const POSE: RobotPose = {
  sequence: 1, simulationTime: .1, wallTime: 1000,
  rootPosition: [1, 2, 3], rootOrientation: [0, 0, 0, 1],
  joints: Array.from({ length: 12 }, (_, index) => ({ name: `joint-${index}`, position: index })),
}

describe('simulation Zustand boundary', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(services.simulation, 'shutdown').mockResolvedValue(IDLE)
    await useAppStore.getState().shutdownSimulation()
    vi.restoreAllMocks()
    useAppStore.setState((state) => ({ simulation: {
      ...state.simulation, processState: 'idle', simulationState: 'unloaded', model: null,
      speed: 1, lastError: null, latestPose: null, latestSpatialState: null, busy: false,
    } }))
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('blocks repeated clicks while an operation is pending', async () => {
    let resolve!: (status: SimulationStatus) => void
    const pending = new Promise<SimulationStatus>((done) => { resolve = done })
    vi.spyOn(services.simulation, 'onEvent').mockReturnValue(() => undefined)
    vi.spyOn(services.simulation, 'start').mockReturnValue(pending)
    const first = useAppStore.getState().startSimulation()
    const repeated = await useAppStore.getState().startSimulation()
    expect(repeated).toEqual({ ok: false, error: '仿真操作正在进行，请稍候' })
    expect(services.simulation.start).toHaveBeenCalledTimes(1)
    resolve(READY)
    expect(await first).toEqual({ ok: true })
    expect(useAppStore.getState().simulation.busy).toBe(false)
  })

  it('recovers busy state after an error', async () => {
    vi.spyOn(services.simulation, 'onEvent').mockReturnValue(() => undefined)
    vi.spyOn(services.simulation, 'pause').mockRejectedValueOnce(new Error('private path'))
    const failed = await useAppStore.getState().pauseSimulation()
    expect(failed.ok).toBe(false)
    expect(failed.error).not.toContain('private path')
    expect(useAppStore.getState().simulation.busy).toBe(false)
  })

  it('throttles 60 pose events into a low-frequency snapshot', async () => {
    let listener: SimulationListener = () => undefined
    vi.spyOn(services.simulation, 'onEvent').mockImplementation((next) => { listener = next; return () => undefined })
    vi.spyOn(services.simulation, 'getStatus').mockResolvedValue(READY)
    await useAppStore.getState().initializeSimulation()
    let poseUpdates = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.simulation.latestPose !== previous.simulation.latestPose) poseUpdates += 1
    })
    for (let sequence = 0; sequence < 60; sequence += 1) {
      listener({ type: 'pose', payload: { ...POSE, sequence } } satisfies SimulationEvent)
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(poseUpdates).toBeLessThanOrEqual(2)
    expect(useAppStore.getState().simulation.latestPose?.sequence).toBe(59)
    expect(useAppStore.getState().simulation.latestPose?.joints).toHaveLength(12)
    expect(useAppStore.getState().simulation.latestSpatialState?.odomToBase.transform.translation).toEqual([1, -3, 2])
    unsubscribe()
  })

  it('attaches one event bridge and removes it during logout cleanup', async () => {
    const cleanup = vi.fn()
    vi.spyOn(services.simulation, 'onEvent').mockReturnValue(cleanup)
    vi.spyOn(services.simulation, 'getStatus').mockResolvedValue(READY)
    vi.spyOn(services.simulation, 'shutdown').mockResolvedValue(IDLE)
    await useAppStore.getState().initializeSimulation()
    await useAppStore.getState().initializeSimulation()
    expect(services.simulation.onEvent).toHaveBeenCalledTimes(1)
    await useAppStore.getState().shutdownSimulation()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(services.simulation.shutdown).toHaveBeenCalledTimes(1)
  })

  it('does not fetch or append mock research metrics while the feature is disabled', async () => {
    const getMetrics = vi.spyOn(services.training, 'getMetrics')
    await useAppStore.getState().initialize()
    expect(getMetrics).not.toHaveBeenCalled()
    expect(useAppStore.getState().metrics).toEqual([])
    useAppStore.getState().appendMockMetrics()
    expect(useAppStore.getState().metrics).toEqual([])
  })
})

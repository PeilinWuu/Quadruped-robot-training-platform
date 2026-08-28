import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedSimulationService } from '../simulationService'
import type {
  ModelMetadata, RobotPose, SimulationAdapter, SimulationListener,
  SimulationState, SimulationStatus, SimulationSubscription,
} from '../types'
import { FLAT_GROUND_ENVIRONMENT } from '../types'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const MODEL: ModelMetadata = { modelId: 'unitree-go2-menagerie', environmentId: 'flat-ground-v1', environment: FLAT_GROUND_ENVIRONMENT, timestep: .002, jointCount: 12, actuatorCount: 12, bodyCount: 18 }
const JOINTS = ['FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint']
const POSE: RobotPose = {
  sequence: 1, simulationTime: .002, wallTime: 100,
  rootPosition: [1, 2, 3], rootOrientation: [0, 0, 0, 1],
  joints: JOINTS.map((name, index) => ({ name, position: index / 10 })),
}

function fakeAdapter(initial?: Partial<SimulationStatus>) {
  let listener: SimulationListener = () => undefined
  let status: SimulationStatus = {
    state: 'idle', simulationState: 'unloaded', sidecarVersion: null,
    model: null, speed: 1, startedAt: null, error: null, ...initial,
  }
  const calls: string[] = []
  const state = (next: SimulationState) => { status = { ...status, simulationState: next }; return Promise.resolve(next) }
  const subscription: SimulationSubscription = { unsubscribe: vi.fn(async () => undefined) }
  const adapter: SimulationAdapter = {
    desktop: true,
    getStatus: vi.fn(async () => ({ ...status })),
    startSidecar: vi.fn(async () => { calls.push('startSidecar'); status = { ...status, state: 'ready', sidecarVersion: 'test' }; return { ...status } }),
    ping: vi.fn(async () => ({ latencyMs: 1, nonceVerified: true })),
    stopSidecar: vi.fn(async () => { calls.push('stopSidecar'); status = { ...status, state: 'idle', simulationState: 'unloaded', model: null }; return { ...status } }),
    loadModel: vi.fn(async (modelId) => { calls.push(`loadModel:${modelId}`); status = { ...status, model: { ...MODEL, modelId }, simulationState: 'loaded' }; return { ...MODEL, modelId } }),
    startSimulation: vi.fn(async () => { calls.push('start'); return state('running') }),
    pauseSimulation: vi.fn(async () => { calls.push('pause'); return state('paused') }),
    stepSimulation: vi.fn(async (steps) => { calls.push(`step:${steps}`); return POSE }),
    resetSimulation: vi.fn(async () => { calls.push('reset'); return state('loaded') }),
    stopSimulation: vi.fn(async () => { calls.push('stop'); return state('stopped') }),
    setSpeed: vi.fn(async (speed) => { calls.push(`speed:${speed}`); status = { ...status, speed }; return speed }),
    getLatestPose: vi.fn(async () => POSE),
    setMotionCommand: vi.fn(async (command) => ({ ...command, ageMs: 0, timedOut: false, appliedByController: command.mode === 'stand', bodyHeightApplied: false, controllerAvailability: command.mode === 'stand' ? 'stand-hold' as const : 'not-implemented' as const })),
    clearMotionCommand: vi.fn(async () => ({ sequence: 0, mode: 'stand' as const, forwardVelocity: 0, lateralVelocity: 0, yawRate: 0, bodyHeight: .3, validForMs: 500, ageMs: 0, timedOut: false, appliedByController: true, bodyHeightApplied: false, controllerAvailability: 'stand-hold' as const })),
    setTelemetryRate: vi.fn(async (rateHz) => ({ rateHz })),
    getLatestTelemetry: vi.fn(async () => null),
    listAvailableEnvironments: vi.fn(async () => [FLAT_GROUND_ENVIRONMENT]),
    getCurrentEnvironment: vi.fn(async () => status.model?.environment ?? null),
    getLatestCollisionState: vi.fn(async () => null),
    getLatestCollisionEvent: vi.fn(async () => null),
    subscribe: vi.fn(async (nextListener) => { calls.push('subscribe'); listener = nextListener; return subscription }),
  }
  return { adapter, calls, subscription, emit: (event: Parameters<SimulationListener>[0]) => listener(event) }
}

describe('ManagedSimulationService', () => {
  let fake: ReturnType<typeof fakeAdapter>
  let service: ManagedSimulationService
  beforeEach(() => {
    fake = fakeAdapter()
    service = new ManagedSimulationService(async () => fake.adapter)
  })

  it('starts sidecar, loads model, subscribes, then starts physics', async () => {
    const status = await service.start()
    expect(fake.calls).toEqual(['startSidecar', 'loadModel:unitree-go2-menagerie', 'subscribe', 'start'])
    expect(status.simulationState).toBe('running')
  })

  it('does not repeat ready, loaded, running, or subscription work', async () => {
    fake = fakeAdapter({ state: 'ready', simulationState: 'running', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    await service.start(); await service.start()
    expect(fake.calls).toEqual(['subscribe'])
  })

  it('maps pause, resume and simulation-only stop', async () => {
    fake = fakeAdapter({ state: 'ready', simulationState: 'running', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    await service.pause(); await service.resume(); await service.stop()
    expect(fake.calls).toEqual(['pause', 'start', 'stop'])
    expect(fake.adapter.stopSidecar).not.toHaveBeenCalled()
  })

  it('pauses a running simulation before exactly one step and forwards its pose', async () => {
    fake = fakeAdapter({ state: 'ready', simulationState: 'running', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    const poseListener = vi.fn(); service.onPose(poseListener)
    await service.step()
    expect(fake.calls).toEqual(['pause', 'step:1'])
    expect(poseListener).toHaveBeenCalledWith(POSE)
  })

  it('resets and forwards the resulting latest pose', async () => {
    fake = fakeAdapter({ state: 'ready', simulationState: 'paused', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    const listener = vi.fn(); service.onPose(listener)
    await service.reset()
    expect(fake.calls).toEqual(['reset'])
    expect(listener).toHaveBeenCalledWith(POSE)
  })

  it('pauses, resets, and resumes when reset is requested while running', async () => {
    fake = fakeAdapter({ state: 'ready', simulationState: 'running', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    const status = await service.reset()
    expect(fake.calls).toEqual(['pause', 'reset', 'start'])
    expect(status.simulationState).toBe('running')
  })

  it('reaps and restarts a failed sidecar before resetting the selected model', async () => {
    fake = fakeAdapter({
      state: 'failed', simulationState: 'running', model: MODEL,
      error: { code: 'SIDECAR_DISCONNECTED', message: 'sidecar exited' },
    })
    service = new ManagedSimulationService(async () => fake.adapter)
    const status = await service.reset()
    expect(fake.calls).toEqual([
      'stopSidecar', 'startSidecar', 'loadModel:unitree-go2-menagerie',
      'subscribe', 'reset', 'start',
    ])
    expect(status).toMatchObject({ state: 'ready', simulationState: 'running', model: MODEL })
  })

  it('validates speed before calling the adapter', async () => {
    await expect(service.setSpeed(.24)).rejects.toThrow('0.25')
    await expect(service.setSpeed(4.01)).rejects.toThrow('0.25')
    expect(fake.adapter.setSpeed).not.toHaveBeenCalled()
    await service.setSpeed(4)
    expect(fake.calls).toEqual(['speed:4'])
  })

  it('uses one subscription and cleans it before stopping the sidecar', async () => {
    await service.start()
    await service.shutdown(); await service.shutdown()
    expect(fake.subscription.unsubscribe).toHaveBeenCalledTimes(1)
    expect(fake.adapter.stopSidecar).toHaveBeenCalledTimes(1)
  })

  it('coalesces motion invokes latest-wins and gives a pending clear priority', async () => {
    const first = deferred<Awaited<ReturnType<SimulationAdapter['setMotionCommand']>>>()
    vi.mocked(fake.adapter.setMotionCommand).mockImplementationOnce(() => first.promise)
    const base = { sequence: 1, mode: 'locomotion' as const, forwardVelocity: .12, lateralVelocity: 0, yawRate: 0, bodyHeight: .3, validForMs: 250 }
    const firstResult = service.setMotionCommand(base)
    await vi.waitFor(() => expect(fake.adapter.setMotionCommand).toHaveBeenCalledTimes(1))
    const staleResult = service.setMotionCommand({ ...base, sequence: 2, yawRate: .24 })
    const latestResult = service.setMotionCommand({ ...base, sequence: 3, yawRate: -.24 })
    const clearResult = service.clearMotionCommand()
    expect(fake.adapter.clearMotionCommand).not.toHaveBeenCalled()
    first.resolve({ ...base, ageMs: 0, timedOut: false, appliedByController: true, bodyHeightApplied: true, controllerAvailability: 'go2-kinematic-animation-v1' })
    await firstResult
    await vi.waitFor(() => expect(fake.adapter.clearMotionCommand).toHaveBeenCalledOnce())
    expect(fake.adapter.setMotionCommand).toHaveBeenCalledTimes(1)
    await Promise.all([staleResult, latestResult, clearResult])
    expect(service.getMotionDispatchDiagnostics()).toMatchObject({
      requested: 4, dispatched: 2, completed: 2, coalesced: 2,
      inFlight: 0, maxInFlight: 1,
    })
  })

  it('isolates event listeners and keeps the 60 Hz pose outside React state', async () => {
    await service.start()
    const good = vi.fn(); service.onEvent(() => { throw new Error('listener') }); service.onEvent(good)
    fake.emit({ type: 'pose', payload: POSE })
    expect(service.getBufferedPose()).toBe(POSE)
    expect(good).toHaveBeenCalledWith({ type: 'pose', payload: POSE })
  })
  it('defaults to the fixed Go2 model list and blocks running model switches', async () => {
    expect(service.getSelectedModel().id).toBe('unitree-go2-menagerie')
    expect(service.listAvailableModels().map((model) => model.id)).toEqual(['unitree-go2-menagerie', 'minimal-quadruped-v1'])
    fake = fakeAdapter({ state: 'ready', simulationState: 'running', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    await expect(service.selectModel('minimal-quadruped-v1')).rejects.toThrow('运行中')
    expect(fake.adapter.loadModel).not.toHaveBeenCalled()
  })

  it('switches a stopped model and drops stale Go2 poses', async () => {
    fake = fakeAdapter({ state: 'ready', simulationState: 'stopped', model: MODEL })
    service = new ManagedSimulationService(async () => fake.adapter)
    await service.selectModel('minimal-quadruped-v1')
    expect(fake.calls).toEqual(['loadModel:minimal-quadruped-v1'])
    const listener = vi.fn(); service.onPose(listener)
    fake.emit({ type: 'pose', payload: POSE })
    expect(service.getBufferedPose()).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })
})

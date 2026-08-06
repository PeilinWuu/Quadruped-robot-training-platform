import { afterEach, describe, expect, it, vi } from 'vitest'
import { RobotTelemetryBuffer } from '../RobotTelemetryBuffer'
import type { RobotTelemetry } from '../types'

const telemetry = (sequence: number): RobotTelemetry => ({
  sequence, simulationTime: sequence * .02, wallTime: 1000 + sequence,
  modelId: 'unitree-go2-menagerie',
  source: { kind: 'mujoco-simulation', connectedToPhysicalRobot: false },
  root: { position: [0, .3, 0], orientation: [0, 0, 0, 1], linearVelocityWorld: [0, 0, 0], angularVelocityWorld: [0, 0, 0], linearSpeed: 0, angularSpeed: 0 },
  imu: { orientation: [0, 0, 0, 1], angularVelocityBody: [0, 0, 0], linearAccelerationBody: [0, 0, 0], frame: 'body', includesGravity: false, source: 'root-body-state' },
  joints: ['FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint'].map((name) => ({ name, position: 0, velocity: 0, actuatorTorque: 0, actuatorForce: 0, controlTarget: 0, lowerLimit: -1, upperLimit: 1, limited: true })),
  feet: (['FL', 'FR', 'RL', 'RR'] as const).map((name) => ({ name, inContact: true, contactCount: 1, normalForce: 30, forceWorld: [0, 30, 0], positionWorld: [0, 0, 0] })),
  collision: { environmentId: 'flat-ground-v1', totalEnvironmentContacts: 4, footContacts: 4, nonFootContacts: 0, torsoContacts: 0, headContacts: 0, limbContacts: 0, maxNormalForce: 30, totalNormalForce: 120, strongestContact: { category: 'feet', bodyName: 'FL_calf', geomName: 'FL', normalForce: 30, positionWorld: [0, 0, 0] }, isFallen: false, fallReason: 'none', isOutOfBounds: false, rootHeightAboveFloor: .27, roll: 0, pitch: 0 },
  command: { sequence: 0, mode: 'stand', forwardVelocity: 0, lateralVelocity: 0, yawRate: 0, bodyHeight: .3, validForMs: 500, ageMs: 0, timedOut: false, appliedByController: true, bodyHeightApplied: false, controllerAvailability: 'stand-hold' },
  locomotion: { controllerId: 'go2-convex-mpc-v1', availability: 'available', state: 'standing',
    commandedForwardVelocity: 0, filteredForwardVelocity: 0, measuredForwardVelocity: 0,
    commandedYawRate: 0, filteredYawRate: 0, measuredYawRate: 0,
    mpcFrequencyHz: 50, legControllerFrequencyHz: 250, horizonSteps: 10,
    gaitFrequencyHz: 2.2, dutyFactor: .65, gaitPhase: 0,
    expectedContacts: [true, true, true, true], actualContacts: [true, true, true, true],
    desiredGroundForces: [[0, 0, 37], [0, 0, 37], [0, 0, 37], [0, 0, 37]],
    actualGroundForces: [[0, 0, 37], [0, 0, 37], [0, 0, 37], [0, 0, 37]],
    solverStatus: 'solved', solverIterations: 25, solverMeanMs: 1, solverMaxMs: 2,
    qpFailureCount: 0, touchdownEventCount: 0, onTimeTouchdownCount: 0,
    lateTouchdownEventCount: 0, earlyTouchdownEventCount: 0, touchdownTimeoutCount: 0,
    touchdownLatencyMeanMs: 0, touchdownLatencyMaxMs: 0, touchdownLatencyP95Ms: 0,
    footSlipSummary: 0,
    jointLimitClipCount: 0, actuatorSaturationCount: 0, faultReason: null },
  performance: { physicsFrequencyHz: 500, controlFrequencyHz: 100, posePublishFrequencyHz: 60, telemetryPublishFrequencyHz: 50, realTimeFactor: 1, physicsStepMeanMs: .1, physicsStepMaxMs: .2, controlStepMeanMs: .01, controlStepMaxMs: .02, droppedPoseEvents: 0, droppedTelemetryEvents: 0, catchUpStepCount: 0 },
})

describe('RobotTelemetryBuffer', () => {
  afterEach(() => vi.useRealTimers())
  it('keeps only the latest value and publishes listeners at no more than 10 Hz', () => {
    vi.useFakeTimers()
    const buffer = new RobotTelemetryBuffer(100)
    const listener = vi.fn()
    buffer.subscribe(listener)
    for (let sequence = 1; sequence <= 5; sequence += 1) buffer.update(telemetry(sequence))
    expect(buffer.getLatest()?.sequence).toBe(5)
    expect(listener).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(100)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].sequence).toBe(5)
  })

  it('isolates listeners and clears state on dispose', () => {
    const buffer = new RobotTelemetryBuffer(0)
    const good = vi.fn()
    buffer.subscribe(() => { throw new Error('consumer') })
    buffer.subscribe(good)
    buffer.update(telemetry(1))
    expect(good).toHaveBeenCalledTimes(1)
    buffer.dispose()
    expect(buffer.getLatest()).toBeNull()
    buffer.update(telemetry(2))
    expect(good).toHaveBeenCalledTimes(1)
  })
})

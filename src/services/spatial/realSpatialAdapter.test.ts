import { describe, expect, it } from 'vitest'
import type { RealRobotTelemetry } from '../realRobotService'
import { spatialStateFromSimulationPose } from './simulationSpatialAdapter'
import {
  applySpatialOriginAlignment, createSpatialOriginAlignment,
  spatialAlignmentError, spatialStateFromRealTelemetry,
} from './realSpatialAdapter'
import { yawFromQuaternion } from './transformMath'

const telemetry = (position = [10, -4, .3], rpy = [.02, -.01, .5]): RealRobotTelemetry => ({
  lowState: { tick: 123, batterySoc: 80, powerVoltage: 28, powerCurrent: 1, rpy, gyroscope: [0, 0, 0], accelerometer: [0, 0, 9.8], footForce: [1, 1, 1, 1], joints: [] },
  sportModeState: { errorCode: 0, mode: 1, gaitType: 1, position, velocity: [.1, .2, 0], bodyHeight: .3, yawSpeed: .2 },
})

describe('real spatial adapter and origin alignment', () => {
  it('maps Sport local odometry and IMU RPY into the canonical frame tree', () => {
    const state = spatialStateFromRealTelemetry(telemetry(), 40, 2000)
    expect(state).toMatchObject({
      source: 'real', sequence: 123, sourceTimestampMs: 1960, hostTimestampMs: 2000,
      confidence: 'low', worldToOdom: { parentFrame: 'world', childFrame: 'real_odom' },
      odomToBase: { parentFrame: 'real_odom', childFrame: 'base_link' },
      linearVelocityWorld: [.1, .2, 0], angularVelocityWorld: [0, 0, .2],
    })
    expect(state?.odomToBase.transform.translation).toEqual([10, -4, .3])
    expect(yawFromQuaternion(state!.odomToBase.transform.rotation)).toBeCloseTo(.5, 12)
  })

  it('requires both Sport position and IMU orientation', () => {
    expect(spatialStateFromRealTelemetry({ ...telemetry(), lowState: null }, 0)).toBeNull()
    expect(spatialStateFromRealTelemetry({ ...telemetry(), sportModeState: null }, 0)).toBeNull()
  })

  it('sets the real origin onto the current simulation position and yaw', () => {
    const real = spatialStateFromRealTelemetry(telemetry([10, -4, .3], [0, 0, .5]), 0, 2000)!
    const reference = spatialStateFromSimulationPose({
      sequence: 9, simulationTime: 1, wallTime: 1900,
      rootPosition: [2, 1, -3], rootOrientation: [0, Math.sin(.6 / 2), 0, Math.cos(.6 / 2)], joints: [],
    }, 2000)
    const alignment = createSpatialOriginAlignment(real, reference, 2100)
    const aligned = applySpatialOriginAlignment(real, alignment)
    const error = spatialAlignmentError(aligned, reference)
    expect(alignment).toMatchObject({ createdAtMs: 2100, realSequence: 123, referenceSequence: 9 })
    expect(error.distance).toBeCloseTo(0, 12)
    expect(error.yaw).toBeCloseTo(0, 12)
  })

  it('reports translation and wrapped yaw errors after movement', () => {
    const reference = spatialStateFromSimulationPose({
      sequence: 9, simulationTime: 1, wallTime: 1900,
      rootPosition: [0, 0, 0], rootOrientation: [0, 0, 0, 1], joints: [],
    })
    const real = spatialStateFromRealTelemetry(telemetry([3, 4, 0], [0, 0, -.2]), 0)!
    const error = spatialAlignmentError(real, reference)
    expect(error.translation).toEqual([3, 4, 0])
    expect(error.distance).toBe(5)
    expect(error.yaw).toBeCloseTo(-.2, 12)
  })
})

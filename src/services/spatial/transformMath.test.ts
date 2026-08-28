import { describe, expect, it } from 'vitest'
import { composeTransforms, IDENTITY_TRANSFORM, invertTransform, transformPoint, yawFromQuaternion } from './transformMath'
import { sensorFrameFromSpatialState, spatialStateFromSimulationPose, viewerQuaternionToRos, viewerVectorToRos } from './simulationSpatialAdapter'
import type { RobotPose } from '../simulation/types'

const close = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12))
}
const pose = (overrides: Partial<RobotPose> = {}): RobotPose => ({
  sequence: 7, simulationTime: 1.25, wallTime: 1234,
  rootPosition: [1, 3, -2], rootOrientation: [0, 0, 0, 1], joints: [], ...overrides,
})

describe('unified spatial coordinates', () => {
  it('matches the existing C++ viewer Y-up to ROS Z-up mapping', () => {
    expect(viewerVectorToRos([1, 3, -2])).toEqual([1, 2, 3])
    close(viewerQuaternionToRos([0, 0, 0, 1]), [0, 0, 0, 1])
    const half = Math.SQRT1_2
    const yaw = viewerQuaternionToRos([0, half, 0, half])
    close(yaw, [0, 0, half, half])
    expect(yawFromQuaternion(yaw)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('composes and inverts rigid transforms without changing points', () => {
    const first = { translation: [1, 2, 3] as [number, number, number], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number] }
    const second = { translation: [1, 0, 0] as [number, number, number], rotation: [...IDENTITY_TRANSFORM.rotation] as [number, number, number, number] }
    const combined = composeTransforms(first, second)
    close(combined.translation, [1, 3, 3])
    close(transformPoint(invertTransform(combined), transformPoint(combined, [2, -1, .5])), [2, -1, .5])
  })

  it('adapts a simulation pose into explicit world, odom and base frames', () => {
    const state = spatialStateFromSimulationPose(pose(), 1300)
    expect(state).toMatchObject({
      schemaVersion: 1, source: 'simulation', sequence: 7,
      sourceTimestampMs: 1234, hostTimestampMs: 1300, confidence: 'high',
      worldToOdom: { parentFrame: 'world', childFrame: 'odom' },
      odomToBase: { parentFrame: 'odom', childFrame: 'base_link' },
    })
    expect(state.odomToBase.transform.translation).toEqual([1, 2, 3])
    close(state.odomToBase.transform.rotation, [0, 0, 0, 1])
  })

  it('derives world camera pose from a versioned base extrinsic', () => {
    const state = spatialStateFromSimulationPose(pose({ rootPosition: [1, 0, 0] }), 1300)
    const camera = sensorFrameFromSpatialState(state, {
      sensorId: 'front-camera', calibrationId: 'test-v1',
      baseToSensor: { parentFrame: 'base_link', childFrame: 'camera_link', transform: { translation: [.3, 0, .1], rotation: [0, 0, 0, 1] } },
    }, 'rgb')
    close(camera.worldToSensor.transform.translation, [1.3, 0, .1])
    expect(camera).toMatchObject({ frameId: 'camera_link', calibrationId: 'test-v1', dataType: 'rgb' })
  })
})

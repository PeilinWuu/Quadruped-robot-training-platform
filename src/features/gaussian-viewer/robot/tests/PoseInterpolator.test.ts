import { describe, expect, it } from 'vitest'
import type { RobotPose } from '../../../../services/simulation/types'
import { HOME_JOINTS, JOINT_NAMES, LEGS } from '../minimalQuadrupedModel'
import { PoseInterpolator } from '../PoseInterpolator'
import {
  normalizeQuaternionTuple, sequenceIsNewer, shortestAngleLerp, slerpQuaternion,
} from '../robotMath'

function pose(sequence = 1, simulationTime = 0, position = 0): RobotPose {
  return {
    sequence, simulationTime, wallTime: 1,
    rootPosition: [position, position, position],
    rootOrientation: [0, 0, 0, 1],
    joints: HOME_JOINTS.map((joint) => ({ ...joint })),
  }
}

describe('minimal quadruped model', () => {
  it('matches all 12 MJCF joint names in exact order', () => {
    expect(JOINT_NAMES).toHaveLength(12)
    expect(JOINT_NAMES[0]).toBe('front_left_hip_abduction')
    expect(JOINT_NAMES[11]).toBe('rear_right_knee')
  })
  it('defines four independent three-joint legs', () => {
    expect(LEGS.map((leg) => leg.joints.length)).toEqual([3, 3, 3, 3])
    expect(new Set(LEGS.flatMap((leg) => [...leg.joints])).size).toBe(12)
  })
  it('places front and rear hips on opposite X sides', () => {
    expect(LEGS[0].hipPosition[0]).toBeGreaterThan(0)
    expect(LEGS[2].hipPosition[0]).toBeLessThan(0)
  })
  it('mirrors left and right hips after Y-up conversion', () => {
    expect(LEGS[0].hipPosition[2]).toBe(-LEGS[1].hipPosition[2])
    expect(LEGS[2].hipPosition[2]).toBe(-LEGS[3].hipPosition[2])
  })
  it('uses the MJCF home angles', () => {
    expect(HOME_JOINTS.slice(0, 3).map((joint) => joint.position)).toEqual([0, 0.55, -1.1])
  })
})
describe('pose validation and interpolation', () => {
  it('accepts a legal home pose', () => {
    const interpolator = new PoseInterpolator()
    expect(interpolator.push(pose())).toBe(true)
  })
  it('maps joints by name instead of array order', () => {
    const interpolator = new PoseInterpolator()
    const value = pose(); value.joints.reverse()
    expect(interpolator.push(value)).toBe(true)
    expect(interpolator.sample(1)?.joints.map((joint) => joint.name)).toEqual([...JOINT_NAMES])
  })
  it('rejects a missing joint', () => {
    const value = pose(); value.joints.pop()
    expect(new PoseInterpolator().push(value)).toBe(false)
  })
  it('rejects a duplicate joint', () => {
    const value = pose(); value.joints[1].name = value.joints[0].name
    expect(new PoseInterpolator().push(value)).toBe(false)
  })
  it('rejects an unknown joint', () => {
    const value = pose(); value.joints[0].name = 'unknown'
    expect(new PoseInterpolator().push(value)).toBe(false)
  })
  it('rejects non-finite roots and joints', () => {
    const root = pose(); root.rootPosition[0] = Number.NaN
    const joint = pose(); joint.joints[0].position = Number.POSITIVE_INFINITY
    expect(new PoseInterpolator().push(root)).toBe(false)
    expect(new PoseInterpolator().push(joint)).toBe(false)
  })
  it('rejects a zero quaternion', () => {
    const value = pose(); value.rootOrientation = [0, 0, 0, 0]
    expect(new PoseInterpolator().push(value)).toBe(false)
  })
  it('normalizes accepted quaternions', () => {
    const value = pose(); value.rootOrientation = [0, 0, 0, 2]
    const interpolator = new PoseInterpolator(); interpolator.push(value)
    expect(interpolator.sample()?.rootOrientation).toEqual([0, 0, 0, 1])
  })
  it('linearly interpolates root position', () => {
    const interpolator = new PoseInterpolator(0.05)
    interpolator.push(pose(1, 0, 0), 0); interpolator.push(pose(2, 0.1, 2), 0.1)
    expect(interpolator.sample(0.1)?.rootPosition[0]).toBeCloseTo(1)
  })
  it('slerps the root orientation', () => {
    const interpolator = new PoseInterpolator(0.05)
    const second = pose(2, 0.1); second.rootOrientation = [0, 1, 0, 0]
    interpolator.push(pose(1, 0), 0); interpolator.push(second, 0.1)
    expect(interpolator.sample(0.1)?.rootOrientation[1]).toBeCloseTo(Math.SQRT1_2)
  })
  it('uses the shortest joint angle across pi', () => {
    expect(shortestAngleLerp(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI)
  })
  it('ignores old and duplicate sequences', () => {
    const interpolator = new PoseInterpolator(); interpolator.push(pose(5, 1))
    expect(interpolator.push(pose(4, 2))).toBe(false)
    expect(interpolator.push(pose(5, 2))).toBe(false)
  })
  it('accepts a wrapped sequence', () => {
    expect(sequenceIsNewer(0, 0xffffffff)).toBe(true)
    const interpolator = new PoseInterpolator(); interpolator.push(pose(0xffffffff, 1))
    expect(interpolator.push(pose(0, 2))).toBe(true)
  })
  it('recognizes reset when simulation time returns to zero', () => {
    const interpolator = new PoseInterpolator(); interpolator.push(pose(10, 4))
    expect(interpolator.push(pose(11, 0))).toBe(true)
    expect(interpolator.size).toBe(1)
  })
  it('holds the last pose without extrapolation', () => {
    const interpolator = new PoseInterpolator(); interpolator.push(pose(1, 0, 3), 0)
    expect(interpolator.sample(100)?.rootPosition).toEqual([3, 3, 3])
  })
  it('pause naturally holds the last received pose', () => {
    const interpolator = new PoseInterpolator(); interpolator.push(pose(1, 1, 4), 1)
    expect(interpolator.sample(2)?.sequence).toBe(interpolator.sample(20)?.sequence)
  })
  it('keeps only the two most recent legal poses', () => {
    const interpolator = new PoseInterpolator()
    interpolator.push(pose(1, 1)); interpolator.push(pose(2, 2)); interpolator.push(pose(3, 3))
    expect(interpolator.size).toBe(2)
  })
  it('dispose clears all buffered state', () => {
    const interpolator = new PoseInterpolator(); interpolator.push(pose())
    interpolator.dispose()
    expect(interpolator.size).toBe(0); expect(interpolator.sample()).toBeNull()
  })
  it('quaternion helpers never return NaN', () => {
    expect(normalizeQuaternionTuple([1, 2, 3, 4])?.every(Number.isFinite)).toBe(true)
    expect(slerpQuaternion([0, 0, 0, 1], [0, 0, 0, -1], 0.5).every(Number.isFinite)).toBe(true)
  })
})

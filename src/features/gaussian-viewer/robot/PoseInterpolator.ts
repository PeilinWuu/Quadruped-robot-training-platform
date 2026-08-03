import type { JointPose, RobotPose } from '../../../services/simulation/types'
import { JOINT_NAMES } from './minimalQuadrupedModel'
import {
  finitePoseScalars, normalizeQuaternionTuple, sequenceIsNewer,
  shortestAngleLerp, slerpQuaternion,
} from './robotMath'

interface BufferedPose { pose: RobotPose; receivedAt: number; joints: Float64Array }

export class PoseInterpolator {
  private previous: BufferedPose | null = null
  private latest: BufferedPose | null = null
  private readonly jointIndex = new Map(JOINT_NAMES.map((name, index) => [name, index]))
  readonly delaySeconds: number

  constructor(delaySeconds = 0.032) { this.delaySeconds = delaySeconds }

  push(pose: RobotPose, receivedAt = performance.now() / 1000): boolean {
    const normalized = this.validate(pose, receivedAt)
    if (!normalized) return false
    if (this.latest) {
      const reset = pose.simulationTime < this.latest.pose.simulationTime
        && pose.simulationTime <= 0.01
      if (!reset && (!sequenceIsNewer(pose.sequence, this.latest.pose.sequence)
        || pose.simulationTime < this.latest.pose.simulationTime)) return false
      this.previous = reset ? null : this.latest
    }
    this.latest = normalized
    return true
  }

  sample(now = performance.now() / 1000): RobotPose | null {
    const latest = this.latest
    if (!latest) return null
    const previous = this.previous
    if (!previous || latest.pose.simulationTime <= previous.pose.simulationTime) return latest.pose
    const target = Math.min(
      latest.pose.simulationTime,
      latest.pose.simulationTime - this.delaySeconds + Math.max(0, now - latest.receivedAt),
    )
    const amount = Math.min(Math.max(
      (target - previous.pose.simulationTime)
        / (latest.pose.simulationTime - previous.pose.simulationTime),
      0,
    ), 1)
    const rotation = slerpQuaternion(
      previous.pose.rootOrientation,
      latest.pose.rootOrientation,
      amount,
    )
    const joints: JointPose[] = JOINT_NAMES.map((name, index) => ({
      name,
      position: shortestAngleLerp(previous.joints[index], latest.joints[index], amount),
    }))
    return {
      sequence: latest.pose.sequence,
      simulationTime: previous.pose.simulationTime
        + (latest.pose.simulationTime - previous.pose.simulationTime) * amount,
      wallTime: latest.pose.wallTime,
      rootPosition: previous.pose.rootPosition.map((value, index) =>
        value + (latest.pose.rootPosition[index] - value) * amount,
      ) as [number, number, number],
      rootOrientation: rotation,
      joints,
    }
  }

  reset(): void { this.previous = null; this.latest = null }
  dispose(): void { this.reset() }
  get size(): number { return Number(this.previous !== null) + Number(this.latest !== null) }

  private validate(pose: RobotPose, receivedAt: number): BufferedPose | null {
    if (!finitePoseScalars(pose) || !Number.isFinite(receivedAt)
      || pose.joints.length !== JOINT_NAMES.length) return null
    const orientation = normalizeQuaternionTuple(pose.rootOrientation)
    if (!orientation) return null
    const joints = new Float64Array(JOINT_NAMES.length)
    const seen = new Set<string>()
    for (const joint of pose.joints) {
      const index = this.jointIndex.get(joint.name as typeof JOINT_NAMES[number])
      if (index === undefined || seen.has(joint.name)) return null
      seen.add(joint.name)
      joints[index] = joint.position
    }
    return {
      receivedAt,
      joints,
      pose: {
        ...pose,
        rootPosition: [...pose.rootPosition],
        rootOrientation: orientation,
        joints: JOINT_NAMES.map((name, index) => ({ name, position: joints[index] })),
      },
    }
  }
}

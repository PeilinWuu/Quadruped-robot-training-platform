import type { RobotPose } from '../../../services/simulation/types'

export type QuaternionTuple = [number, number, number, number]

export function normalizeQuaternionTuple(value: readonly number[]): QuaternionTuple | null {
  if (value.length !== 4 || value.some((item) => !Number.isFinite(item))) return null
  const length = Math.hypot(value[0], value[1], value[2], value[3])
  if (length <= Number.EPSILON) return null
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length]
}
export function slerpQuaternion(
  from: QuaternionTuple,
  to: QuaternionTuple,
  amount: number,
): QuaternionTuple {
  let bx = to[0]; let by = to[1]; let bz = to[2]; let bw = to[3]
  let cosine = from[0] * bx + from[1] * by + from[2] * bz + from[3] * bw
  if (cosine < 0) { cosine = -cosine; bx = -bx; by = -by; bz = -bz; bw = -bw }
  if (cosine > 0.9995) {
    return normalizeQuaternionTuple([
      from[0] + amount * (bx - from[0]), from[1] + amount * (by - from[1]),
      from[2] + amount * (bz - from[2]), from[3] + amount * (bw - from[3]),
    ]) ?? [0, 0, 0, 1]
  }
  const angle = Math.acos(Math.min(Math.max(cosine, -1), 1))
  const sine = Math.sin(angle)
  const first = Math.sin((1 - amount) * angle) / sine
  const second = Math.sin(amount * angle) / sine
  return [
    first * from[0] + second * bx, first * from[1] + second * by,
    first * from[2] + second * bz, first * from[3] + second * bw,
  ]
}

export function shortestAngleLerp(from: number, to: number, amount: number): number {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + difference * amount
}

export function sequenceIsNewer(candidate: number, current: number): boolean {
  const difference = (candidate - current) >>> 0
  return difference !== 0 && difference < 0x80000000
}

export function finitePoseScalars(pose: RobotPose): boolean {
  return Number.isFinite(pose.simulationTime) && pose.simulationTime >= 0
    && Number.isFinite(pose.wallTime) && pose.wallTime >= 0
    && pose.rootPosition.every(Number.isFinite)
    && pose.rootOrientation.every(Number.isFinite)
    && pose.joints.every((joint) => Number.isFinite(joint.position))
}

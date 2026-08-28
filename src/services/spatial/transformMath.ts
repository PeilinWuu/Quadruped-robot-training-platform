import type { Quaternion, RigidTransform, Vector3 } from './types'

const EPSILON = 1e-12
export const IDENTITY_TRANSFORM: RigidTransform = {
  translation: [0, 0, 0], rotation: [0, 0, 0, 1],
}

export function normalizeQuaternion(value: readonly number[]): Quaternion {
  if (value.length !== 4 || value.some((item) => !Number.isFinite(item))) throw new Error('invalid quaternion')
  const length = Math.hypot(value[0], value[1], value[2], value[3])
  if (length <= EPSILON) throw new Error('invalid quaternion')
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length]
}

export function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  const [lx, ly, lz, lw] = left; const [rx, ry, rz, rw] = right
  return normalizeQuaternion([
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ])
}

export function inverseQuaternion(value: Quaternion): Quaternion {
  const normalized = normalizeQuaternion(value)
  return [-normalized[0], -normalized[1], -normalized[2], normalized[3]]
}

export function rotateVector(rotation: Quaternion, vector: Vector3): Vector3 {
  const [qx, qy, qz, qw] = normalizeQuaternion(rotation)
  const [vx, vy, vz] = vector
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ]
}

/** Compose T(parent→middle) with T(middle→child). */
export function composeTransforms(parentToMiddle: RigidTransform, middleToChild: RigidTransform): RigidTransform {
  const offset = rotateVector(parentToMiddle.rotation, middleToChild.translation)
  return {
    translation: [
      parentToMiddle.translation[0] + offset[0],
      parentToMiddle.translation[1] + offset[1],
      parentToMiddle.translation[2] + offset[2],
    ],
    rotation: multiplyQuaternions(parentToMiddle.rotation, middleToChild.rotation),
  }
}

export function invertTransform(value: RigidTransform): RigidTransform {
  const rotation = inverseQuaternion(value.rotation)
  const translation = rotateVector(rotation, [-value.translation[0], -value.translation[1], -value.translation[2]])
  return { translation, rotation }
}

export function transformPoint(transform: RigidTransform, point: Vector3): Vector3 {
  const rotated = rotateVector(transform.rotation, point)
  return [rotated[0] + transform.translation[0], rotated[1] + transform.translation[1], rotated[2] + transform.translation[2]]
}

export function yawFromQuaternion(value: Quaternion): number {
  const [x, y, z, w] = normalizeQuaternion(value)
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

export function quaternionFromRollPitchYaw(roll: number, pitch: number, yaw: number): Quaternion {
  if (![roll, pitch, yaw].every(Number.isFinite)) throw new Error('invalid roll/pitch/yaw')
  const cr = Math.cos(roll / 2); const sr = Math.sin(roll / 2)
  const cp = Math.cos(pitch / 2); const sp = Math.sin(pitch / 2)
  const cy = Math.cos(yaw / 2); const sy = Math.sin(yaw / 2)
  return normalizeQuaternion([
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ])
}

export function shortestAngleDifference(left: number, right: number): number {
  return Math.atan2(Math.sin(left - right), Math.cos(left - right))
}

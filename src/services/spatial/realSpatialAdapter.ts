import type { RealRobotTelemetry } from '../realRobotService'
import {
  composeTransforms, quaternionFromRollPitchYaw, rotateVector,
  shortestAngleDifference, yawFromQuaternion,
} from './transformMath'
import {
  SPATIAL_SCHEMA_VERSION, type CoordinateFrame, type Quaternion, type RobotSpatialState,
  type SpatialAlignmentError, type SpatialOriginAlignment, type Vector3,
} from './types'

function vector3(value: readonly number[] | undefined): Vector3 | null {
  if (!value || value.length < 3 || value.slice(0, 3).some((item) => !Number.isFinite(item))) return null
  return [value[0], value[1], value[2]]
}

function frame(parentFrame: string, childFrame: string, translation: Vector3, rotation: Quaternion): CoordinateFrame {
  return { parentFrame, childFrame, transform: { translation, rotation } }
}

/**
 * Unitree Sport position and IMU RPY are treated as ROS-style X-forward,
 * Y-left, Z-up local odometry. This assumption remains low confidence until
 * checked against a measured physical trajectory.
 */
export function spatialStateFromRealTelemetry(
  telemetry: RealRobotTelemetry | null,
  telemetryAgeMs: number | null,
  hostTimestampMs = Date.now(),
): RobotSpatialState | null {
  const position = vector3(telemetry?.sportModeState?.position)
  const velocity = vector3(telemetry?.sportModeState?.velocity)
  const rpy = vector3(telemetry?.lowState?.rpy)
  if (!position || !rpy) return null
  const age = telemetryAgeMs !== null && Number.isFinite(telemetryAgeMs) ? Math.max(0, telemetryAgeMs) : 0
  return {
    schemaVersion: SPATIAL_SCHEMA_VERSION,
    source: 'real', sequence: telemetry?.lowState?.tick ?? 0,
    sourceTimestampMs: hostTimestampMs - age, hostTimestampMs,
    worldToOdom: frame('world', 'real_odom', [0, 0, 0], [0, 0, 0, 1]),
    odomToBase: frame('real_odom', 'base_link', position, quaternionFromRollPitchYaw(rpy[0], rpy[1], rpy[2])),
    linearVelocityWorld: velocity,
    angularVelocityWorld: telemetry?.sportModeState && Number.isFinite(telemetry.sportModeState.yawSpeed)
      ? [0, 0, telemetry.sportModeState.yawSpeed] : null,
    confidence: 'low',
  }
}

function worldToBase(state: RobotSpatialState) {
  return composeTransforms(state.worldToOdom.transform, state.odomToBase.transform)
}

/** Aligns translation and yaw while keeping gravity/up independent of momentary roll/pitch. */
export function createSpatialOriginAlignment(
  real: RobotSpatialState,
  reference: RobotSpatialState,
  createdAtMs = Date.now(),
): SpatialOriginAlignment {
  if (real.source !== 'real') throw new Error('origin alignment requires a real spatial state')
  const realBase = worldToBase(real)
  const referenceBase = worldToBase(reference)
  const yawDelta = shortestAngleDifference(yawFromQuaternion(referenceBase.rotation), yawFromQuaternion(realBase.rotation))
  const rotation = quaternionFromRollPitchYaw(0, 0, yawDelta)
  const rotatedReal = rotateVector(rotation, real.odomToBase.transform.translation)
  const translation: Vector3 = [
    referenceBase.translation[0] - rotatedReal[0],
    referenceBase.translation[1] - rotatedReal[1],
    referenceBase.translation[2] - rotatedReal[2],
  ]
  return {
    createdAtMs, realSequence: real.sequence, referenceSequence: reference.sequence,
    worldToRealOdom: frame('world', 'real_odom', translation, rotation),
  }
}

export function applySpatialOriginAlignment(real: RobotSpatialState, alignment: SpatialOriginAlignment): RobotSpatialState {
  return { ...real, worldToOdom: alignment.worldToRealOdom }
}

export function spatialAlignmentError(real: RobotSpatialState, reference: RobotSpatialState): SpatialAlignmentError {
  const actual = worldToBase(real); const expected = worldToBase(reference)
  const translation: Vector3 = [
    actual.translation[0] - expected.translation[0],
    actual.translation[1] - expected.translation[1],
    actual.translation[2] - expected.translation[2],
  ]
  return {
    translation,
    distance: Math.hypot(...translation),
    yaw: shortestAngleDifference(yawFromQuaternion(actual.rotation), yawFromQuaternion(expected.rotation)),
  }
}

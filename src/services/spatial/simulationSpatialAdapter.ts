import type { RobotPose, RobotTelemetry } from '../simulation/types'
import { composeTransforms, IDENTITY_TRANSFORM, multiplyQuaternions, inverseQuaternion } from './transformMath'
import {
  SPATIAL_SCHEMA_VERSION, type CoordinateFrame, type Quaternion, type RobotSpatialState,
  type SensorDataType, type SensorExtrinsic, type SensorFrame, type Vector3,
} from './types'

// Same basis change already verified by quadruped_ros_bridge:
// PlayCanvas/MuJoCo viewer (X right, Y up, Z back) -> ROS (X forward, Y left, Z up).
const OUTPUT_TO_ROS: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]

export function viewerVectorToRos(value: Vector3): Vector3 {
  return [value[0], -value[2], value[1]]
}

export function viewerQuaternionToRos(value: Quaternion): Quaternion {
  return multiplyQuaternions(multiplyQuaternions(OUTPUT_TO_ROS, value), inverseQuaternion(OUTPUT_TO_ROS))
}

function frame(parentFrame: string, childFrame: string, translation: Vector3, rotation: Quaternion): CoordinateFrame {
  return { parentFrame, childFrame, transform: { translation, rotation } }
}

export function spatialStateFromSimulationPose(pose: RobotPose, hostTimestampMs = Date.now()): RobotSpatialState {
  return {
    schemaVersion: SPATIAL_SCHEMA_VERSION,
    source: 'simulation', sequence: pose.sequence,
    sourceTimestampMs: pose.wallTime, hostTimestampMs,
    worldToOdom: frame('world', 'odom', [...IDENTITY_TRANSFORM.translation], [...IDENTITY_TRANSFORM.rotation]),
    odomToBase: frame('odom', 'base_link', viewerVectorToRos(pose.rootPosition), viewerQuaternionToRos(pose.rootOrientation)),
    linearVelocityWorld: null, angularVelocityWorld: null,
    confidence: 'high',
  }
}

export function spatialStateFromSimulationTelemetry(telemetry: RobotTelemetry, hostTimestampMs = Date.now()): RobotSpatialState {
  const pose: RobotPose = {
    sequence: telemetry.sequence, simulationTime: telemetry.simulationTime, wallTime: telemetry.wallTime,
    rootPosition: telemetry.root.position, rootOrientation: telemetry.root.orientation, joints: [],
  }
  return {
    ...spatialStateFromSimulationPose(pose, hostTimestampMs),
    linearVelocityWorld: viewerVectorToRos(telemetry.root.linearVelocityWorld),
    angularVelocityWorld: viewerVectorToRos(telemetry.root.angularVelocityWorld),
  }
}

export function sensorFrameFromSpatialState(
  state: RobotSpatialState,
  extrinsic: SensorExtrinsic,
  dataType: SensorDataType,
): SensorFrame {
  if (extrinsic.baseToSensor.parentFrame !== 'base_link') throw new Error('sensor extrinsic must start at base_link')
  const worldToBase = composeTransforms(state.worldToOdom.transform, state.odomToBase.transform)
  const worldToSensor = composeTransforms(worldToBase, extrinsic.baseToSensor.transform)
  return {
    schemaVersion: SPATIAL_SCHEMA_VERSION,
    source: state.source, sensorId: extrinsic.sensorId,
    frameId: extrinsic.baseToSensor.childFrame,
    sequence: state.sequence, sourceTimestampMs: state.sourceTimestampMs, hostTimestampMs: state.hostTimestampMs,
    worldToSensor: frame('world', extrinsic.baseToSensor.childFrame, worldToSensor.translation, worldToSensor.rotation),
    dataType, calibrationId: extrinsic.calibrationId,
  }
}

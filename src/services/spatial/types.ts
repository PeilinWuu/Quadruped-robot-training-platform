export type Vector3 = [number, number, number]
/** Quaternion order is always [x, y, z, w]. */
export type Quaternion = [number, number, number, number]
export type SpatialSource = 'simulation' | 'real'
export type SpatialConfidence = 'unknown' | 'low' | 'medium' | 'high'

export const SPATIAL_SCHEMA_VERSION = 1 as const
export const ROS_COORDINATE_CONVENTION = {
  handedness: 'right-handed',
  linearUnit: 'meter',
  angularUnit: 'radian',
  quaternionOrder: 'xyzw',
  forwardAxis: '+x',
  leftAxis: '+y',
  upAxis: '+z',
} as const

export interface RigidTransform {
  translation: Vector3
  rotation: Quaternion
}

export interface CoordinateFrame {
  parentFrame: string
  childFrame: string
  transform: RigidTransform
}

export interface RobotSpatialState {
  schemaVersion: typeof SPATIAL_SCHEMA_VERSION
  source: SpatialSource
  sequence: number
  sourceTimestampMs: number
  hostTimestampMs: number
  worldToOdom: CoordinateFrame
  odomToBase: CoordinateFrame
  linearVelocityWorld: Vector3 | null
  angularVelocityWorld: Vector3 | null
  confidence: SpatialConfidence
}

export interface SpatialOriginAlignment {
  createdAtMs: number
  realSequence: number
  referenceSequence: number
  worldToRealOdom: CoordinateFrame
}

export interface SpatialAlignmentError {
  translation: Vector3
  distance: number
  yaw: number
}

export type SensorDataType = 'rgb' | 'depth' | 'point-cloud'

export interface SensorExtrinsic {
  sensorId: string
  calibrationId: string
  baseToSensor: CoordinateFrame
}

export interface SensorFrame {
  schemaVersion: typeof SPATIAL_SCHEMA_VERSION
  source: SpatialSource
  sensorId: string
  frameId: string
  sequence: number
  sourceTimestampMs: number
  hostTimestampMs: number
  worldToSensor: CoordinateFrame
  dataType: SensorDataType
  calibrationId: string
}

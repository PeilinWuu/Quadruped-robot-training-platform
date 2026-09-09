import type { RobotPose, SimulationModelId } from '../../../services/simulation/types'
import type { Entity } from 'playcanvas'

export interface RobotBounds { center: [number, number, number]; radius: number }
export interface RobotRig {
  readonly robotRoot: Entity
  readonly modelId: SimulationModelId
  readonly primitiveCount: number
  readonly entityCount: number
  readonly jointNames: readonly string[]
  acceptsPose(pose: RobotPose): boolean
  applyPose(pose: RobotPose): void
  getBounds(): RobotBounds
  dispose(): void
}

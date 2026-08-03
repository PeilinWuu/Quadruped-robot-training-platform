import type { Application, Entity } from 'playcanvas'
import type { SimulationModelId } from '../../../services/simulation/types'
import { Go2PrimitiveRig } from './Go2PrimitiveRig'
import { MinimalQuadrupedRig } from './MinimalQuadrupedRig'
import type { RobotRig } from './RobotRig'

export function createRobotRig(modelId: SimulationModelId, app: Application, parent: Entity): RobotRig {
  if (modelId === 'unitree-go2-menagerie') return new Go2PrimitiveRig(app, parent)
  if (modelId === 'minimal-quadruped-v1') return new MinimalQuadrupedRig(app, parent)
  throw new Error('UNKNOWN_ROBOT_RIG')
}

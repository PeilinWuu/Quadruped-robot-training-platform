import type { Application, Entity } from 'playcanvas'
import type { SimulationModelId } from '../../../services/simulation/types'
import { Go2PrimitiveRig } from './Go2PrimitiveRig'
import { Go2MeshRig } from './Go2MeshRig'
import type { Go2VisualAssetCache } from './Go2VisualAssetCache'
import type { Go2VisualMode } from './go2VisualManifest'
import { MinimalQuadrupedRig } from './MinimalQuadrupedRig'
import type { RobotRig } from './RobotRig'

export function createRobotRig(modelId: SimulationModelId, app: Application, parent: Entity, cache?: Go2VisualAssetCache, mode: Go2VisualMode = 'official-mesh'): RobotRig {
  if (modelId === 'unitree-go2-menagerie') return cache ? new Go2MeshRig(app, parent, cache, mode) : new Go2PrimitiveRig(app, parent)
  if (modelId === 'minimal-quadruped-v1') return new MinimalQuadrupedRig(app, parent)
  throw new Error('UNKNOWN_ROBOT_RIG')
}

import { Application, Color, Entity, StandardMaterial } from 'playcanvas'
import type { RobotPose } from '../../../services/simulation/types'
import { GO2_JOINT_NAMES, GO2_LEGS, Go2Skeleton } from './go2RigDefinition'
import type { RobotBounds, RobotRig } from './RobotRig'

export { GO2_JOINT_NAMES } from './go2RigDefinition'

export class Go2PrimitiveRig implements RobotRig {
  readonly modelId = 'unitree-go2-menagerie' as const
  readonly jointNames = GO2_JOINT_NAMES
  readonly primitiveCount = 19
  readonly entityCount = 32
  readonly robotRoot: Entity
  readonly skeleton: Go2Skeleton
  private readonly appearanceRoot: Entity
  private readonly boundsEntities: Entity[] = []
  private readonly materials: StandardMaterial[]
  private disposed = false

  constructor(app: Application, parent: Entity) {
    this.skeleton = new Go2Skeleton(app, parent); this.robotRoot = this.skeleton.robotRoot
    this.appearanceRoot = new Entity('Go2 Primitive Appearance', app); this.robotRoot.addChild(this.appearanceRoot)
    this.materials = [this.material(new Color(.12, .15, .18)), this.material(new Color(.68, .7, .72)), this.material(new Color(.08, .37, .52))]
    this.primitive(app, 'Go2 trunk', 'box', this.appearanceRoot, [0, 0, 0], [.3762, .114, .0935], this.materials[0])
    this.primitive(app, 'Go2 head', 'capsule', this.appearanceRoot, [.25, .015, 0], [.09, .08, .08], this.materials[2])
    this.primitive(app, 'Go2 head cap', 'sphere', this.appearanceRoot, [.31, .015, 0], [.075, .075, .075], this.materials[2])
    for (const definition of GO2_LEGS) {
      const hip = this.skeleton.bodyNodes.get(`${definition.name}_hip`)!; const thigh = this.skeleton.bodyNodes.get(`${definition.name}_thigh`)!; const calf = this.skeleton.bodyNodes.get(`${definition.name}_calf`)!
      this.primitive(app, `${definition.name} hip`, 'capsule', hip, [0, 0, definition.name.endsWith('L') ? -.04775 : .04775], [.055, .055, .12], this.materials[1])
      this.primitive(app, `${definition.name} thigh`, 'capsule', thigh, [0, -.1065, 0], [.055, .14, .055], this.materials[0])
      this.primitive(app, `${definition.name} calf`, 'capsule', calf, [0, -.1065, 0], [.045, .14, .045], this.materials[1])
      this.primitive(app, `${definition.name} foot`, 'sphere', calf, [0, -.213, 0], [.044, .044, .044], this.materials[2])
    }
  }
  acceptsPose(pose: RobotPose): boolean { return this.skeleton.acceptsPose(pose) }
  applyPose(pose: RobotPose): void { if (!this.disposed && this.acceptsPose(pose)) this.skeleton.applyPose(pose) }
  setPrimitivesVisible(visible: boolean): void { this.appearanceRoot.enabled = visible }
  getBodyNode(name: string): Entity | undefined { return this.skeleton.bodyNodes.get(name) }
  getBounds(): RobotBounds {
    if (!this.boundsEntities.length) return { center: [0, 0, 0], radius: 0 }
    let minX = Infinity; let minY = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
    for (const entity of this.boundsEntities) { const p = entity.getPosition(); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z) }
    const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
    return { center, radius: Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + .12, .3) }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.skeleton.dispose(); this.materials.forEach((material) => material.destroy()); this.boundsEntities.length = 0 }
  private material(color: Color): StandardMaterial { const material = new StandardMaterial(); material.diffuse = color; material.metalness = .18; material.gloss = .6; material.update(); return material }
  private primitive(app: Application, name: string, type: 'box' | 'capsule' | 'sphere', parent: Entity, position: readonly number[], scale: readonly number[], material: StandardMaterial): void { const entity = new Entity(name, app); entity.setLocalPosition(position[0], position[1], position[2]); entity.setLocalScale(scale[0], scale[1], scale[2]); parent.addChild(entity); entity.addComponent('render', { type, material }); this.boundsEntities.push(entity) }
}

import { Application, Color, Entity, Quat, StandardMaterial, Vec3 } from 'playcanvas'
import type { RobotPose } from '../../../services/simulation/types'
import type { RobotBounds, RobotRig } from './RobotRig'

export const GO2_JOINT_NAMES = [
  'FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint',
  'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint',
  'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint',
  'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint',
] as const

const LEGS = [
  { name: 'FL', hip: [0.1934, 0, -0.0465], thigh: [0, 0, -0.0955], joints: GO2_JOINT_NAMES.slice(0, 3) },
  { name: 'FR', hip: [0.1934, 0, 0.0465], thigh: [0, 0, 0.0955], joints: GO2_JOINT_NAMES.slice(3, 6) },
  { name: 'RL', hip: [-0.1934, 0, -0.0465], thigh: [0, 0, -0.0955], joints: GO2_JOINT_NAMES.slice(6, 9) },
  { name: 'RR', hip: [-0.1934, 0, 0.0465], thigh: [0, 0, 0.0955], joints: GO2_JOINT_NAMES.slice(9, 12) },
] as const

interface LegRig { hip: Entity; thigh: Entity; calf: Entity; joints: readonly string[] }

export class Go2PrimitiveRig implements RobotRig {
  readonly modelId = 'unitree-go2-menagerie' as const
  readonly jointNames = GO2_JOINT_NAMES
  readonly primitiveCount = 19
  readonly entityCount = 32
  readonly robotRoot: Entity
  private readonly app: Application
  private readonly legs: LegRig[] = []
  private readonly boundsEntities: Entity[] = []
  private readonly materials: StandardMaterial[]
  private readonly axisX = new Vec3(1, 0, 0)
  // MuJoCo +Y becomes PlayCanvas -Z under (x,y,z) -> (x,z,-y).
  private readonly axisNegativeZ = new Vec3(0, 0, -1)
  private readonly rotation = new Quat()
  private disposed = false

  constructor(app: Application, parent: Entity) {
    this.app = app
    this.robotRoot = new Entity('Unitree Go2 Robot Root', app)
    parent.addChild(this.robotRoot)
    this.materials = [this.material(new Color(.12, .15, .18)), this.material(new Color(.68, .7, .72)), this.material(new Color(.08, .37, .52))]
    // Dimensions follow the official collision geoms; meshes remain MuJoCo-only resources.
    this.primitive('Go2 trunk', 'box', this.robotRoot, [0, 0, 0], [.3762, .114, .0935], this.materials[0])
    this.primitive('Go2 head', 'capsule', this.robotRoot, [.25, .015, 0], [.09, .08, .08], this.materials[2])
    this.primitive('Go2 head cap', 'sphere', this.robotRoot, [.31, .015, 0], [.075, .075, .075], this.materials[2])
    for (const definition of LEGS) {
      const hip = this.pivot(`${definition.name} hip body`, this.robotRoot, definition.hip)
      this.primitive(`${definition.name} hip`, 'capsule', hip, [0, 0, definition.name.endsWith('L') ? -.04775 : .04775], [.055, .055, .12], this.materials[1])
      const thigh = this.pivot(`${definition.name} thigh body`, hip, definition.thigh)
      this.primitive(`${definition.name} thigh`, 'capsule', thigh, [0, -.1065, 0], [.055, .14, .055], this.materials[0])
      const calf = this.pivot(`${definition.name} calf body`, thigh, [0, -.213, 0])
      this.primitive(`${definition.name} calf`, 'capsule', calf, [0, -.1065, 0], [.045, .14, .045], this.materials[1])
      this.primitive(`${definition.name} foot`, 'sphere', calf, [0, -.213, 0], [.044, .044, .044], this.materials[2])
      this.legs.push({ hip, thigh, calf, joints: definition.joints })
    }
  }

  acceptsPose(pose: RobotPose): boolean {
    return pose.joints.length === 12 && pose.joints.every((joint, index) => joint.name === GO2_JOINT_NAMES[index])
  }
  applyPose(pose: RobotPose): void {
    if (this.disposed || !this.acceptsPose(pose)) return
    this.robotRoot.setLocalPosition(...pose.rootPosition)
    this.robotRoot.setLocalRotation(...pose.rootOrientation)
    const values = new Map(pose.joints.map((joint) => [joint.name, joint.position]))
    for (const leg of this.legs) {
      this.rotate(leg.hip, this.axisX, values.get(leg.joints[0]) ?? 0)
      this.rotate(leg.thigh, this.axisNegativeZ, values.get(leg.joints[1]) ?? 0)
      this.rotate(leg.calf, this.axisNegativeZ, values.get(leg.joints[2]) ?? 0)
    }
  }
  getBounds(): RobotBounds {
    if (!this.boundsEntities.length) return { center: [0, 0, 0], radius: 0 }
    let minX = Infinity; let minY = Infinity; let minZ = Infinity; let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
    for (const entity of this.boundsEntities) { const p = entity.getPosition(); minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); minZ = Math.min(minZ, p.z); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxZ = Math.max(maxZ, p.z) }
    const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
    return { center, radius: Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + .12, .3) }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.robotRoot.destroy(); this.materials.forEach((material) => material.destroy()); this.legs.length = 0; this.boundsEntities.length = 0 }
  private material(color: Color): StandardMaterial { const material = new StandardMaterial(); material.diffuse = color; material.metalness = .18; material.gloss = .6; material.update(); return material }
  private pivot(name: string, parent: Entity, position: readonly number[]): Entity { const entity = new Entity(name, this.app); entity.setLocalPosition(position[0], position[1], position[2]); parent.addChild(entity); return entity }
  private primitive(name: string, type: 'box' | 'capsule' | 'sphere', parent: Entity, position: readonly number[], scale: readonly number[], material: StandardMaterial): Entity { const entity = this.pivot(name, parent, position); entity.setLocalScale(scale[0], scale[1], scale[2]); entity.addComponent('render', { type, material }); this.boundsEntities.push(entity); return entity }
  private rotate(entity: Entity, axis: Vec3, radians: number): void { this.rotation.setFromAxisAngle(axis, radians * 180 / Math.PI).normalize(); entity.setLocalRotation(this.rotation) }
}

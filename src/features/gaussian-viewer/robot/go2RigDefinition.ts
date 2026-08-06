import { Application, Entity, Quat, Vec3 } from 'playcanvas'
import type { RobotPose } from '../../../services/simulation/types'

export const GO2_JOINT_NAMES = [
  'FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint',
  'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint',
  'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint',
  'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint',
] as const

export const GO2_LEGS = [
  { name: 'FL', hip: [0.1934, 0, -0.0465], thigh: [0, 0, -0.0955], joints: GO2_JOINT_NAMES.slice(0, 3) },
  { name: 'FR', hip: [0.1934, 0, 0.0465], thigh: [0, 0, 0.0955], joints: GO2_JOINT_NAMES.slice(3, 6) },
  { name: 'RL', hip: [-0.1934, 0, -0.0465], thigh: [0, 0, -0.0955], joints: GO2_JOINT_NAMES.slice(6, 9) },
  { name: 'RR', hip: [-0.1934, 0, 0.0465], thigh: [0, 0, 0.0955], joints: GO2_JOINT_NAMES.slice(9, 12) },
] as const

interface LegNodes { hip: Entity; thigh: Entity; calf: Entity; joints: readonly string[] }

export class Go2Skeleton {
  readonly robotRoot: Entity
  readonly bodyNodes = new Map<string, Entity>()
  private readonly legs: LegNodes[] = []
  private readonly axisX = new Vec3(1, 0, 0)
  private readonly axisNegativeZ = new Vec3(0, 0, -1)
  private readonly rotation = new Quat()

  constructor(app: Application, parent: Entity) {
    this.robotRoot = new Entity('Unitree Go2 Robot Root', app)
    parent.addChild(this.robotRoot)
    this.bodyNodes.set('base', this.robotRoot)
    for (const definition of GO2_LEGS) {
      const hip = this.pivot(app, `${definition.name} hip body`, this.robotRoot, definition.hip)
      const thigh = this.pivot(app, `${definition.name} thigh body`, hip, definition.thigh)
      const calf = this.pivot(app, `${definition.name} calf body`, thigh, [0, -.213, 0])
      this.bodyNodes.set(`${definition.name}_hip`, hip)
      this.bodyNodes.set(`${definition.name}_thigh`, thigh)
      this.bodyNodes.set(`${definition.name}_calf`, calf)
      this.legs.push({ hip, thigh, calf, joints: definition.joints })
    }
  }

  acceptsPose(pose: RobotPose): boolean {
    return pose.joints.length === 12 && pose.joints.every((joint, index) => joint.name === GO2_JOINT_NAMES[index])
  }

  applyPose(pose: RobotPose): void {
    this.robotRoot.setLocalPosition(...pose.rootPosition)
    this.robotRoot.setLocalRotation(...pose.rootOrientation)
    const values = new Map(pose.joints.map((joint) => [joint.name, joint.position]))
    for (const leg of this.legs) {
      this.rotate(leg.hip, this.axisX, values.get(leg.joints[0]) ?? 0)
      this.rotate(leg.thigh, this.axisNegativeZ, values.get(leg.joints[1]) ?? 0)
      this.rotate(leg.calf, this.axisNegativeZ, values.get(leg.joints[2]) ?? 0)
    }
  }

  dispose(): void { this.robotRoot.destroy(); this.bodyNodes.clear(); this.legs.length = 0 }
  private pivot(app: Application, name: string, parent: Entity, position: readonly number[]): Entity {
    const entity = new Entity(name, app); entity.setLocalPosition(position[0], position[1], position[2]); parent.addChild(entity); return entity
  }
  private rotate(entity: Entity, axis: Vec3, radians: number): void {
    this.rotation.setFromAxisAngle(axis, radians * 180 / Math.PI).normalize(); entity.setLocalRotation(this.rotation)
  }
}

export function mujocoPositionToPlayCanvas(value: readonly number[]): [number, number, number] {
  return [value[0], value[2], -value[1]]
}

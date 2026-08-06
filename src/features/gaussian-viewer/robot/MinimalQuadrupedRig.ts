import {
  Application, Color, Entity, Quat, StandardMaterial, Vec3,
} from 'playcanvas'
import type { RobotPose } from '../../../services/simulation/types'
import { JOINT_NAMES, LEGS } from './minimalQuadrupedModel'
import type { RobotRig, RobotBounds } from './RobotRig'

interface LegEntities { abduction: Entity; flexion: Entity; knee: Entity }

export class MinimalQuadrupedRig implements RobotRig {
  readonly modelId = 'minimal-quadruped-v1' as const
  readonly jointNames = JOINT_NAMES
  readonly robotRoot: Entity
  readonly primitiveCount = 18
  readonly entityCount = 31
  private readonly legs = new Map<string, LegEntities>()
  private readonly boundsEntities: Entity[] = []
  private readonly materials: StandardMaterial[]
  private readonly axisX = new Vec3(1, 0, 0)
  private readonly axisNegativeZ = new Vec3(0, 0, -1)
  private readonly jointRotation = new Quat()
  private readonly app: Application
  private disposed = false

  constructor(app: Application, parent: Entity) {
    this.app = app
    this.robotRoot = new Entity('MuJoCo Robot Root', app)
    parent.addChild(this.robotRoot)
    this.materials = [
      this.material(new Color(0.16, 0.48, 0.68), new Color(0.02, 0.11, 0.17)),
      this.material(new Color(0.75, 0.79, 0.82), new Color(0.08, 0.09, 0.1)),
      this.material(new Color(0.95, 0.47, 0.18), new Color(0.14, 0.04, 0.01)),
    ]
    this.primitive('Torso', 'box', this.robotRoot, [0, 0, 0], [0.52, 0.18, 0.26], this.materials[0])
    this.primitive('Head', 'sphere', this.robotRoot, [0.29, 0.02, 0], [0.15, 0.15, 0.15], this.materials[2])

    for (const definition of LEGS) {
      const abduction = this.pivot(`${definition.name} hip abduction`, this.robotRoot, definition.hipPosition)
      this.primitive(`${definition.name} hip`, 'sphere', abduction, [0, 0, 0], [0.09, 0.09, 0.09], this.materials[1])
      const flexion = this.pivot(`${definition.name} hip flexion`, abduction, definition.thighPosition)
      this.primitive(`${definition.name} thigh`, 'capsule', flexion, [0, -0.11, 0], [0.07, 0.145, 0.07], this.materials[0])
      const knee = this.pivot(`${definition.name} knee`, flexion, [0, -0.22, 0])
      this.primitive(`${definition.name} shin`, 'capsule', knee, [0, -0.11, 0], [0.06, 0.14, 0.06], this.materials[1])
      this.primitive(`${definition.name} foot`, 'sphere', knee, [0, -0.23, 0], [0.08, 0.08, 0.08], this.materials[2])
      this.legs.set(definition.name, { abduction, flexion, knee })
    }
  }

  applyPose(pose: RobotPose): void {
    if (this.disposed) return
    this.robotRoot.setLocalPosition(...pose.rootPosition)
    this.robotRoot.setLocalRotation(...pose.rootOrientation)
    const values = new Map(pose.joints.map((joint) => [joint.name, joint.position]))
    for (const definition of LEGS) {
      const leg = this.legs.get(definition.name)
      if (!leg) continue
      this.rotate(leg.abduction, this.axisX, values.get(definition.joints[0]) ?? 0)
      this.rotate(leg.flexion, this.axisNegativeZ, values.get(definition.joints[1]) ?? 0)
      this.rotate(leg.knee, this.axisNegativeZ, values.get(definition.joints[2]) ?? 0)
    }
  }
  acceptsPose(pose: RobotPose): boolean { return hasExactQuadrupedJoints(pose) }

  getBounds(): RobotBounds {
    if (this.boundsEntities.length === 0) return { center: [0, 0, 0], radius: 0 }
    let minX = Infinity; let minY = Infinity; let minZ = Infinity
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
    for (const entity of this.boundsEntities) {
      const point = entity.getPosition()
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); minZ = Math.min(minZ, point.z)
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); maxZ = Math.max(maxZ, point.z)
    }
    const center: [number, number, number] = [
      (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
    ]
    const radius = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 0.15, 0.25)
    return { center, radius }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.robotRoot.destroy()
    for (const material of this.materials) material.destroy()
    this.legs.clear()
    this.boundsEntities.length = 0
  }

  private material(diffuse: Color, emissive: Color): StandardMaterial {
    const material = new StandardMaterial()
    material.diffuse = diffuse
    material.emissive = emissive
    material.metalness = 0.15
    material.gloss = 0.65
    material.update()
    return material
  }

  private pivot(name: string, parent: Entity, position: [number, number, number]): Entity {
    const entity = new Entity(name, this.app)
    entity.setLocalPosition(...position)
    parent.addChild(entity)
    return entity
  }

  private primitive(
    name: string,
    type: 'box' | 'capsule' | 'sphere',
    parent: Entity,
    position: [number, number, number],
    scale: [number, number, number],
    material: StandardMaterial,
  ): Entity {
    const entity = this.pivot(name, parent, position)
    entity.setLocalScale(...scale)
    entity.addComponent('render', { type, material })
    this.boundsEntities.push(entity)
    return entity
  }

  private rotate(entity: Entity, axis: Vec3, radians: number): void {
    this.jointRotation.setFromAxisAngle(axis, radians * 180 / Math.PI).normalize()
    entity.setLocalRotation(this.jointRotation)
  }
}

export function hasExactQuadrupedJoints(pose: RobotPose): boolean {
  if (pose.joints.length !== JOINT_NAMES.length) return false
  const names = new Set(pose.joints.map((joint) => joint.name))
  return JOINT_NAMES.every((name) => names.has(name)) && names.size === JOINT_NAMES.length
}

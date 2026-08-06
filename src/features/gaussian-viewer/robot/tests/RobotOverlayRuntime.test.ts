import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Application } from 'playcanvas'
import type { RobotPose } from '../../../../services/simulation/types'
import { HOME_JOINTS } from '../minimalQuadrupedModel'

const fakes = vi.hoisted(() => {
  class Vec3 {
    x: number; y: number; z: number
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  }
  class Quat {
    x: number; y: number; z: number; w: number
    axis: Vec3 | null = null; angle = 0
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w }
    setFromAxisAngle(axis: Vec3, angle: number) { this.axis = axis; this.angle = angle; return this }
    normalize() { return this }
  }
  class Color { constructor(..._values: number[]) {} }
  class StandardMaterial {
    diffuse: unknown; emissive: unknown; metalness = 0; gloss = 0; destroyed = false
    update() { return undefined }
    destroy() { this.destroyed = true }
  }
  class Entity {
    static created = 0
    children: Entity[] = []
    parent: Entity | null = null
    enabled = true
    destroyed = false
    position = new Vec3()
    rotation = new Quat()
    scale = new Vec3(1, 1, 1)
    readonly name: string
    constructor(name: string) { this.name = name; Entity.created += 1 }
    addChild(child: Entity) { child.parent = this; this.children.push(child) }
    addComponent() { return undefined }
    setLocalPosition(x: number, y: number, z: number) { this.position = new Vec3(x, y, z) }
    setLocalRotation(x: number | Quat, y?: number, z?: number, w?: number) {
      if (x instanceof Quat) {
        this.rotation = new Quat(x.x, x.y, x.z, x.w)
        this.rotation.axis = x.axis ? new Vec3(x.axis.x, x.axis.y, x.axis.z) : null
        this.rotation.angle = x.angle
      } else this.rotation = new Quat(x, y, z, w)
    }
    setLocalScale(x: number, y: number, z: number) { this.scale = new Vec3(x, y, z) }
    getPosition() {
      let x = this.position.x; let y = this.position.y; let z = this.position.z
      let ancestor = this.parent
      while (ancestor) { x += ancestor.position.x; y += ancestor.position.y; z += ancestor.position.z; ancestor = ancestor.parent }
      return new Vec3(x, y, z)
    }
    destroy() { this.destroyed = true; this.enabled = false }
  }
  return { Vec3, Quat, Color, StandardMaterial, Entity }
})

vi.mock('playcanvas', () => fakes)

function pose(): RobotPose {
  return {
    sequence: 1, simulationTime: 0, wallTime: 1,
    rootPosition: [0, 0.58, 0], rootOrientation: [0, 0, 0, 1],
    joints: HOME_JOINTS.map((joint) => ({ ...joint })),
  }
}
function go2Pose(): RobotPose {
  const names = ['FL_hip_joint', 'FL_thigh_joint', 'FL_calf_joint', 'FR_hip_joint', 'FR_thigh_joint', 'FR_calf_joint', 'RL_hip_joint', 'RL_thigh_joint', 'RL_calf_joint', 'RR_hip_joint', 'RR_thigh_joint', 'RR_calf_joint']
  return { sequence: 1, simulationTime: 0, wallTime: 1, rootPosition: [1, 2, 3], rootOrientation: [0, 0, 0, 1], joints: names.map((name, index) => ({ name, position: index % 3 === 0 ? 0 : index % 3 === 1 ? .9 : -1.8 })) }
}

describe('RobotOverlayRuntime lifecycle', () => {
  beforeEach(() => { fakes.Entity.created = 0 })

  async function runtime() {
    const root = new fakes.Entity('Application Root')
    const app = { root } as unknown as Application
    const { RobotOverlayRuntime } = await import('../RobotOverlayRuntime')
    return { overlay: new RobotOverlayRuntime(app, 'minimal-quadruped-v1'), root }
  }

  it('creates exactly one independent overlay root', async () => {
    const { overlay, root } = await runtime()
    expect(root.children).toHaveLength(1)
    expect(root.children[0]).toBe(overlay.overlayRoot)
  })
  it('does not create entities while updating high-frequency poses', async () => {
    const { overlay } = await runtime()
    const created = fakes.Entity.created
    overlay.updatePose(pose()); overlay.updatePose({ ...pose(), sequence: 2, simulationTime: 0.02 })
    overlay.update()
    expect(fakes.Entity.created).toBe(created)
  })
  it('stays hidden until both visibility and a legal pose are present', async () => {
    const { overlay } = await runtime()
    overlay.setVisible(true); expect(overlay.overlayRoot.enabled).toBe(false)
    overlay.updatePose(pose(), true); expect(overlay.overlayRoot.enabled).toBe(true)
  })
  it('rejects focus bounds before the first pose', async () => {
    const { overlay } = await runtime()
    expect(overlay.getBounds()).toBeNull()
  })
  it('applies calibration only to the alignment root', async () => {
    const { overlay } = await runtime()
    expect(overlay.setCalibration({ translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 2 })).toBe(true)
    const alignment = overlay.alignmentRoot as unknown as InstanceType<typeof fakes.Entity>
    const root = overlay.overlayRoot as unknown as InstanceType<typeof fakes.Entity>
    expect(alignment.position).toEqual(expect.objectContaining({ x: 1, y: 2, z: 3 }))
    expect(root.position).toEqual(expect.objectContaining({ x: 0, y: 0, z: 0 }))
  })
  it('hides and clears the pose on sidecar-crash cleanup', async () => {
    const { overlay } = await runtime()
    overlay.updatePose(pose()); overlay.setVisible(true); overlay.clearPose()
    expect(overlay.getStatus().hasPose).toBe(false)
    expect(overlay.overlayRoot.enabled).toBe(false)
  })
  it('destroys the overlay during viewer disposal', async () => {
    const { overlay } = await runtime()
    overlay.dispose()
    const root = overlay.overlayRoot as unknown as InstanceType<typeof fakes.Entity>
    expect(root.destroyed).toBe(true)
  })
  it('destroys the old rig and rejects stale poses when switching to Go2', async () => {
    const { overlay } = await runtime()
    const oldRigRoot = overlay.alignmentRoot.children[0] as unknown as InstanceType<typeof fakes.Entity>
    overlay.updatePose(pose(), true)
    overlay.setModel('unitree-go2-menagerie')
    expect(oldRigRoot.destroyed).toBe(true)
    expect(overlay.getStatus().hasPose).toBe(false)
    expect(overlay.updatePose({ ...pose(), sequence: 2 })).toBe(false)
    expect(overlay.updatePose(go2Pose(), true)).toBe(true)
    const go2Root = overlay.alignmentRoot.children[1] as unknown as InstanceType<typeof fakes.Entity>
    expect(go2Root.position).toEqual(expect.objectContaining({ x: 1, y: 2, z: 3 }))
    expect(go2Root.children.map((child) => child.name)).toEqual(expect.arrayContaining(['FL hip body', 'FR hip body', 'RL hip body', 'RR hip body']))
    const frontLeft = go2Root.children.find((child) => child.name === 'FL hip body')!
    expect(frontLeft.position).toEqual(expect.objectContaining({ x: .1934, y: 0, z: -.0465 }))
    const thigh = frontLeft.children.find((child) => child.name === 'FL thigh body')!
    const calf = thigh.children.find((child) => child.name === 'FL calf body')!
    expect(thigh.position).toEqual(expect.objectContaining({ x: 0, y: 0, z: -.0955 }))
    expect(calf.position).toEqual(expect.objectContaining({ x: 0, y: -.213, z: 0 }))
    expect(frontLeft.rotation.axis).toEqual(expect.objectContaining({ x: 1, y: 0, z: 0 }))
    expect(thigh.rotation.axis).toEqual(expect.objectContaining({ x: 0, y: 0, z: -1 }))
    expect(overlay.getStatus()).toEqual(expect.objectContaining({ primitiveCount: 19, entityCount: 34 }))
  })
})

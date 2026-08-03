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
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w }
    setFromAxisAngle() { return this }
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
      this.rotation = x instanceof Quat ? x : new Quat(x, y, z, w)
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

describe('RobotOverlayRuntime lifecycle', () => {
  beforeEach(() => { fakes.Entity.created = 0 })

  async function runtime() {
    const root = new fakes.Entity('Application Root')
    const app = { root } as unknown as Application
    const { RobotOverlayRuntime } = await import('../RobotOverlayRuntime')
    return { overlay: new RobotOverlayRuntime(app), root }
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
})

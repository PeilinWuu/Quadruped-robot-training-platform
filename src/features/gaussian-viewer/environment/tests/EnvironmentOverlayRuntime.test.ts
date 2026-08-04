import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const entities: MockEntity[] = []
  class MockMaterial { opacity = 1; blendType = 0; depthWrite = true; diffuse: unknown; emissive: unknown; update = vi.fn(); destroy = vi.fn() }
  class MockEntity {
    name: string; enabled = true; children: MockEntity[] = []; render: { meshInstances: { material: unknown }[] } | null = null
    position = [0, 0, 0]; scale = [1, 1, 1]; destroyed = false
    constructor(name: string) { this.name = name; entities.push(this) }
    addChild(child: MockEntity) { this.children.push(child) }
    addComponent() { this.render = { meshInstances: [{ material: null }] } }
    setLocalPosition(...value: number[]) { this.position = value }
    setLocalScale(...value: number[]) { this.scale = value }
    destroy() { this.destroyed = true }
  }
  return { entities, MockEntity, MockMaterial }
})
vi.mock('playcanvas', () => ({
  Application: class {}, Entity: mocks.MockEntity, StandardMaterial: mocks.MockMaterial,
  Color: class {
    r: number
    g: number
    b: number
    constructor(r = 0, g = 0, b = 0) {
      this.r = r
      this.g = g
      this.b = b
    }
  },
  BLEND_NONE: 0, BLEND_NORMAL: 2,
}))

import { EnvironmentOverlayRuntime } from '../EnvironmentOverlayRuntime'

describe('EnvironmentOverlayRuntime', () => {
  beforeEach(() => { mocks.entities.length = 0 })
  it('uses one existing application root and creates a fixed Y=0 20m ground', () => {
    const root = new mocks.MockEntity('app-root')
    const runtime = new EnvironmentOverlayRuntime({ root } as never)
    const status = runtime.getStatus()
    expect(status.halfExtent).toBe(10)
    expect(status.floorHeight).toBe(0)
    expect(status.materialCount).toBe(4)
    expect(mocks.entities.find((entity) => entity.name === 'Flat Ground Surface')?.position[1]).toBe(-.0125)
    expect(mocks.entities.find((entity) => entity.name === 'Flat Ground Surface')?.scale).toEqual([20, .025, 20])
    expect(root.children).toHaveLength(1)
  })
  it('toggles ground and grid independently and restores after context loss', () => {
    const runtime = new EnvironmentOverlayRuntime({ root: new mocks.MockEntity('app-root') } as never)
    runtime.setGridVisible(false); expect(runtime.getStatus().gridVisible).toBe(false)
    runtime.setVisible(false); expect(runtime.getStatus().visible).toBe(false)
    runtime.setVisible(true); runtime.setContextLost(true); expect(runtime.getStatus().visible).toBe(false)
    runtime.setContextLost(false); expect(runtime.getStatus().visible).toBe(true)
  })
  it('returns stable bounds and disposes every owned resource', () => {
    const runtime = new EnvironmentOverlayRuntime({ root: new mocks.MockEntity('app-root') } as never)
    const environmentRoot = mocks.entities.find((entity) => entity.name === 'Flat Ground Environment Root')
    expect(runtime.getBounds()).toEqual({ center: [0, 0, 0], radius: Math.sqrt(2) * 10 })
    runtime.dispose(); expect(environmentRoot?.destroyed).toBe(true)
  })
})

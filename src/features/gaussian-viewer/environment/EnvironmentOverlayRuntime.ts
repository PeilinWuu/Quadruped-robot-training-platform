import { Application, BLEND_NONE, BLEND_NORMAL, Color, Entity, StandardMaterial } from 'playcanvas'
import type { EnvironmentBounds, EnvironmentOverlayStatus } from './environmentTypes'

const HALF_EXTENT = 10

function material(color: Color, opacity = 1): StandardMaterial {
  const value = new StandardMaterial()
  value.diffuse = color
  value.emissive = new Color(color.r * .18, color.g * .18, color.b * .18)
  value.opacity = opacity
  value.blendType = opacity < 1 ? BLEND_NORMAL : BLEND_NONE
  value.depthWrite = opacity >= 1
  value.update()
  return value
}

export class EnvironmentOverlayRuntime {
  readonly root: Entity
  private readonly ground: Entity
  private readonly gridRoot: Entity
  private readonly materials: StandardMaterial[]
  private visible = true
  private gridVisible = true
  private contextLost = false
  private disposed = false
  private entityCount = 0

  constructor(app: Application) {
    this.root = new Entity('Flat Ground Environment Root', app)
    this.ground = new Entity('Flat Ground Surface', app)
    this.gridRoot = new Entity('Flat Ground Grid Root', app)
    app.root.addChild(this.root)
    this.root.addChild(this.ground)
    this.root.addChild(this.gridRoot)

    const groundMaterial = material(new Color(.07, .14, .17), .82)
    const gridMaterial = material(new Color(.16, .45, .55), .75)
    const xMaterial = material(new Color(.8, .22, .18), .9)
    const zMaterial = material(new Color(.18, .48, .9), .9)
    this.materials = [groundMaterial, gridMaterial, xMaterial, zMaterial]

    this.ground.addComponent('render', { type: 'box' })
    this.ground.setLocalPosition(0, -.0125, 0)
    this.ground.setLocalScale(HALF_EXTENT * 2, .025, HALF_EXTENT * 2)
    this.ground.render!.meshInstances[0].material = groundMaterial
    this.entityCount = 3

    for (let coordinate = -HALF_EXTENT; coordinate <= HALF_EXTENT; coordinate += 1) {
      this.addLine(app, `Grid X ${coordinate}`, 0, .002, coordinate, HALF_EXTENT * 2, .004, .012, gridMaterial)
      this.addLine(app, `Grid Z ${coordinate}`, coordinate, .002, 0, .012, .004, HALF_EXTENT * 2, gridMaterial)
    }
    this.addLine(app, 'Positive X Axis', HALF_EXTENT / 2, .006, 0, HALF_EXTENT, .008, .022, xMaterial)
    this.addLine(app, 'Positive Z Axis', 0, .006, HALF_EXTENT / 2, .022, .008, HALF_EXTENT, zMaterial)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.root.enabled = visible && !this.contextLost
  }
  setGridVisible(visible: boolean): void {
    this.gridVisible = visible
    this.gridRoot.enabled = visible
  }
  setContextLost(lost: boolean): void {
    this.contextLost = lost
    this.root.enabled = this.visible && !lost
  }
  getBounds(): EnvironmentBounds { return { center: [0, 0, 0], radius: Math.sqrt(2) * HALF_EXTENT } }
  getStatus(): EnvironmentOverlayStatus {
    return { environmentId: 'flat-ground-v1', visible: this.visible && !this.contextLost,
      gridVisible: this.gridVisible, entityCount: this.entityCount, materialCount: this.materials.length,
      halfExtent: HALF_EXTENT, floorHeight: 0 }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.root.destroy()
    for (const value of this.materials) value.destroy()
  }

  private addLine(app: Application, name: string, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, lineMaterial: StandardMaterial): void {
    const line = new Entity(name, app)
    line.addComponent('render', { type: 'box' })
    line.setLocalPosition(x, y, z)
    line.setLocalScale(sx, sy, sz)
    line.render!.meshInstances[0].material = lineMaterial
    this.gridRoot.addChild(line)
    this.entityCount += 1
  }
}

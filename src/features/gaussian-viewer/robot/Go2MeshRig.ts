import { BoundingBox, Color, Entity, Quat, StandardMaterial, Vec3 } from 'playcanvas'
import type { Application, ContainerResource, RenderComponent } from 'playcanvas'
import type { RobotPose } from '../../../services/simulation/types'
import { Go2PrimitiveRig } from './Go2PrimitiveRig'
import { mujocoPositionToPlayCanvas } from './go2RigDefinition'
import { GO2_VISUAL_MANIFEST, type Go2VisualMode } from './go2VisualManifest'
import type { Go2VisualAssetCache } from './Go2VisualAssetCache'
import type { RobotBounds, RobotRig } from './RobotRig'

export interface Go2MeshStatus { mode: Go2VisualMode; phase: 'idle' | 'loading' | 'ready' | 'fallback'; loadedParts: number; totalParts: number; loadedBytes: number; totalBytes: number; error: string | null }

export class Go2MeshRig implements RobotRig {
  readonly modelId = 'unitree-go2-menagerie' as const
  readonly jointNames
  readonly primitiveCount
  readonly entityCount
  readonly robotRoot: Entity
  private readonly primitive: Go2PrimitiveRig
  private readonly materials = new Map<string, StandardMaterial>()
  private meshEntities: Entity[] = []
  private generation = 0
  private disposed = false
  private status: Go2MeshStatus
  private readonly cache: Go2VisualAssetCache

  constructor(app: Application, parent: Entity, cache: Go2VisualAssetCache, mode: Go2VisualMode = 'official-mesh') {
    this.cache = cache
    this.primitive = new Go2PrimitiveRig(app, parent); this.robotRoot = this.primitive.robotRoot
    this.jointNames = this.primitive.jointNames; this.primitiveCount = this.primitive.primitiveCount; this.entityCount = this.primitive.entityCount
    const unique = new Map(GO2_VISUAL_MANIFEST.parts.map((part) => [part.glbUrl, part.byteSize]))
    this.status = { mode, phase: mode === 'official-mesh' ? 'loading' : 'idle', loadedParts: 0, totalParts: unique.size, loadedBytes: 0, totalBytes: [...unique.values()].reduce((a, b) => a + b, 0), error: null }
    if (mode === 'official-mesh') void this.load()
  }
  acceptsPose(pose: RobotPose): boolean { return this.primitive.acceptsPose(pose) }
  applyPose(pose: RobotPose): void { this.primitive.applyPose(pose) }
  getStatus(): Go2MeshStatus { return { ...this.status } }
  setMode(mode: Go2VisualMode): void {
    if (this.disposed || this.status.mode === mode) return
    this.status = { ...this.status, mode, error: null }
    if (mode === 'primitive-debug') { this.setMeshVisible(false); this.primitive.setPrimitivesVisible(true); return }
    if (this.meshEntities.length) { this.primitive.setPrimitivesVisible(false); this.setMeshVisible(true); this.status.phase = 'ready' }
    else void this.load()
  }
  retry(): void { if (!this.disposed) { this.destroyMeshEntities(); void this.load() } }
  getBounds(): RobotBounds {
    if (this.status.mode !== 'official-mesh' || this.status.phase !== 'ready' || !this.meshEntities.length) return this.primitive.getBounds()
    const box = new BoundingBox(); let found = false
    for (const entity of this.meshEntities) for (const component of entity.findComponents('render') as RenderComponent[]) for (const instance of component.meshInstances) {
      if (!found) { box.copy(instance.aabb); found = true } else box.add(instance.aabb)
    }
    if (!found || !Number.isFinite(box.halfExtents.length())) return this.primitive.getBounds()
    return { center: [box.center.x, box.center.y, box.center.z], radius: Math.max(box.halfExtents.length(), .3) }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.generation++; this.destroyMeshEntities(); this.materials.forEach((material) => material.destroy()); this.materials.clear(); this.primitive.dispose() }

  private async load(): Promise<void> {
    const generation = ++this.generation
    this.status = { ...this.status, phase: 'loading', loadedParts: 0, loadedBytes: 0, error: null }; this.primitive.setPrimitivesVisible(true); this.setMeshVisible(false)
    const unique = [...new Map(GO2_VISUAL_MANIFEST.parts.map((part) => [part.glbUrl, part])).values()]
    const loaded = new Map<string, Awaited<ReturnType<Go2VisualAssetCache['load']>>>()
    try {
      for (let index = 0; index < unique.length; index += 4) await Promise.all(unique.slice(index, index + 4).map(async (part) => {
        const value = await this.cache.load(part.glbUrl, part.glbSha256, part.byteSize); loaded.set(part.glbUrl, value)
        if (generation === this.generation) this.status = { ...this.status, loadedParts: loaded.size, loadedBytes: [...loaded.values()].reduce((sum, item) => sum + item.bytes, 0) }
      }))
      if (this.disposed || generation !== this.generation) return
      const next: Entity[] = []
      for (const part of GO2_VISUAL_MANIFEST.parts) {
        const parent = this.primitive.getBodyNode(part.bodyName); const cached = loaded.get(part.glbUrl)
        if (!parent || !cached) throw new Error('GO2_VISUAL_BODY_MAPPING_FAILED')
        const resource = cached.asset.resource as ContainerResource
        const entity = resource.instantiateRenderEntity(); entity.name = `Go2 mesh ${part.id}`
        const position = mujocoPositionToPlayCanvas(part.geomPosition); entity.setLocalPosition(...position)
        entity.setLocalScale(...part.meshScale)
        const mj = new Quat(part.geomOrientation[1], part.geomOrientation[2], part.geomOrientation[3], part.geomOrientation[0]).normalize()
        const basis = new Quat().setFromAxisAngle(Vec3.RIGHT, -90); entity.setLocalRotation(new Quat().mul2(basis, mj).normalize())
        const material = this.material(part.rgba)
        for (const component of entity.findComponents('render') as RenderComponent[]) for (const instance of component.meshInstances) instance.material = material
        parent.addChild(entity); next.push(entity)
      }
      this.meshEntities = next
      if (this.status.mode === 'official-mesh') { this.primitive.setPrimitivesVisible(false); this.setMeshVisible(true) }
      this.status = { ...this.status, phase: 'ready', error: null }
    } catch {
      if (generation !== this.generation || this.disposed) return
      this.destroyMeshEntities(); this.primitive.setPrimitivesVisible(true)
      this.status = { ...this.status, phase: 'fallback', error: '网格加载失败，已回退基础几何' }
    }
  }
  private material(rgba: readonly number[]): StandardMaterial {
    const key = rgba.join(','); const existing = this.materials.get(key); if (existing) return existing
    const material = new StandardMaterial(); material.diffuse = new Color(rgba[0], rgba[1], rgba[2], rgba[3]); material.emissive = new Color(rgba[0] * .28, rgba[1] * .28, rgba[2] * .28); material.opacity = rgba[3]; material.metalness = .15; material.gloss = .62; material.update(); this.materials.set(key, material); return material
  }
  private destroyMeshEntities(): void { for (const entity of this.meshEntities) entity.destroy(); this.meshEntities = [] }
  private setMeshVisible(visible: boolean): void { for (const entity of this.meshEntities) entity.enabled = visible }
}

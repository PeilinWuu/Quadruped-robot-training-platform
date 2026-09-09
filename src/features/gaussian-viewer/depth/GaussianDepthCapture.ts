import { Application, Entity, Layer, Picker } from 'playcanvas'
import type { RenderTarget, Texture, MeshInstance } from 'playcanvas'
import { decodeGsDepth, gsDepthPreview } from './gsDepthPreview'
import type { GaussianDepthFrame } from '../types'

// Full-frame readback adapter for pinned PlayCanvas 2.21.1 Picker internals.
// Public Picker only exposes single-pixel depth. Keep this dependency isolated.
interface DepthPickerBuffers {
  depthBuffer: Texture; renderTargetDepth: RenderTarget
  renderPass: { execute(): void; _pickMeshInstances: Map<number, MeshInstance> }
}
export class GaussianDepthCapture {
  private readonly picker: Picker
  private readonly app: Application
  private readonly camera: Entity
  private readonly layer: Layer
  private busy = false
  private disposed = false
  private generation = 0
  private lastCapture = 0
  private sequence = 0
  active = false
  gpuSequence = 0
  gpuCameraWorld: number[] = []
  get texture(): Texture { return (this.picker as unknown as DepthPickerBuffers).depthBuffer }
  get status(): 'ready' | 'off' | 'unavailable' { return this.active ? 'ready' : this.failed ? 'unavailable' : 'off' }
  private failed = false
  frame: GaussianDepthFrame | null = null
  constructor(app: Application, camera: Entity, layer: Layer) {
    this.app = app; this.camera = camera; this.layer = layer
    this.picker = new Picker(app, 640, 360, true)
    const pass = (this.picker as unknown as DepthPickerBuffers).renderPass
    const execute = pass.execute.bind(pass)
    pass.execute = () => {
      // Engine picking normally relies on splat order. A depth map needs the
      // nearest accepted fragment, independent of asynchronous RGB sorting.
      const materials = new Set([...pass._pickMeshInstances.values(), ...this.layer.meshInstances].map(mi => mi.material))
      const previous = [...materials].map(material => ({ material, write: material.depthWrite, test: material.depthTest }))
      for (const { material } of previous) { material.depthWrite = true; material.depthTest = true; material.setParameter('alphaClip', gsDepthPreview.alphaClip) }
      try { execute() } finally {
        for (const { material, write, test } of previous) { material.depthWrite = write; material.depthTest = test }
      }
    }
  }
  renderGpu(enabled: boolean, fullResolution = true): void {
    this.active = false
    if (this.disposed || !enabled) return
    try {
      const width = fullResolution ? this.app.graphicsDevice.width : Math.min(640, this.app.graphicsDevice.width)
      const height = Math.max(1, Math.round(width * this.app.graphicsDevice.height / this.app.graphicsDevice.width))
      this.app.root.syncHierarchy()
      this.app.scene.gsplat.alphaClip = gsDepthPreview.alphaClip
      this.picker.resize(width, height)
      this.picker.prepare(this.camera.camera!, this.app.scene, [this.layer])
      if (!this.texture) throw new Error('GS_DEPTH_BUFFER_UNAVAILABLE')
      this.gpuCameraWorld = Array.from(this.camera.getWorldTransform().data)
      this.active = true; this.failed = false; this.gpuSequence++
    } catch (error) {
      this.failed = true
      gsDepthPreview.publish(null, error instanceof Error ? error.message : 'GS_DEPTH_FAILED')
    }
  }
  update(): void {
    if (this.busy || this.disposed || !this.active || !gsDepthPreview.enabled || performance.now() - this.lastCapture < 200) return
    this.lastCapture = performance.now()
    void this.capture()
  }
  private async capture(): Promise<void> {
    this.busy = true
    const generation = this.generation
    const camera = this.camera.camera!
    const buffers = this.picker as unknown as DepthPickerBuffers
    const width = buffers.depthBuffer.width, height = buffers.depthBuffer.height
    const near = camera.nearClip, far = camera.farClip
    const timestampMs = performance.now()
    try {
      const bytes = await buffers.depthBuffer.read(0, 0, width, height, { renderTarget: buffers.renderTargetDepth, immediate: true })
      if (this.disposed || generation !== this.generation || !gsDepthPreview.enabled) return
      const values = decodeGsDepth(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), width, height, near, far)
      const previewWidth = Math.min(640, width)
      const previewHeight = Math.max(1, Math.round(previewWidth * height / width))
      const preview = new Float32Array(previewWidth * previewHeight)
      for (let y = 0; y < previewHeight; y++) for (let x = 0; x < previewWidth; x++) {
        preview[y * previewWidth + x] = values[Math.min(height - 1, Math.floor((y + .5) * height / previewHeight)) * width + Math.min(width - 1, Math.floor((x + .5) * width / previewWidth))]
      }
      this.frame = { width: previewWidth, height: previewHeight, values: preview, sequence: ++this.sequence, timestampMs }
      gsDepthPreview.publish(this.frame)
    } catch (error) {
      if (!this.disposed && generation === this.generation) gsDepthPreview.publish(null, error instanceof Error ? error.message : 'GS_DEPTH_FAILED')
    } finally {
      this.busy = false
      if (this.disposed) this.picker.destroy()
    }
  }
  clear(): void { this.active = false; this.generation++; this.frame = null; gsDepthPreview.publish(null) }
  dispose(): void { this.disposed = true; this.clear(); if (!this.busy) this.picker.destroy() }
}

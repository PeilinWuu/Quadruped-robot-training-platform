import { Application, Color, CULLFACE_NONE, Entity, FILTER_NEAREST, Layer, Mesh, MeshInstance,
  PIXELFORMAT_RGBA8, RenderTarget, SEMANTIC_POSITION, ShaderMaterial, Texture } from 'playcanvas'

/** Shared full-resolution, live-camera depth from full-room occupancy geometry.
 * It has its own rendering camera but never receives input or changes the active camera.
 */
export class FireProxyDepth {
  readonly texture: Texture
  active = false
  get status(): 'off' | 'loading' | 'ready' | 'unavailable' {
    return this.failed ? 'unavailable' : this.loading ? 'loading' : this.active ? 'ready' : 'off'
  }
  private readonly target: RenderTarget
  private readonly layer: Layer
  private readonly camera: Entity
  private readonly geometry: Entity
  private readonly material: ShaderMaterial
  private mesh: Mesh | null = null
  private disposed = false
  private loading = false
  private failed = false
  private readonly abort = new AbortController()

  private readonly app: Application
  private readonly sourceCamera: Entity
  constructor(app: Application, sourceCamera: Entity, excludeCurtain = false) {
    this.app = app; this.sourceCamera = sourceCamera
    this.texture = new Texture(app.graphicsDevice, { name: 'Fire proxy depth', width: 640, height: 360,
      format: PIXELFORMAT_RGBA8, mipmaps: false, minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST })
    this.target = new RenderTarget({ colorBuffer: this.texture, depth: true })
    this.layer = new Layer({ name: 'Fire occupancy depth only' })
    app.scene.layers.insertOpaque(this.layer, 0)
    this.camera = new Entity('Fire depth camera', app)
    this.camera.addComponent('camera', { layers: [this.layer.id], renderTarget: this.target,
      priority: -10, clearColor: new Color(1, 1, 1, 1) })
    this.camera.enabled = false
    app.root.addChild(this.camera)
    this.material = new ShaderMaterial({ uniqueName: 'Fire occupancy depth', attributes: { aPosition: SEMANTIC_POSITION },
      vertexGLSL: `attribute vec3 aPosition;
        uniform mat4 matrix_model; uniform mat4 matrix_view; uniform mat4 matrix_viewProjection;
        varying float vDepth; varying vec3 vWorld;
        void main() { vec4 w = matrix_model * vec4(aPosition, 1.0); vWorld = w.xyz; vDepth = -(matrix_view*w).z;
          gl_Position = matrix_viewProjection*w; }`,
      fragmentGLSL: `precision highp float; varying float vDepth; varying vec3 vWorld; uniform float uFarClip;
        uniform float uExcludeCurtain;
        void main() {
          // Instance 62 from office_01 labels.json, converted from source Z-up.
          // Only this emitter's depth pass excludes its own thin surface shell.
          if (uExcludeCurtain > .5 && all(greaterThanEqual(vWorld,vec3(7.41,.88,-2.14)))
              && all(lessThanEqual(vWorld,vec3(9.81,3.21,-1.86)))) discard;
          vec3 p = fract(clamp(vDepth/uFarClip,0.0,0.999999)*vec3(1.0,255.0,65025.0));
          p.xy -= p.yz/255.0; gl_FragColor=vec4(p,1.0); }` })
    this.material.setParameter('uExcludeCurtain', excludeCurtain ? 1 : 0)
    this.material.cull = CULLFACE_NONE
    this.material.depthTest = true; this.material.depthWrite = true
    this.material.update()
    this.geometry = new Entity('Fire occupancy proxy', app)
    app.root.addChild(this.geometry)
  }

  update(enabled: boolean): void {
    if (this.disposed) return
    if (enabled && !this.mesh && !this.loading && !this.failed) void this.load()
    this.active = enabled && this.mesh !== null
    this.camera.enabled = this.active
    if (!this.active) return
    const source = this.sourceCamera.camera!
    this.camera.setPosition(this.sourceCamera.getPosition())
    this.camera.setRotation(this.sourceCamera.getRotation())
    this.camera.camera!.fov = source.fov
    this.camera.camera!.horizontalFov = source.horizontalFov
    this.camera.camera!.nearClip = source.nearClip
    this.camera.camera!.farClip = source.farClip
    const width = Math.max(1, Math.ceil(this.app.graphicsDevice.width))
    const height = Math.max(1, Math.ceil(this.app.graphicsDevice.height))
    if (this.target.width !== width || this.target.height !== height) this.target.resize(width, height)
    this.material.setParameter('uFarClip', source.farClip)
  }

  private async load(): Promise<void> {
    this.loading = true
    try {
      const response = await fetch('/fire-playback-v2/table_high_test/proxy-smooth.bin', { signal: this.abort.signal })
      if (!response.ok) throw new Error('FIRE_PROXY_NOT_FOUND')
      const buffer = await response.arrayBuffer()
      if (this.disposed) return
      if (!buffer.byteLength || buffer.byteLength % 36 || buffer.byteLength > 64 * 1024 * 1024) throw new Error('FIRE_PROXY_INVALID')
      const positions = new Float32Array(buffer)
      if (!positions.every(Number.isFinite)) throw new Error('FIRE_PROXY_NONFINITE')
      this.mesh = new Mesh(this.app.graphicsDevice)
      this.mesh.setPositions(positions)
      this.mesh.update()
      this.geometry.addComponent('render', { meshInstances: [new MeshInstance(this.mesh, this.material)], layers: [this.layer.id] })
    } catch (error) {
      if (!this.disposed) { this.failed = true; console.warn('Fire depth proxy unavailable; volume remains usable', error) }
    } finally { this.loading = false }
  }

  dispose(): void {
    this.disposed = true; this.abort.abort()
    this.camera.destroy(); this.geometry.destroy(); this.mesh?.destroy(); this.material.destroy()
    this.app.scene.layers.removeOpaque(this.layer)
    this.target.destroy(); this.texture.destroy()
  }
}

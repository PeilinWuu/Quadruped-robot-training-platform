import {
  Application,
  Asset,
  Color,
  Entity,
  FILLMODE_NONE,
  GSplatResourceBase,
  RESOLUTION_FIXED,
  Vec3,
} from 'playcanvas'
import type { GSplatComponentSystem } from 'playcanvas'
import type {
  SceneLoadResult,
  SceneSource,
  ViewerRuntime,
  ViewerRuntimeOptions,
  ViewerRuntimeStatus,
} from '../types'
import { PlayCanvasCameraController } from './PlayCanvasCameraController'

const MAX_SCENE_BYTES = 50 * 1024 * 1024
const STATUS_SAMPLE_INTERVAL_MS = 750
const DEFAULT_TARGET = new Vec3(0, 0, 0)
const DEFAULT_DISTANCE = 3

class SceneLoadError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'SceneLoadError'
    this.code = code
  }
}

function abortError(): DOMException {
  return new DOMException('LOAD_CANCELLED', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export class PlayCanvasGsRuntime implements ViewerRuntime {
  private readonly canvas: HTMLCanvasElement
  private onStatusChange: ((status: ViewerRuntimeStatus) => void) | null
  private app: Application | null = null
  private cameraEntity: Entity | null = null
  private sceneEntity: Entity | null = null
  private sceneAsset: Asset | null = null
  private pendingAsset: Asset | null = null
  private cameraController: PlayCanvasCameraController | null = null
  private gsplatSystem: GSplatComponentSystem | null = null
  private objectUrl: string | null = null
  private pendingParse: Promise<SceneLoadResult> | null = null
  private cancelPendingParse: (() => void) | null = null
  private loadGeneration = 0
  private disposed = false
  private activeRendering = false
  private lastStatusSampleAt = 0
  private initialTarget = DEFAULT_TARGET.clone()
  private initialDistance = DEFAULT_DISTANCE
  private status: ViewerRuntimeStatus = {
    backend: 'PlayCanvas WebGL2',
    renderer: 'PlayCanvas Engine 2.21.1',
    initialized: false,
    running: false,
    contextLost: false,
    fps: 0,
    width: 0,
    height: 0,
    pixelRatio: 1,
    scenePhase: 'idle',
    sceneName: null,
    progress: null,
    sceneLoaded: false,
    controlsEnabled: false,
    fallback: false,
    error: null,
  }

  constructor({ canvas, onStatusChange }: ViewerRuntimeOptions) {
    this.canvas = canvas
    this.onStatusChange = onStatusChange

    try {
      const app = new Application(canvas, {
        graphicsDeviceOptions: {
          alpha: false,
          antialias: false,
          depth: true,
          stencil: false,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
        },
      })
      this.app = app
      if (!app.graphicsDevice.isWebGL2 || app.graphicsDevice.deviceType !== 'webgl2') {
        throw new Error('WEBGL2_DEVICE_REQUIRED')
      }

      app.setCanvasFillMode(FILLMODE_NONE, 0, 0)
      app.graphicsDevice.maxPixelRatio = 1
      app.setCanvasResolution(RESOLUTION_FIXED, 0, 0)
      app.autoRender = false

      const camera = new Entity('Gaussian Viewer Camera', app)
      camera.addComponent('camera', {
        clearColor: new Color(0.035, 0.055, 0.07, 1),
        nearClip: 0.01,
        farClip: 10_000,
      })
      app.root.addChild(camera)
      this.cameraEntity = camera

      this.cameraController = new PlayCanvasCameraController(
        canvas,
        camera,
        this.requestRender,
      )
      this.cameraController.reset(this.initialTarget, this.initialDistance)

      canvas.addEventListener('webglcontextlost', this.handleContextLost)
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
      app.on('frameend', this.handleFrameEnd)
      const gsplatSystem = app.systems.gsplat
      if (!gsplatSystem) throw new Error('GSPLAT_SYSTEM_UNAVAILABLE')
      this.gsplatSystem = gsplatSystem
      gsplatSystem.on('frame:request', this.handleFrameRequest)
      app.start()

      this.status = { ...this.status, initialized: true }
      this.emitStatus()
    } catch {
      this.dispose()
      throw new Error('PLAYCANVAS_INITIALIZATION_FAILED')
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    const app = this.app
    if (this.disposed || !app) return

    const safeWidth = Math.floor(width)
    const safeHeight = Math.floor(height)
    const safePixelRatio = Math.min(Math.max(pixelRatio, 1), 2)
    if (
      !Number.isFinite(safeWidth)
      || !Number.isFinite(safeHeight)
      || !Number.isFinite(safePixelRatio)
      || safeWidth < 0
      || safeHeight < 0
    ) {
      this.status = { ...this.status, running: false, error: 'INVALID_VIEWPORT_SIZE' }
      app.autoRender = false
      this.updateControlsEnabled()
      this.emitStatus()
      return
    }

    app.graphicsDevice.maxPixelRatio = safePixelRatio
    app.setCanvasFillMode(FILLMODE_NONE, safeWidth, safeHeight)
    app.setCanvasResolution(RESOLUTION_FIXED, safeWidth, safeHeight)
    this.status = {
      ...this.status,
      width: safeWidth,
      height: safeHeight,
      pixelRatio: safePixelRatio,
      error: this.status.error === 'INVALID_VIEWPORT_SIZE' ? null : this.status.error,
    }
    this.requestRender()
    this.emitStatus()
  }

  start(): void {
    const app = this.app
    if (this.disposed || !app) return
    this.activeRendering = true
    app.autoRender = true
    app.renderNextFrame = true
    this.status = { ...this.status, running: true }
    this.updateControlsEnabled()
    this.emitStatus()
  }

  pause(): void {
    const app = this.app
    if (this.disposed || !app) return
    // PlayCanvas keeps its engine RAF alive; this only stops active drawing and input.
    this.activeRendering = false
    app.autoRender = false
    this.status = { ...this.status, running: false }
    this.updateControlsEnabled()
    this.emitStatus()
  }

  async loadScene(source: SceneSource, signal?: AbortSignal): Promise<SceneLoadResult> {
    if (this.disposed || !this.app) throw new SceneLoadError('RUNTIME_DISPOSED')
    await this.unloadScene()
    if (signal?.aborted) throw abortError()

    const generation = ++this.loadGeneration
    this.validateSource(source)
    this.status = {
      ...this.status,
      scenePhase: 'fetching',
      sceneName: source.displayName,
      progress: null,
      sceneLoaded: false,
      error: null,
    }
    this.updateControlsEnabled()
    this.emitStatus()

    try {
      const response = await fetch(source.url, { signal })
      if (response.status === 404) throw new SceneLoadError('SCENE_NOT_FOUND')
      if (!response.ok) throw new SceneLoadError('SCENE_FETCH_FAILED')

      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SCENE_BYTES) {
        throw new SceneLoadError('SCENE_TOO_LARGE')
      }

      const blob = await response.blob()
      if (blob.size > MAX_SCENE_BYTES) throw new SceneLoadError('SCENE_TOO_LARGE')
      if (signal?.aborted || generation !== this.loadGeneration) throw abortError()

      return await this.parseSceneBlob(blob, source, generation, signal)
    } catch (error) {
      if (this.disposed) throw error
      const code = isAbortError(error)
        ? 'LOAD_CANCELLED'
        : error instanceof SceneLoadError
          ? error.code
          : 'SCENE_FETCH_FAILED'
      if (generation === this.loadGeneration || code === 'LOAD_CANCELLED') {
        this.status = {
          ...this.status,
          scenePhase: 'error',
          progress: null,
          sceneLoaded: false,
          error: code,
        }
        this.updateControlsEnabled()
        this.emitStatus()
      }
      throw error
    }
  }

  async unloadScene(): Promise<void> {
    if (this.disposed) return
    ++this.loadGeneration
    const hadScene = Boolean(this.sceneEntity || this.sceneAsset || this.pendingAsset || this.objectUrl)
    if (hadScene) {
      this.status = {
        ...this.status,
        scenePhase: 'unloading',
        progress: null,
        sceneLoaded: false,
        error: null,
      }
      this.updateControlsEnabled()
      this.emitStatus()
    }

    const pending = this.pendingParse
    if (pending) {
      try {
        await pending
      } catch {
        // A stale parse cleans itself up before rejecting.
      }
    }
    if (this.disposed) return

    this.releaseLoadedScene()
    this.revokeObjectUrl()
    this.status = {
      ...this.status,
      scenePhase: 'idle',
      sceneName: null,
      progress: null,
      sceneLoaded: false,
      error: null,
    }
    this.updateControlsEnabled()
    this.requestRender()
    this.emitStatus()
  }

  resetCamera(): void {
    if (this.disposed || !this.status.sceneLoaded) return
    this.cameraController?.reset(this.initialTarget, this.initialDistance)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.activeRendering = false
    ++this.loadGeneration
    this.cancelPendingParse?.()
    this.cancelPendingParse = null
    this.pendingParse = null

    const app = this.app
    this.cameraController?.dispose()
    this.cameraController = null
    this.releaseLoadedScene()
    if (this.pendingAsset) this.releaseAsset(this.pendingAsset)
    this.pendingAsset = null
    this.revokeObjectUrl()

    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    app?.off('frameend', this.handleFrameEnd)
    this.gsplatSystem?.off('frame:request', this.handleFrameRequest)
    this.gsplatSystem = null
    this.cameraEntity?.destroy()
    this.cameraEntity = null
    this.app = null
    this.onStatusChange = null
    app?.destroy()
  }

  getStatus(): ViewerRuntimeStatus {
    return { ...this.status }
  }

  private async parseSceneBlob(
    blob: Blob,
    source: SceneSource,
    generation: number,
    signal?: AbortSignal,
  ): Promise<SceneLoadResult> {
    const app = this.app
    if (!app || this.disposed) return Promise.reject(new SceneLoadError('RUNTIME_DISPOSED'))

    const objectUrl = URL.createObjectURL(blob)
    this.objectUrl = objectUrl
    this.status = { ...this.status, scenePhase: 'parsing', progress: null, error: null }
    this.emitStatus()

    // PlayCanvas accepts pre-fetched ArrayBuffer contents on an Asset. This keeps the SOG parse
    // inside the Engine while avoiding a second blob: fetch, which production CSP intentionally
    // does not permit. The conversion creates one buffer and cancellation remains logical here.
    let contents: ArrayBuffer
    try {
      contents = await blob.arrayBuffer()
    } catch {
      this.revokeObjectUrl(objectUrl)
      throw new SceneLoadError('SCENE_PARSE_FAILED')
    }
    if (
      this.disposed
      || signal?.aborted
      || generation !== this.loadGeneration
    ) {
      this.revokeObjectUrl(objectUrl)
      throw abortError()
    }

    const asset = new Asset(source.displayName, 'gsplat', {
      url: objectUrl,
      filename: 'test-scene.sog',
      size: blob.size,
      contents,
    })
    this.pendingAsset = asset

    const promise = new Promise<SceneLoadResult>((resolve, reject) => {
      let logicallyCancelled = false
      let settled = false

      const cleanupListeners = () => {
        asset.off('progress', handleProgress)
        asset.off('load', handleLoad)
        asset.off('error', handleError)
        signal?.removeEventListener('abort', handleAbort)
      }
      const settleRejected = (error: Error) => {
        if (settled) return
        settled = true
        cleanupListeners()
        reject(error)
      }
      const cleanupStaleAsset = () => {
        this.releaseAsset(asset)
        if (this.pendingAsset === asset) this.pendingAsset = null
        this.revokeObjectUrl(objectUrl)
      }
      const handleAbort = () => {
        logicallyCancelled = true
        if (generation === this.loadGeneration) ++this.loadGeneration
        this.status = {
          ...this.status,
          scenePhase: 'error',
          progress: null,
          sceneLoaded: false,
          error: 'LOAD_CANCELLED',
        }
        this.updateControlsEnabled()
        this.emitStatus()
      }
      const handleProgress = (receivedBytes: number, totalBytes: number) => {
        if (
          generation !== this.loadGeneration
          || totalBytes !== blob.size
          || totalBytes <= 0
          || receivedBytes < 0
          || receivedBytes > totalBytes
        ) {
          return
        }
        this.status = {
          ...this.status,
          progress: Math.min(Math.max(receivedBytes / totalBytes, 0), 1),
        }
        this.emitStatus()
      }
      const handleLoad = () => {
        if (
          this.disposed
          || logicallyCancelled
          || signal?.aborted
          || generation !== this.loadGeneration
        ) {
          cleanupStaleAsset()
          settleRejected(abortError())
          return
        }

        try {
          const entity = new Entity('Gaussian SOG Scene', app)
          // D3B-2 uses the fixed toy-cat test asset, whose documented pose is rotated 180° on Z.
          // A future asset pipeline must replace this with per-asset orientation metadata.
          entity.setEulerAngles(0, 0, 180)
          entity.addComponent('gsplat', { asset })
          app.root.addChild(entity)
          this.sceneEntity = entity
          this.sceneAsset = asset
          this.pendingAsset = null
          this.revokeObjectUrl(objectUrl)
          this.frameLoadedScene(asset)
          this.status = {
            ...this.status,
            scenePhase: 'ready',
            sceneName: source.displayName,
            progress: 1,
            sceneLoaded: true,
            error: null,
          }
          this.updateControlsEnabled()
          this.requestRender()
          this.emitStatus()
          settled = true
          cleanupListeners()
          resolve({ source, loadedAt: Date.now(), format: 'sog' })
        } catch {
          cleanupStaleAsset()
          settleRejected(new SceneLoadError('SCENE_PARSE_FAILED'))
        }
      }
      const handleError = () => {
        cleanupStaleAsset()
        settleRejected(
          logicallyCancelled || generation !== this.loadGeneration
            ? abortError()
            : new SceneLoadError('SCENE_PARSE_FAILED'),
        )
      }

      this.cancelPendingParse = () => {
        cleanupStaleAsset()
        settleRejected(abortError())
      }
      asset.on('progress', handleProgress)
      asset.once('load', handleLoad)
      asset.once('error', handleError)
      signal?.addEventListener('abort', handleAbort, { once: true })
      app.assets.add(asset)
      app.assets.load(asset)
    })

    this.pendingParse = promise
    void promise.finally(() => {
      if (this.pendingParse === promise) {
        this.pendingParse = null
        this.cancelPendingParse = null
      }
    }).catch(() => {
      // The caller observes the original promise.
    })
    return promise
  }

  private frameLoadedScene(asset: Asset): void {
    const resource = asset.resource
    if (!(resource instanceof GSplatResourceBase)) {
      this.initialTarget = DEFAULT_TARGET.clone()
      this.initialDistance = DEFAULT_DISTANCE
      this.cameraController?.reset(this.initialTarget, this.initialDistance)
      return
    }

    const aabb = resource.aabb
    const radius = Math.max(aabb.halfExtents.length(), 0.1)
    this.initialTarget = this.sceneEntity
      ? this.sceneEntity.getWorldTransform().transformPoint(aabb.center)
      : aabb.center.clone()
    this.initialDistance = Math.max(radius * 2.5, 0.5)
    const camera = this.cameraEntity?.camera
    if (camera) {
      camera.nearClip = Math.max(radius / 1_000, 0.001)
      camera.farClip = Math.max(radius * 20, 100)
    }
    this.cameraController?.reset(this.initialTarget, this.initialDistance)
  }

  private releaseLoadedScene(): void {
    this.sceneEntity?.destroy()
    this.sceneEntity = null
    if (this.sceneAsset) this.releaseAsset(this.sceneAsset)
    this.sceneAsset = null
  }

  private releaseAsset(asset: Asset): void {
    try {
      asset.unload()
    } catch {
      // Application destruction still releases remaining graphics resources.
    }
    this.app?.assets.remove(asset)
  }

  private revokeObjectUrl(expectedUrl?: string): void {
    if (!this.objectUrl || (expectedUrl && this.objectUrl !== expectedUrl)) return
    URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  private validateSource(source: SceneSource): void {
    if (source.kind !== 'public-url' || !source.url.toLowerCase().endsWith('.sog')) {
      throw new SceneLoadError('UNSUPPORTED_SCENE_SOURCE')
    }
    const resolved = new URL(source.url, window.location.href)
    if (resolved.origin !== window.location.origin) {
      throw new SceneLoadError('REMOTE_SCENE_BLOCKED')
    }
  }

  private updateControlsEnabled(): void {
    const enabled = this.activeRendering
      && this.status.sceneLoaded === true
      && !this.status.contextLost
      && !this.disposed
    this.cameraController?.setEnabled(enabled)
    this.status = { ...this.status, controlsEnabled: enabled }
  }

  private readonly requestRender = (): void => {
    if (!this.app || this.disposed) return
    this.app.renderNextFrame = true
  }

  private readonly handleFrameRequest = (): void => {
    if (this.activeRendering) this.requestRender()
  }

  private readonly handleFrameEnd = (): void => {
    if (!this.app || this.disposed) return
    const now = performance.now()
    if (now - this.lastStatusSampleAt < STATUS_SAMPLE_INTERVAL_MS) return
    this.lastStatusSampleAt = now
    const fps = this.activeRendering ? Math.round(this.app.stats.frame.fps) : 0
    if (fps !== this.status.fps) {
      this.status = { ...this.status, fps }
      this.emitStatus()
    }
  }

  private readonly handleContextLost = (): void => {
    if (this.disposed) return
    this.status = {
      ...this.status,
      initialized: false,
      running: false,
      contextLost: true,
      fps: 0,
      error: null,
    }
    this.updateControlsEnabled()
    this.emitStatus()
  }

  private readonly handleContextRestored = (): void => {
    if (this.disposed || !this.app) return
    this.status = {
      ...this.status,
      initialized: this.app.graphicsDevice.isWebGL2,
      running: this.activeRendering,
      contextLost: false,
      error: this.app.graphicsDevice.isWebGL2 ? null : 'WEBGL2_RESTORE_FAILED',
    }
    this.app.autoRender = this.activeRendering
    this.updateControlsEnabled()
    this.requestRender()
    this.emitStatus()
  }

  private emitStatus(): void {
    if (!this.disposed) this.onStatusChange?.(this.getStatus())
  }
}

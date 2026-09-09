import { GaussianDepthCapture } from '../depth/GaussianDepthCapture'
import { gsDepthPreview } from '../depth/gsDepthPreview'
import { thermalPreview } from '../thermal/thermalPreview'
import { robotCollisionService } from '../../../services/robot-collision/robotCollisionService'
import { constrainRobotMovement, constrainRobotTurn, drawCollisionOverlay } from '../robot/RobotCollisionOverlay'
import { StepDemoRuntime } from '../robot/StepDemoRuntime'
import {
  Application,
  Asset,
  Color,
  Entity,
  FILLMODE_NONE,
  GSplatResourceBase,
  Picker,
  Layer,
  RenderPass,
  Quat,
  RESOLUTION_FIXED,
  Vec3,
} from 'playcanvas'
import type { GSplatComponentSystem } from 'playcanvas'
import { normalizeQuaternion } from '../../../services/scenes/types'
import type { SceneOrientation } from '../../../services/scenes/types'
import type {
  SceneLoadResult,
  SceneSource,
  ViewerRuntime,
  ViewerRuntimeOptions,
  ViewerRuntimeStatus,
} from '../types'
import { MAX_SCENE_BYTES } from '../types'
import { PlayCanvasCameraController } from './PlayCanvasCameraController'
import type { RobotPose, SimulationModelId } from '../../../services/simulation/types'
import {
  RobotOverlayRuntime,
} from '../robot/RobotOverlayRuntime'
import type {
  RobotOverlayCalibration, RobotOverlayStatus,
} from '../robot/RobotOverlayRuntime'
import type { Go2VisualMode } from '../robot/go2VisualManifest'
import { EnvironmentOverlayRuntime } from '../environment/EnvironmentOverlayRuntime'
import type { EnvironmentOverlayStatus } from '../environment/environmentTypes'
import { firePlaybackService } from '../../../services/fire-playback/firePlaybackService'
import { ROOM_FIRE_VIEWS } from '../../../services/fire-playback/roomFireScenario'
import { FireVolumeRuntime } from '../fire/FireVolumeRuntime'
import { robotMotionPlaybackService } from '../../../services/robot-motion-playback/robotMotionPlaybackService'
import { fitGroundPlane, saveGroundPlane, loadGroundPlane, type GroundPlane } from '../../../services/robot-motion-playback/groundPlaneService'

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

export function sceneSourceUrl(source: SceneSource): string {
  if (source.kind === 'dev-public-url') {
    if (!import.meta.env.DEV) throw new SceneLoadError('UNSUPPORTED_SCENE_SOURCE')
    const resolved = new URL(source.url, window.location.href)
    if (
      resolved.origin !== window.location.origin
      || !resolved.pathname.toLowerCase().endsWith('.sog')
      || resolved.search !== ''
      || resolved.hash !== ''
    ) {
      throw new SceneLoadError('REMOTE_SCENE_BLOCKED')
    }
    return resolved.toString()
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  if (!uuid.test(source.id)) throw new SceneLoadError('UNSUPPORTED_SCENE_SOURCE')
  const resolved = new URL(source.localUrl)
  const isWindowsScene = resolved.protocol === 'http:'
    && resolved.hostname === 'scene.localhost'
    && resolved.port === ''
  const isNativeScene = resolved.protocol === 'scene:' && resolved.hostname === 'localhost'
  if (
    (!isWindowsScene && !isNativeScene)
    || resolved.pathname !== `/${source.id}/scene.sog`
    || resolved.search !== ''
    || resolved.hash !== ''
  ) {
    throw new SceneLoadError('REMOTE_SCENE_BLOCKED')
  }
  return source.localUrl
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
  private robotOverlay: RobotOverlayRuntime | null = null
  private followRobot = false
  private robotFirstPerson = false
  private freeCameraFov = 45
  private environmentOverlay: EnvironmentOverlayRuntime | null = null
  private removeFireFocusListener: (() => void) | null = null
  private stepDemo:StepDemoRuntime|null=null
  private fireVolume: FireVolumeRuntime | null = null
  private depthPass: RenderPass | null = null
  private depthCapture: GaussianDepthCapture | null = null
  private gsLayer: Layer | null = null
  private picker: Picker | null = null
  private groundCalibrationActive = false
  private groundCalibrationKey = 'office_01'
  private groundCalibrationPoints: Array<[number, number, number]> = []
  private groundPlane: GroundPlane | null = null
  private removeMotionPoseListener: (() => void) | null = null
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
      this.gsLayer = new Layer({ name: 'Gaussian scene only' })
      app.scene.layers.pushTransparent(this.gsLayer)
      camera.camera!.layers = [...camera.camera!.layers, this.gsLayer.id]
      this.depthCapture = new GaussianDepthCapture(app, camera, this.gsLayer)

      this.cameraController = new PlayCanvasCameraController(
        canvas,
        camera,
        this.requestRender,
      )
      this.cameraController.reset(this.initialTarget, this.initialDistance)

      this.robotOverlay = new RobotOverlayRuntime(app)
      this.stepDemo=new StepDemoRuntime(app,this.robotOverlay,()=> {
        this.setRobotFirstPerson(false)
        const matrix=this.sceneEntity?.getWorldTransform()
        const position=new Vec3(3.75,1.55,.1),target=new Vec3(3.5,.15,-.45)
        if(matrix){matrix.transformPoint(position,position);matrix.transformPoint(target,target)}
        this.cameraController?.framePose(position,target)
      })
      robotMotionPlaybackService.movementConstraint = (start,end,yaw) => this.robotOverlay ? constrainRobotMovement(this.robotOverlay.alignmentRoot,start,end,yaw) : end
      robotMotionPlaybackService.turnConstraint = (position,start,end) => this.robotOverlay ? constrainRobotTurn(this.robotOverlay.alignmentRoot,position,start,end) : end
      this.picker = new Picker(app, 1, 1, true)
      this.environmentOverlay = new EnvironmentOverlayRuntime(app)
      this.fireVolume = new FireVolumeRuntime(app, camera, this.depthCapture)
      this.removeFireFocusListener = firePlaybackService.onFocus((metadata) => {
        const lo = metadata.grid.worldLower; const hi = metadata.grid.worldUpper
        const center = new Vec3((lo[0]+hi[0])*.5, (lo[2]+hi[2])*.5, -(lo[1]+hi[1])*.5)
        this.setRobotFirstPerson(false)
        const view = ROOM_FIRE_VIEWS[metadata.scenarioId]
        if (view) this.cameraController?.framePose(new Vec3(...view.position), new Vec3(...view.target))
        else this.cameraController?.reset(center, Math.max(3.2, (hi[0]-lo[0])*1.2, (hi[2]-lo[2])*1.2))
      })
      this.removeMotionPoseListener = robotMotionPlaybackService.onPose((pose) => {
        if (this.disposed) return
        this.robotOverlay?.updatePose(pose, true)
        this.robotOverlay?.setVisible(true)
        this.updateControlsEnabled()
        this.requestRender()
      })
      this.canvas.addEventListener('pointerdown', this.handleGroundPointer, { capture: true })

      canvas.addEventListener('webglcontextlost', this.handleContextLost)
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
      this.depthPass = new RenderPass(app.graphicsDevice)
      this.depthPass.name = 'Current-frame Gaussian depth'
      this.depthPass.execute = this.handlePreRender
      camera.camera!.camera.beforePasses.push(this.depthPass)
      app.on('frameend', this.handleFrameEnd)
      app.on('update', this.handleUpdate)
      const gsplatSystem = app.systems.gsplat
      if (!gsplatSystem) throw new Error('GSPLAT_SYSTEM_UNAVAILABLE')
      app.scene.gsplat.enableIds = true
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

  setRobotVisible(visible: boolean): void {
    this.robotOverlay?.setVisible(visible)
    this.updateControlsEnabled()
    this.requestRender()
  }

  setRobotModel(modelId: SimulationModelId): void {
    this.stepDemo?.clear()
    this.robotOverlay?.setModel(modelId)
    this.updateControlsEnabled()
    this.requestRender()
  }

  updateRobotPose(pose: RobotPose, immediate = false): boolean {
    if(this.stepDemo?.active) return false
    const accepted = this.robotOverlay?.updatePose(pose, immediate) ?? false
    if (accepted) {
      if (this.followRobot && this.cameraController) {
        this.cameraController.followTarget(new Vec3(...pose.rootPosition))
      }
      this.updateControlsEnabled()
      this.requestRender()
    }
    return accepted
  }

  clearRobotPose(): void {
    if(this.stepDemo?.active) return
    this.robotOverlay?.clearPose()
    this.requestRender()
  }

  setRobotCalibration(calibration: RobotOverlayCalibration): boolean {
    this.stepDemo?.clear()
    const accepted = this.robotOverlay?.setCalibration(calibration) ?? false
    if (accepted) this.requestRender()
    return accepted
  }

  resetRobotCalibration(): void {
    this.stepDemo?.clear()
    this.robotOverlay?.resetCalibration()
    this.requestRender()
  }

  focusRobot(): boolean {
    const bounds = this.robotOverlay?.getBounds()
    if (!bounds || !this.cameraController) return false
    this.cameraController.reset(new Vec3(...bounds.center), Math.max(bounds.radius * 2.8, 0.5))
    return true
  }

  getRobotOverlayStatus(): RobotOverlayStatus | null {
    return this.robotOverlay?.getStatus() ?? null
  }

  setRobotVisualMode(mode: Go2VisualMode): void { this.robotOverlay?.setVisualMode(mode); this.requestRender() }
  reloadRobotVisuals(): void { this.robotOverlay?.reloadVisuals(); this.requestRender() }
  setRobotFirstPerson(enabled: boolean): boolean {
    const camera = this.cameraEntity?.camera
    if (!camera || !this.robotOverlay) return false
    if (enabled && !this.robotOverlay.getRobotCameraPose()) return false
    if (enabled === this.robotFirstPerson) return true
    this.robotFirstPerson = enabled
    if (enabled) {
      this.freeCameraFov = camera.fov
      camera.fov = 78
      this.applyRobotCameraPose()
    } else {
      camera.fov = this.freeCameraFov
      this.cameraController?.restorePose()
    }
    this.updateControlsEnabled()
    this.requestRender()
    return true
  }

  setEnvironmentVisible(visible: boolean): void { this.environmentOverlay?.setVisible(visible); this.updateControlsEnabled(); this.requestRender() }
  setEnvironmentGridVisible(visible: boolean): void { this.environmentOverlay?.setGridVisible(visible); this.requestRender() }
  focusEnvironment(): boolean {
    const bounds = this.environmentOverlay?.getBounds()
    if (!bounds || !this.cameraController) return false
    this.cameraController.reset(new Vec3(...bounds.center), bounds.radius * 1.45)
    return true
  }

  setRobotFollow(enabled: boolean): void { this.followRobot = enabled }
  getEnvironmentOverlayStatus(): EnvironmentOverlayStatus | null { return this.environmentOverlay?.getStatus() ?? null }

  async loadScene(source: SceneSource, signal?: AbortSignal): Promise<SceneLoadResult> {
    if (this.disposed || !this.app) throw new SceneLoadError('RUNTIME_DISPOSED')
    await this.unloadScene()
    if (signal?.aborted) throw abortError()

    const generation = ++this.loadGeneration
    this.environmentOverlay?.setVisible(false)
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
      const response = await fetch(this.sourceUrl(source), { signal })
      if (response.status === 404) throw new SceneLoadError('SCENE_NOT_FOUND')
      if (!response.ok) throw new SceneLoadError('SCENE_FETCH_FAILED')

      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SCENE_BYTES) {
        throw new SceneLoadError('SCENE_TOO_LARGE')
      }

      const blob = await response.blob()
      if (blob.size === 0) throw new SceneLoadError('SCENE_PARSE_FAILED')
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
        this.environmentOverlay?.setVisible(true)
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
    this.stepDemo?.clear()
    robotCollisionService.setScene(false)
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
    this.environmentOverlay?.setVisible(true)
    this.updateControlsEnabled()
    this.requestRender()
    this.emitStatus()
  }

  setDepthCaptureEnabled(enabled: boolean): boolean {
    gsDepthPreview.enabled = enabled
    if (!enabled) this.depthCapture?.clear()
    return !!this.depthCapture
  }
  getLatestDepthFrame() { return this.depthCapture?.frame ?? null }

  resetCamera(): void {
    if (this.disposed || !this.status.sceneLoaded) return
    this.cameraController?.reset(this.initialTarget, this.initialDistance)
  }

  updateOrientation(orientation: SceneOrientation): void {
    if (this.disposed || !this.app) throw new SceneLoadError('RUNTIME_DISPOSED')
    if (!this.sceneEntity || !this.sceneAsset || !this.status.sceneLoaded) {
      throw new SceneLoadError('SCENE_NOT_READY')
    }
    const quaternion = normalizeQuaternion(orientation.quaternion)
    this.sceneEntity.setLocalRotation(new Quat(...quaternion))
    this.robotOverlay?.setSceneOrientation(quaternion)
    this.frameLoadedScene(this.sceneAsset)
    this.requestRender()
  }

  startGroundCalibration(sceneKey = 'office_01'): void {
    if (this.disposed || !this.sceneEntity || !this.cameraEntity?.camera) return
    this.groundCalibrationKey = sceneKey
    this.groundCalibrationPoints = []
    this.groundPlane = loadGroundPlane(sceneKey)
    this.groundCalibrationActive = true
  }

  cancelGroundCalibration(): void { this.groundCalibrationActive = false; this.groundCalibrationPoints = [] }
  getGroundCalibration(): { active: boolean; points: number; plane: GroundPlane | null } {
    return { active: this.groundCalibrationActive, points: this.groundCalibrationPoints.length, plane: this.groundPlane }
  }

  private handleGroundPointer = (event: PointerEvent): void => {
    if (!this.groundCalibrationActive || !this.picker || !this.cameraEntity?.camera || !this.sceneEntity || !this.app) return
    event.preventDefault()
    event.stopPropagation()
    const rect = this.canvas.getBoundingClientRect()
    const x = event.clientX - rect.left; const y = event.clientY - rect.top
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return
    const layer = this.app.scene.layers.getLayerByName('World')
    const layers = layer ? [layer] : this.app.scene.layers.layerList
    if (!layers.length) return
    this.picker.resize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)))
    this.picker.prepare(this.cameraEntity.camera, this.app.scene, layers)
    void this.picker.getWorldPointAsync(x, y).then((point) => {
      if (!point || !this.groundCalibrationActive) {
        console.warn('[GroundCalibration] no GS world point at', x, y)
        return
      }
      console.info('[GroundCalibration] picked', point.x, point.y, point.z)
      this.groundCalibrationPoints.push([point.x, point.y, point.z])
      if (this.groundCalibrationPoints.length >= 3) {
        const plane = fitGroundPlane(this.groundCalibrationPoints, this.groundCalibrationKey)
        if (plane) { this.groundPlane = plane; saveGroundPlane(plane); this.groundCalibrationActive = false; void robotMotionPlaybackService.load() }
      }
      this.requestRender()
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.stepDemo?.dispose();this.stepDemo=null
    robotMotionPlaybackService.movementConstraint = null
    robotMotionPlaybackService.turnConstraint = null
    robotCollisionService.setScene(false)
    this.disposed = true
    this.activeRendering = false
    ++this.loadGeneration
    this.cancelPendingParse?.()
    this.cancelPendingParse = null
    this.pendingParse = null

    const app = this.app
    this.depthCapture?.dispose(); this.depthCapture = null
    if (this.gsLayer) app?.scene.layers.removeTransparent(this.gsLayer)
    this.gsLayer = null
    this.cameraController?.dispose()
    this.cameraController = null
    this.releaseLoadedScene()
    if (this.pendingAsset) this.releaseAsset(this.pendingAsset)
    this.pendingAsset = null
    this.revokeObjectUrl()

    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    this.canvas.removeEventListener('pointerdown', this.handleGroundPointer, { capture: true })
    if (this.depthPass && this.cameraEntity?.camera) {
      const passes = this.cameraEntity.camera.camera.beforePasses
      const index = passes.indexOf(this.depthPass); if (index >= 0) passes.splice(index, 1)
      this.depthPass.destroy(); this.depthPass = null
    }
    app?.off('frameend', this.handleFrameEnd)
    app?.off('update', this.handleUpdate)
    this.gsplatSystem?.off('frame:request', this.handleFrameRequest)
    this.gsplatSystem = null
    this.robotOverlay?.dispose()
    this.picker = null
    this.robotOverlay = null
    this.environmentOverlay?.dispose()
    this.environmentOverlay = null
    this.removeFireFocusListener?.(); this.removeFireFocusListener = null
    this.fireVolume?.dispose()
    this.fireVolume = null
    this.removeMotionPoseListener?.()
    this.removeMotionPoseListener = null
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
      filename: 'scene.sog',
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
          const orientation = normalizeQuaternion(
            source.orientation?.quaternion ?? [0, 0, 0, 1],
          )
          entity.setLocalRotation(new Quat(...orientation))
          this.robotOverlay?.setSceneOrientation(orientation)
          entity.addComponent('gsplat', { asset, layers: [this.gsLayer!.id] })
          app.root.addChild(entity)
          this.sceneEntity = entity
          robotCollisionService.setScene(/office[_-]?01|scene_yup/i.test(source.displayName))
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
    this.depthCapture?.clear()
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
    sceneSourceUrl(source)
  }

  private sourceUrl(source: SceneSource): string {
    return sceneSourceUrl(source)
  }

  private updateControlsEnabled(): void {
    const enabled = this.activeRendering
      && (this.status.sceneLoaded === true || this.robotOverlay?.getStatus().hasPose === true
        || this.environmentOverlay?.getStatus().visible === true)
      && !this.status.contextLost
      && !this.disposed
    this.cameraController?.setEnabled(enabled && !this.robotFirstPerson)
    this.status = { ...this.status, controlsEnabled: enabled && !this.robotFirstPerson }
  }

  private applyRobotCameraPose(): void {
    if (!this.robotFirstPerson || !this.cameraEntity || !this.robotOverlay) return
    const pose = this.robotOverlay.getRobotCameraPose()
    if (!pose) return
    this.cameraEntity.setPosition(...pose.position)
    this.cameraEntity.setRotation(new Quat(...pose.rotation))
    this.requestRender()
  }

  private readonly requestRender = (): void => {
    if (!this.app || this.disposed) return
    this.app.renderNextFrame = true
  }

  private readonly handleFrameRequest = (): void => {
    if (this.activeRendering) this.requestRender()
  }

  private readonly handlePreRender = (): void => {
    if (!this.activeRendering || this.status.contextLost) return
    const state = firePlaybackService.getState()
    const fireVisible = firePlaybackService.quality !== 'off' && ['ready', 'playing', 'paused'].includes(state.phase)
    const needsGpu = fireVisible && (firePlaybackService.depthOcclusion || (state.sceneMode === 'room' && firePlaybackService.atmosphereEnabled))
    this.depthCapture?.renderGpu(this.status.sceneLoaded === true && (needsGpu || gsDepthPreview.enabled || thermalPreview.enabled), needsGpu)
    this.fireVolume?.syncDepth()
  }

  private readonly handleFrameEnd = (): void => {
    if (!this.app || this.disposed) return
    if (this.activeRendering && this.status.sceneLoaded && !this.status.contextLost) {
      gsDepthPreview.cameraMode = this.robotFirstPerson ? '机器人第一视角' : '当前自由视角'
      thermalPreview.cameraMode = gsDepthPreview.cameraMode
      this.depthCapture?.update()
      this.status.depthAvailable = !!this.depthCapture?.frame
    }
    const now = performance.now()
    if (now - this.lastStatusSampleAt < STATUS_SAMPLE_INTERVAL_MS) return
    this.lastStatusSampleAt = now
    const fps = this.activeRendering ? Math.round(this.app.stats.frame.fps) : 0
    if (fps !== this.status.fps) {
      this.status = { ...this.status, fps }
      this.emitStatus()
    }
  }

  private readonly handleUpdate = (deltaSeconds: number): void => {
    if (!this.activeRendering || this.status.contextLost) return
    this.robotOverlay?.update()
    robotMotionPlaybackService.update(deltaSeconds)
    this.applyRobotCameraPose()
    this.fireVolume?.update(deltaSeconds)
    if(this.sceneEntity)this.stepDemo?.draw(this.sceneEntity)
    if(this.app && this.sceneEntity && this.robotOverlay) drawCollisionOverlay(this.app,this.sceneEntity,this.robotOverlay.alignmentRoot,this.robotOverlay.getCollisionPosition(),this.robotOverlay.getCollisionHeading())
  }

  private readonly handleContextLost = (): void => {
    this.depthCapture?.clear()
    if (this.disposed) return
    this.status = {
      ...this.status,
      initialized: false,
      running: false,
      contextLost: true,
      fps: 0,
      error: null,
    }
    this.robotOverlay?.setContextLost(true)
    this.environmentOverlay?.setContextLost(true)
    this.fireVolume?.setContextLost(true)
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
    this.robotOverlay?.setContextLost(false)
    this.environmentOverlay?.setContextLost(false)
    this.fireVolume?.setContextLost(false)
    this.app.autoRender = this.activeRendering
    this.updateControlsEnabled()
    this.requestRender()
    this.emitStatus()
  }

  private emitStatus(): void {
    if (!this.disposed) this.onStatusChange?.(this.getStatus())
  }
}

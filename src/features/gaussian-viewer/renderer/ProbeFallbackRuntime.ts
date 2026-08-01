import type {
  SceneLoadResult,
  SceneSource,
  ViewerRuntime,
  ViewerRuntimeOptions,
  ViewerRuntimeStatus,
} from '../types'
import { WebGl2ProbeRuntime } from './WebGl2ProbeRuntime'

const FALLBACK_ERROR = 'PLAYCANVAS_INITIALIZATION_FAILED'

export class ProbeFallbackRuntime implements ViewerRuntime {
  private readonly probe: WebGl2ProbeRuntime

  constructor(options: ViewerRuntimeOptions) {
    this.probe = new WebGl2ProbeRuntime({
      canvas: options.canvas,
      onStatusChange: (status) => options.onStatusChange(this.mapStatus(status)),
    })
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.probe.resize(width, height, pixelRatio)
  }

  start(): void {
    this.probe.start()
  }

  pause(): void {
    this.probe.pause()
  }

  loadScene(_source: SceneSource, _signal?: AbortSignal): Promise<SceneLoadResult> {
    return Promise.reject(new Error('FALLBACK_SCENE_LOADING_UNSUPPORTED'))
  }

  unloadScene(): Promise<void> {
    return Promise.resolve()
  }

  resetCamera(): void {
    // The probe has no scene or camera.
  }

  dispose(): void {
    this.probe.dispose()
  }

  getStatus(): ViewerRuntimeStatus {
    return this.mapStatus(this.probe.getStatus())
  }

  private mapStatus(status: ViewerRuntimeStatus): ViewerRuntimeStatus {
    return {
      ...status,
      renderer: 'WebGL2 diagnostics',
      scenePhase: 'idle',
      sceneName: null,
      progress: null,
      sceneLoaded: false,
      controlsEnabled: false,
      fallback: true,
      error: status.error ?? FALLBACK_ERROR,
    }
  }
}

export type ViewerBackend = 'WebGL2 Probe' | 'PlayCanvas WebGL2'

import type { SceneOrientation } from '../../services/scenes/types'
import type { RobotPose } from '../../services/simulation/types'
import type {
  RobotOverlayCalibration,
  RobotOverlayStatus,
} from './robot/RobotOverlayRuntime'

export const MAX_SCENE_BYTES = 50 * 1024 * 1024

export type SceneSource =
  | {
      kind: 'managed-scene'
      id: string
      localUrl: string
      displayName: string
      byteSize: number
      orientation?: SceneOrientation
    }
  | {
      kind: 'dev-public-url'
      url: string
      displayName: string
      orientation?: SceneOrientation
    }

export type SceneLoadPhase =
  | 'idle'
  | 'fetching'
  | 'parsing'
  | 'ready'
  | 'unloading'
  | 'error'

export interface SceneLoadResult {
  source: SceneSource
  loadedAt: number
  format: 'sog'
}

export interface ViewerRuntimeStatus {
  backend: ViewerBackend
  renderer?: string
  initialized: boolean
  running: boolean
  contextLost: boolean
  fps: number
  width: number
  height: number
  pixelRatio: number
  scenePhase?: SceneLoadPhase
  sceneName?: string | null
  progress?: number | null
  sceneLoaded?: boolean
  controlsEnabled?: boolean
  fallback?: boolean
  error: string | null
}

export interface ViewerRuntime {
  resize(width: number, height: number, pixelRatio: number): void
  start(): void
  pause(): void
  loadScene?(
    source: SceneSource,
    signal?: AbortSignal,
  ): Promise<SceneLoadResult>
  unloadScene?(): Promise<void>
  updateOrientation?(orientation: SceneOrientation): void
  resetCamera?(): void
  setRobotVisible?(visible: boolean): void
  updateRobotPose?(pose: RobotPose, immediate?: boolean): boolean
  clearRobotPose?(): void
  setRobotCalibration?(calibration: RobotOverlayCalibration): boolean
  resetRobotCalibration?(): void
  focusRobot?(): boolean
  getRobotOverlayStatus?(): RobotOverlayStatus | null
  dispose(): void
  getStatus(): ViewerRuntimeStatus
}

export interface ViewerRuntimeOptions {
  canvas: HTMLCanvasElement
  onStatusChange: (status: ViewerRuntimeStatus) => void
}

export type ViewerPhase =
  | 'initializing'
  | 'ready'
  | 'unsupported'
  | 'context-lost'
  | 'failed'
  | 'waiting-layout'
  | 'fallback'
  | 'scene-error'

export interface GaussianViewerState {
  phase: ViewerPhase
  status: ViewerRuntimeStatus | null
  message: string | null
}

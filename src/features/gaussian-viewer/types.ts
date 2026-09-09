export type ViewerBackend = 'WebGL2 Probe' | 'PlayCanvas WebGL2'

import type { SceneOrientation } from '../../services/scenes/types'
import type { RobotPose, SimulationModelId } from '../../services/simulation/types'
import type {
  RobotOverlayCalibration,
  RobotOverlayStatus,
} from './robot/RobotOverlayRuntime'
import type { Go2VisualMode } from './robot/go2VisualManifest'
import type { EnvironmentOverlayStatus } from './environment/environmentTypes'
import type { GroundPlane } from '../../services/robot-motion-playback/groundPlaneService'

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
  /** True when the Gaussian renderer can produce a linear depth frame. */
  depthAvailable?: boolean
}

export interface GaussianDepthFrame {
  width: number
  height: number
  /** Linear camera-space depth in metres; 0 marks an invalid/empty pixel. */
  values: Float32Array
  sequence: number
  timestampMs: number
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
  setRobotModel?(modelId: SimulationModelId): void
  updateRobotPose?(pose: RobotPose, immediate?: boolean): boolean
  clearRobotPose?(): void
  setRobotCalibration?(calibration: RobotOverlayCalibration): boolean
  resetRobotCalibration?(): void
  focusRobot?(): boolean
  setRobotFollow?(enabled: boolean): void
  getRobotOverlayStatus?(): RobotOverlayStatus | null
  setRobotVisualMode?(mode: Go2VisualMode): void
  reloadRobotVisuals?(): void
  setRobotFirstPerson?(enabled: boolean): boolean
  /** Toggle the Gaussian depth pass independently from the RGB pass. */
  setDepthCaptureEnabled?(enabled: boolean): boolean
  /** Returns the most recently rendered Gaussian depth frame, if available. */
  getLatestDepthFrame?(): GaussianDepthFrame | null
  startGroundCalibration?(sceneKey?: string): void
  cancelGroundCalibration?(): void
  getGroundCalibration?(): { active: boolean; points: number; plane: GroundPlane | null }
  setEnvironmentVisible?(visible: boolean): void
  setEnvironmentGridVisible?(visible: boolean): void
  focusEnvironment?(): boolean
  getEnvironmentOverlayStatus?(): EnvironmentOverlayStatus | null
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

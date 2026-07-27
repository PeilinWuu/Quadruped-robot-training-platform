export type ViewerBackend = 'WebGL2 Probe'

export interface ViewerRuntimeStatus {
  backend: ViewerBackend
  initialized: boolean
  running: boolean
  contextLost: boolean
  fps: number
  width: number
  height: number
  pixelRatio: number
  error: string | null
}

export interface ViewerRuntime {
  resize(width: number, height: number, pixelRatio: number): void
  start(): void
  pause(): void
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

export interface GaussianViewerState {
  phase: ViewerPhase
  status: ViewerRuntimeStatus | null
  message: string | null
}

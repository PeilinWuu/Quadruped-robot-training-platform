import type { ViewerRuntime, ViewerRuntimeOptions } from '../types'
import { PlayCanvasGsRuntime } from './PlayCanvasGsRuntime'
import { ProbeFallbackRuntime } from './ProbeFallbackRuntime'

export function createViewerRuntime(options: ViewerRuntimeOptions): ViewerRuntime {
  try {
    return new PlayCanvasGsRuntime(options)
  } catch {
    console.error('[GaussianViewer] PlayCanvas initialization failed; using WebGL2 diagnostics')
    return new ProbeFallbackRuntime(options)
  }
}

import type { ViewerRuntime, ViewerRuntimeOptions } from '../types'
import { WebGl2ProbeRuntime } from './WebGl2ProbeRuntime'

export function createViewerRuntime(options: ViewerRuntimeOptions): ViewerRuntime {
  return new WebGl2ProbeRuntime(options)
}

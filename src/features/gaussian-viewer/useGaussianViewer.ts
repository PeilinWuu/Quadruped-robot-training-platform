import { useEffect, useRef, useState } from 'react'
import type {
  GaussianViewerState,
  ViewerRuntime,
  ViewerRuntimeStatus,
} from './types'

const INITIAL_STATE: GaussianViewerState = {
  phase: 'initializing',
  status: null,
  message: null,
}

function stateFromStatus(status: ViewerRuntimeStatus): GaussianViewerState {
  if (status.error === 'WEBGL2_UNSUPPORTED') {
    return { phase: 'unsupported', status, message: null }
  }
  if (status.error) {
    return { phase: 'failed', status, message: 'Viewer 初始化失败' }
  }
  if (status.contextLost) {
    return { phase: 'context-lost', status, message: null }
  }
  if (status.width === 0 || status.height === 0) {
    return { phase: 'waiting-layout', status, message: null }
  }
  return { phase: status.initialized ? 'ready' : 'initializing', status, message: null }
}

export function useGaussianViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [viewerState, setViewerState] = useState<GaussianViewerState>(INITIAL_STATE)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) {
      setViewerState({ phase: 'failed', status: null, message: 'Viewer 初始化失败' })
      return
    }

    let disposed = false
    let runtime: ViewerRuntime | null = null
    let observer: ResizeObserver | null = null
    let resizeRafId: number | null = null
    let pendingSize: { width: number; height: number } | null = null
    let appliedSize = { width: -1, height: -1, pixelRatio: -1 }

    const reportStatus = (status: ViewerRuntimeStatus) => {
      if (!disposed) setViewerState(stateFromStatus(status))
    }

    const applyResize = () => {
      resizeRafId = null
      if (disposed || !pendingSize) return
      const width = Math.floor(pendingSize.width)
      const height = Math.floor(pendingSize.height)
      const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
      if (
        !Number.isFinite(width)
        || !Number.isFinite(height)
        || !Number.isFinite(pixelRatio)
        || width < 0
        || height < 0
      ) {
        setViewerState({
          phase: 'failed',
          status: runtime?.getStatus() ?? null,
          message: 'Viewer 初始化失败',
        })
        return
      }
      if (
        width === appliedSize.width
        && height === appliedSize.height
        && pixelRatio === appliedSize.pixelRatio
      ) return

      appliedSize = { width, height, pixelRatio }
      if (runtime) {
        runtime.resize(width, height, pixelRatio)
      } else if (width === 0 || height === 0) {
        setViewerState({ phase: 'waiting-layout', status: null, message: null })
      }
    }

    const handleResize = (entries: ResizeObserverEntry[]) => {
      const entry = entries.at(-1)
      if (!entry || disposed) return
      pendingSize = { width: entry.contentRect.width, height: entry.contentRect.height }
      if (resizeRafId === null) resizeRafId = requestAnimationFrame(applyResize)
    }

    const handleVisibilityChange = () => {
      if (!runtime || disposed) return
      if (document.visibilityState === 'hidden') runtime.pause()
      else runtime.start()
    }

    try {
      observer = new ResizeObserver(handleResize)
      observer.observe(container)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      setViewerState(INITIAL_STATE)
    } catch {
      console.error('[GaussianViewer] Viewer lifecycle setup failed')
      setViewerState({ phase: 'failed', status: null, message: 'Viewer 初始化失败' })
      return () => {
        disposed = true
        observer?.disconnect()
      }
    }

    void import('./renderer/createViewerRuntime')
      .then(({ createViewerRuntime }) => {
        if (disposed) return
        const nextRuntime = createViewerRuntime({ canvas, onStatusChange: reportStatus })
        if (disposed) {
          nextRuntime.dispose()
          return
        }

        runtime = nextRuntime
        if (appliedSize.width >= 0 && appliedSize.height >= 0) {
          runtime.resize(appliedSize.width, appliedSize.height, appliedSize.pixelRatio)
        }
        if (document.visibilityState === 'hidden') runtime.pause()
        else runtime.start()
        reportStatus(runtime.getStatus())
      })
      .catch(() => {
        if (!disposed) {
          console.error('[GaussianViewer] Viewer runtime module failed to load')
          setViewerState({ phase: 'failed', status: null, message: 'Viewer 初始化失败' })
        }
      })

    return () => {
      disposed = true
      observer?.disconnect()
      observer = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      resizeRafId = null
      pendingSize = null
      runtime?.dispose()
      runtime = null
    }
  }, [])

  return { containerRef, canvasRef, viewerState }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSceneAdapter,
  sceneImportSupported,
  updateSceneOrientation,
} from '../../services/scenes/sceneService'
import type {
  ImportProgress,
  OrientationAxis,
  SceneOrientation,
  SceneRecord,
} from '../../services/scenes/types'
import { rotateOrientation, SceneServiceError } from '../../services/scenes/types'
import type {
  GaussianViewerState,
  SceneSource,
  ViewerRuntime,
  ViewerRuntimeStatus,
} from './types'

const DEV_TEST_SCENE_SOURCE: SceneSource | null = import.meta.env.DEV
  ? {
      kind: 'dev-public-url',
      url: `${import.meta.env.BASE_URL}gs/local/test-scene.sog`,
      displayName: 'test-scene.sog',
      orientation: { quaternion: [0, 0, 1, 0] },
    }
  : null

const INITIAL_STATE: GaussianViewerState = {
  phase: 'initializing',
  status: null,
  message: null,
}

type ImportUiState = {
  phase: 'idle' | 'choosing' | ImportProgress['phase'] | 'cancelling'
  progress: ImportProgress | null
  operationId: string | null
  message: string | null
  error: string | null
}

const INITIAL_IMPORT_STATE: ImportUiState = {
  phase: 'idle',
  progress: null,
  operationId: null,
  message: null,
  error: null,
}

export function sourceFromRecord(scene: SceneRecord): SceneSource {
  return {
    kind: 'managed-scene',
    id: scene.id,
    localUrl: scene.localUrl,
    displayName: scene.displayName,
    byteSize: scene.byteSize,
    orientation: scene.orientation,
  }
}

function stateFromStatus(status: ViewerRuntimeStatus): GaussianViewerState {
  if (status.fallback) {
    return {
      phase: 'fallback',
      status,
      message: 'PlayCanvas 初始化失败，当前仅运行 WebGL2 诊断',
    }
  }
  if (status.error === 'WEBGL2_UNSUPPORTED') {
    return { phase: 'unsupported', status, message: null }
  }
  if (status.contextLost) {
    return { phase: 'context-lost', status, message: null }
  }
  if (status.scenePhase === 'error') {
    const message = status.error === 'SCENE_NOT_FOUND'
      ? '场景文件不存在或已失效'
      : status.error === 'LOAD_CANCELLED'
        ? '场景加载已取消'
        : 'SOG 场景加载失败'
    return { phase: 'scene-error', status, message }
  }
  if (status.error) {
    return { phase: 'failed', status, message: 'Viewer 初始化失败' }
  }
  if (status.width === 0 || status.height === 0) {
    return { phase: 'waiting-layout', status, message: null }
  }
  return { phase: status.initialized ? 'ready' : 'initializing', status, message: null }
}

function safeSceneMessage(error: unknown): string {
  if (error instanceof SceneServiceError) return error.message
  return '本地场景操作失败'
}

export function useGaussianViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const runtimeRef = useRef<ViewerRuntime | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const lifecycleGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const activeSourceRef = useRef<SceneSource | null>(null)
  const [viewerState, setViewerState] = useState<GaussianViewerState>(INITIAL_STATE)
  const [scenes, setScenes] = useState<SceneRecord[]>([])
  const [currentScene, setCurrentScene] = useState<SceneRecord | null>(null)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [orientationBusy, setOrientationBusy] = useState(false)
  const [importState, setImportState] = useState<ImportUiState>(INITIAL_IMPORT_STATE)
  const desktop = sceneImportSupported()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadSceneSource = useCallback((
    source: SceneSource,
    runtimeOverride?: ViewerRuntime,
    expectedGeneration = lifecycleGenerationRef.current,
  ) => {
    const runtime = runtimeOverride ?? runtimeRef.current
    if (!runtime?.loadScene || runtime.getStatus().fallback) return
    activeSourceRef.current = source
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    void runtime.loadScene(source, controller.signal)
      .catch(() => {
        // Runtime status reports sanitized loading and cancellation errors.
      })
      .finally(() => {
        if (
          lifecycleGenerationRef.current === expectedGeneration
          && loadAbortRef.current === controller
        ) {
          loadAbortRef.current = null
        }
      })
  }, [])

  const bootstrapScenes = useCallback(async (
    runtime: ViewerRuntime,
    expectedGeneration: number,
  ) => {
    try {
      const adapter = await getSceneAdapter()
      const [nextScenes, nextCurrent] = await Promise.all([
        adapter.listScenes(),
        adapter.getCurrentScene(),
      ])
      if (!mountedRef.current || expectedGeneration !== lifecycleGenerationRef.current) return
      setScenes(nextScenes)
      setCurrentScene(nextCurrent)
      setLibraryError(null)
      if (nextCurrent) {
        loadSceneSource(sourceFromRecord(nextCurrent), runtime, expectedGeneration)
      } else if (!adapter.desktop && DEV_TEST_SCENE_SOURCE) {
        loadSceneSource(DEV_TEST_SCENE_SOURCE, runtime, expectedGeneration)
      }
    } catch (error: unknown) {
      if (mountedRef.current && expectedGeneration === lifecycleGenerationRef.current) {
        setLibraryError(safeSceneMessage(error))
      }
    }
  }, [loadSceneSource])

  const reloadScene = useCallback(() => {
    const source = activeSourceRef.current
    if (source) loadSceneSource(source)
  }, [loadSceneSource])

  const abortCurrentLoad = useCallback(() => {
    loadAbortRef.current?.abort()
    loadAbortRef.current = null
  }, [])

  const unloadSceneAsync = useCallback(async () => {
    abortCurrentLoad()
    const runtime = runtimeRef.current
    if (!runtime?.unloadScene) return
    try {
      await runtime.unloadScene()
    } catch {
      // Runtime status remains authoritative for unload errors.
    }
  }, [abortCurrentLoad])

  const unloadScene = useCallback(() => {
    void unloadSceneAsync()
  }, [unloadSceneAsync])

  const resetCamera = useCallback(() => {
    runtimeRef.current?.resetCamera?.()
  }, [])

  const persistOrientation = useCallback(async (nextOrientation: SceneOrientation) => {
    const scene = currentScene
    const runtime = runtimeRef.current
    if (!scene || !runtime?.updateOrientation || orientationBusy) return
    const previousOrientation = scene.orientation
    setOrientationBusy(true)
    setLibraryError(null)
    try {
      runtime.updateOrientation(nextOrientation)
      const updated = await updateSceneOrientation(scene.id, nextOrientation.quaternion)
      if (!mountedRef.current) return
      setCurrentScene(updated)
      setScenes((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (activeSourceRef.current?.kind === 'managed-scene'
        && activeSourceRef.current.id === updated.id) {
        activeSourceRef.current = sourceFromRecord(updated)
      }
      setImportState({ ...INITIAL_IMPORT_STATE, message: '场景朝向已保存' })
    } catch (error: unknown) {
      try {
        runtime.updateOrientation(previousOrientation)
      } catch {
        // Runtime status and the sanitized persistence error remain authoritative.
      }
      if (mountedRef.current) setLibraryError(safeSceneMessage(error))
    } finally {
      if (mountedRef.current) setOrientationBusy(false)
    }
  }, [currentScene, orientationBusy])

  const rotateSceneOrientation = useCallback((axis: OrientationAxis, degrees: number) => {
    if (!currentScene) return
    void persistOrientation(rotateOrientation(currentScene.orientation, axis, degrees))
  }, [currentScene, persistOrientation])

  const resetSceneOrientation = useCallback(() => {
    void persistOrientation({ quaternion: [0, 0, 0, 1] })
  }, [persistOrientation])

  const refreshLibrary = useCallback(async () => {
    const adapter = await getSceneAdapter()
    const [nextScenes, nextCurrent] = await Promise.all([
      adapter.listScenes(),
      adapter.getCurrentScene(),
    ])
    if (!mountedRef.current) return
    setScenes(nextScenes)
    setCurrentScene(nextCurrent)
  }, [])

  const importScene = useCallback(async () => {
    setImportState({ ...INITIAL_IMPORT_STATE, phase: 'choosing' })
    const existingIds = new Set(scenes.map((scene) => scene.id))
    try {
      const adapter = await getSceneAdapter()
      const result = await adapter.chooseAndImportScene({
        onOperationStart: (operationId) => {
          if (mountedRef.current) {
            setImportState({
              phase: 'copying',
              progress: null,
              operationId,
              message: null,
              error: null,
            })
          }
        },
        onProgress: (progress) => {
          if (mountedRef.current) {
            setImportState((current) => ({ ...current, phase: progress.phase, progress }))
          }
        },
        onOperationEnd: () => undefined,
      })
      if (!mountedRef.current) return
      if (result.status === 'cancelled') {
        setImportState({ ...INITIAL_IMPORT_STATE, message: '已取消选择' })
        return
      }
      await refreshLibrary()
      loadSceneSource(sourceFromRecord(result.scene))
      setImportState({
        ...INITIAL_IMPORT_STATE,
        message: existingIds.has(result.scene.id)
          ? '场景已存在，已切换到该场景'
          : 'SOG 场景导入完成',
      })
    } catch (error: unknown) {
      if (mountedRef.current) {
        setImportState({ ...INITIAL_IMPORT_STATE, error: safeSceneMessage(error) })
      }
    }
  }, [loadSceneSource, refreshLibrary, scenes])

  const cancelImport = useCallback(async () => {
    const operationId = importState.operationId
    if (!operationId) return
    setImportState((current) => ({ ...current, phase: 'cancelling' }))
    try {
      const adapter = await getSceneAdapter()
      await adapter.cancelImport(operationId)
    } catch (error: unknown) {
      if (mountedRef.current) {
        setImportState((current) => ({ ...current, error: safeSceneMessage(error) }))
      }
    }
  }, [importState.operationId])

  const selectScene = useCallback(async (sceneId: string) => {
    try {
      const adapter = await getSceneAdapter()
      const scene = await adapter.setCurrentScene(sceneId)
      if (!mountedRef.current) return
      setCurrentScene(scene)
      setLibraryError(null)
      loadSceneSource(sourceFromRecord(scene))
    } catch (error: unknown) {
      if (mountedRef.current) setLibraryError(safeSceneMessage(error))
    }
  }, [loadSceneSource])

  const deleteScene = useCallback(async (sceneId: string) => {
    try {
      if (currentScene?.id === sceneId) {
        await unloadSceneAsync()
        activeSourceRef.current = null
      }
      const adapter = await getSceneAdapter()
      await adapter.deleteScene(sceneId)
      await refreshLibrary()
      if (mountedRef.current) {
        setImportState({ ...INITIAL_IMPORT_STATE, message: '场景已删除' })
      }
    } catch (error: unknown) {
      if (mountedRef.current) setLibraryError(safeSceneMessage(error))
    }
  }, [currentScene?.id, refreshLibrary, unloadSceneAsync])

  const clearRuntimeRef = useCallback((expectedRuntime: ViewerRuntime | null) => {
    if (runtimeRef.current === expectedRuntime) runtimeRef.current = null
  }, [])

  useEffect(() => {
    const lifecycleGeneration = ++lifecycleGenerationRef.current
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
        runtimeRef.current = nextRuntime
        if (appliedSize.width >= 0 && appliedSize.height >= 0) {
          runtime.resize(appliedSize.width, appliedSize.height, appliedSize.pixelRatio)
        }
        if (document.visibilityState === 'hidden') runtime.pause()
        else runtime.start()
        reportStatus(runtime.getStatus())
        void bootstrapScenes(runtime, lifecycleGeneration)
      })
      .catch(() => {
        if (!disposed) {
          console.error('[GaussianViewer] Viewer runtime module failed to load')
          setViewerState({ phase: 'failed', status: null, message: 'Viewer 初始化失败' })
        }
      })

    return () => {
      disposed = true
      abortCurrentLoad()
      observer?.disconnect()
      observer = null
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      resizeRafId = null
      pendingSize = null
      runtime?.dispose()
      clearRuntimeRef(runtime)
      runtime = null
    }
  }, [abortCurrentLoad, bootstrapScenes, clearRuntimeRef])

  return {
    containerRef,
    canvasRef,
    viewerState,
    desktop,
    scenes,
    currentScene,
    libraryError,
    importState,
    importScene,
    cancelImport,
    selectScene,
    deleteScene,
    reloadScene,
    unloadScene,
    resetCamera,
    orientationBusy,
    rotateSceneOrientation,
    resetSceneOrientation,
  }
}

import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  ImportCallbacks,
  ImportProgress,
  ImportResult,
  SceneAdapter,
  SceneRecord,
} from './types'
import { SceneServiceError } from './types'

interface CommandError {
  code?: unknown
  message?: unknown
}

function sceneError(error: unknown): SceneServiceError {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as CommandError
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return new SceneServiceError(candidate.code, candidate.message)
    }
  }
  return new SceneServiceError('INTERNAL_ERROR', '本地场景处理失败')
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error: unknown) {
    throw sceneError(error)
  }
}

export const tauriSceneAdapter: SceneAdapter = {
  desktop: true,
  listScenes: () => call('scene_list'),
  getCurrentScene: () => call('scene_current'),
  async chooseAndImportScene(callbacks: ImportCallbacks): Promise<ImportResult> {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const sourcePath = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Gaussian SOG', extensions: ['sog'] }],
    })
    if (sourcePath === null) return { status: 'cancelled' }

    const operationId = crypto.randomUUID()
    const progress = new Channel<ImportProgress>((message) => callbacks.onProgress(message))
    callbacks.onOperationStart(operationId)
    try {
      const scene = await call<SceneRecord>('scene_import', {
        sourcePath,
        operationId,
        progress,
      })
      return { status: 'imported', scene }
    } finally {
      progress.onmessage = () => undefined
      callbacks.onOperationEnd()
    }
  },
  cancelImport: (operationId) => call('scene_cancel_import', { operationId }),
  setCurrentScene: (sceneId) => call('scene_set_current', { sceneId }),
  updateSceneOrientation: (sceneId, quaternion) => call('scene_update_orientation', {
    sceneId,
    quaternion,
  }),
  deleteScene: (sceneId) => call('scene_delete', { sceneId }),
}

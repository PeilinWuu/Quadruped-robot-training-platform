import type { ImportResult, SceneAdapter } from './types'
import { SceneServiceError } from './types'

function unsupported(): never {
  throw new SceneServiceError('DESKTOP_ONLY', '场景导入仅桌面应用支持')
}

export const browserSceneAdapter: SceneAdapter = {
  desktop: false,
  listScenes: async () => [],
  getCurrentScene: async () => null,
  chooseAndImportScene: async (): Promise<ImportResult> => unsupported(),
  cancelImport: async () => unsupported(),
  setCurrentScene: async () => unsupported(),
  updateSceneOrientation: async () => unsupported(),
  deleteScene: async () => unsupported(),
}

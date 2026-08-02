import { isDesktopSceneRuntime } from './runtime'
import type { Quaternion, SceneAdapter, SceneRecord } from './types'

let adapterPromise: Promise<SceneAdapter> | null = null

export function sceneImportSupported(): boolean {
  return isDesktopSceneRuntime()
}

export function getSceneAdapter(): Promise<SceneAdapter> {
  adapterPromise ??= isDesktopSceneRuntime()
    ? import('./tauriSceneAdapter').then(({ tauriSceneAdapter }) => tauriSceneAdapter)
    : import('./browserSceneAdapter').then(({ browserSceneAdapter }) => browserSceneAdapter)
  return adapterPromise
}

export async function updateSceneOrientation(
  sceneId: string,
  quaternion: Quaternion,
): Promise<SceneRecord> {
  const adapter = await getSceneAdapter()
  return adapter.updateSceneOrientation(sceneId, quaternion)
}

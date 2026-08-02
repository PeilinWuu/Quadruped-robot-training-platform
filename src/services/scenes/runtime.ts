import { isTauri } from '@tauri-apps/api/core'

export function isDesktopSceneRuntime(): boolean {
  return isTauri()
}

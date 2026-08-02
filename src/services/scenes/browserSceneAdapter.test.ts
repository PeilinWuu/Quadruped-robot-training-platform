import { describe, expect, it } from 'vitest'
import { browserSceneAdapter } from './browserSceneAdapter'

describe('browserSceneAdapter', () => {
  it('does not expose desktop persistence in browser mode', async () => {
    await expect(browserSceneAdapter.listScenes()).resolves.toEqual([])
    await expect(browserSceneAdapter.getCurrentScene()).resolves.toBeNull()
    await expect(browserSceneAdapter.chooseAndImportScene({
      onOperationStart: () => undefined,
      onProgress: () => undefined,
      onOperationEnd: () => undefined,
    })).rejects.toMatchObject({ code: 'DESKTOP_ONLY' })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, open } = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class Channel<T> {
    onmessage: (message: T) => void
    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage
    }
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))

describe('tauriSceneAdapter', () => {
  beforeEach(() => {
    invoke.mockReset()
    open.mockReset()
  })

  it('treats picker cancellation as normal and does not invoke Rust', async () => {
    open.mockResolvedValue(null)
    const { tauriSceneAdapter } = await import('./tauriSceneAdapter')
    const result = await tauriSceneAdapter.chooseAndImportScene({
      onOperationStart: vi.fn(),
      onProgress: vi.fn(),
      onOperationEnd: vi.fn(),
    })
    expect(result).toEqual({ status: 'cancelled' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('uses one path only as the scene_import command argument', async () => {
    open.mockResolvedValue('C:\\selected\\scene.sog')
    const scene = {
      id: '123e4567-e89b-42d3-a456-426614174000',
      displayName: 'scene.sog',
      storedFilename: 'scene.sog',
      byteSize: 100,
      sha256: 'a'.repeat(64),
      importedAt: 1,
      sourceFormat: 'sog',
      orientation: { quaternion: [0, 0, 0, 1] },
      localUrl: 'http://scene.localhost/123e4567-e89b-42d3-a456-426614174000/scene.sog',
    }
    invoke.mockResolvedValue(scene)
    const started = vi.fn()
    const ended = vi.fn()
    const { tauriSceneAdapter } = await import('./tauriSceneAdapter')
    await expect(tauriSceneAdapter.chooseAndImportScene({
      onOperationStart: started,
      onProgress: vi.fn(),
      onOperationEnd: ended,
    })).resolves.toEqual({ status: 'imported', scene })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toBe('scene_import')
    expect(invoke.mock.calls[0][1]).toMatchObject({ sourcePath: 'C:\\selected\\scene.sog' })
    expect(started).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('maps sanitized Rust command errors', async () => {
    invoke.mockRejectedValue({ code: 'INVALID_SOG', message: 'SOG 文件已损坏或结构无效' })
    const { tauriSceneAdapter } = await import('./tauriSceneAdapter')
    await expect(tauriSceneAdapter.deleteScene('123e4567-e89b-42d3-a456-426614174000'))
      .rejects.toMatchObject({ code: 'INVALID_SOG' })
  })

  it('updates one ready scene orientation through the dedicated command', async () => {
    invoke.mockResolvedValue({ orientation: { quaternion: [0, 1, 0, 0] } })
    const { tauriSceneAdapter } = await import('./tauriSceneAdapter')
    await tauriSceneAdapter.updateSceneOrientation(
      '123e4567-e89b-42d3-a456-426614174000',
      [0, 2, 0, 0],
    )
    expect(invoke).toHaveBeenCalledWith('scene_update_orientation', {
      sceneId: '123e4567-e89b-42d3-a456-426614174000',
      quaternion: [0, 2, 0, 0],
    })
  })
})

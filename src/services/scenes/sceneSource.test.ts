// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sceneSourceUrl } from '../../features/gaussian-viewer/renderer/PlayCanvasGsRuntime'
import type { SceneSource } from '../../features/gaussian-viewer/types'

const id = '123e4567-e89b-42d3-a456-426614174000'

function managed(localUrl: string, sceneId = id): SceneSource {
  return {
    kind: 'managed-scene',
    id: sceneId,
    localUrl,
    displayName: 'scene.sog',
    byteSize: 100,
  }
}

describe('managed scene URL validation', () => {
  it('accepts only the opaque Windows scene URL for the matching UUID', () => {
    const url = `http://scene.localhost/${id}/scene.sog`
    expect(sceneSourceUrl(managed(url))).toBe(url)
  })

  it.each([
    `file:///C:/scene.sog`,
    `https://example.com/${id}/scene.sog`,
    `data:application/octet-stream,test`,
    `blob:http://tauri.localhost/value`,
    `http://scene.localhost/${id}/other.sog`,
    `http://scene.localhost/${id}/scene.sog?path=C:`,
  ])('rejects untrusted URL %s', (url) => {
    expect(() => sceneSourceUrl(managed(url))).toThrow()
  })

  it('rejects a non-v4 scene identifier', () => {
    expect(() => sceneSourceUrl(managed(`http://scene.localhost/${id}/scene.sog`, '../scene'))).toThrow()
  })
})

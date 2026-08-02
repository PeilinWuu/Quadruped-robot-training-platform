// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PlayCanvasGsRuntime } from '../../features/gaussian-viewer/renderer/PlayCanvasGsRuntime'
import { sourceFromRecord } from '../../features/gaussian-viewer/useGaussianViewer'
import {
  normalizeQuaternion,
  rotateOrientation,
  type Quaternion,
  type SceneRecord,
} from './types'

const identity: Quaternion = [0, 0, 0, 1]

function expectEquivalent(actual: Quaternion, expected: Quaternion): void {
  const dot = actual.reduce((sum, value, index) => sum + value * expected[index], 0)
  expect(Math.abs(dot)).toBeCloseTo(1, 10)
}

describe('scene orientation quaternion math', () => {
  it('preserves identity and normalizes every result', () => {
    expect(normalizeQuaternion(identity)).toEqual(identity)
    const result = rotateOrientation({ quaternion: [0, 0, 0, 2] }, 'x', 90).quaternion
    expect(Math.hypot(...result)).toBeCloseTo(1, 12)
  })

  it.each([
    ['x', [Math.SQRT1_2, 0, 0, Math.SQRT1_2]],
    ['y', [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
    ['z', [0, 0, Math.SQRT1_2, Math.SQRT1_2]],
  ] as const)('left-multiplies a +90 degree %s world-axis rotation', (axis, expected) => {
    expectEquivalent(rotateOrientation({ quaternion: identity }, axis, 90).quaternion, [...expected])
  })

  it('composes two quarter turns to 180 and four to equivalent identity', () => {
    let orientation = { quaternion: identity }
    orientation = rotateOrientation(orientation, 'y', 90)
    orientation = rotateOrientation(orientation, 'y', 90)
    expectEquivalent(orientation.quaternion, [0, 1, 0, 0])
    orientation = rotateOrientation(orientation, 'y', 90)
    orientation = rotateOrientation(orientation, 'y', 90)
    expectEquivalent(orientation.quaternion, identity)
  })

  it('rejects zero-length and non-finite quaternions', () => {
    expect(() => normalizeQuaternion([0, 0, 0, 0])).toThrow('INVALID_ORIENTATION')
    expect(() => normalizeQuaternion([Number.NaN, 0, 0, 1])).toThrow('INVALID_ORIENTATION')
  })

  it('passes persisted orientation from SceneRecord to SceneSource', () => {
    const record: SceneRecord = {
      id: '123e4567-e89b-42d3-a456-426614174000',
      displayName: 'scene.sog',
      storedFilename: 'scene.sog',
      byteSize: 1,
      sha256: 'a'.repeat(64),
      importedAt: 1,
      sourceFormat: 'sog',
      orientation: { quaternion: [0, 1, 0, 0] },
      localUrl: 'http://scene.localhost/123e4567-e89b-42d3-a456-426614174000/scene.sog',
    }
    expect(sourceFromRecord(record).orientation).toEqual(record.orientation)
  })

  it('updates the loaded entity and framing without loading the SOG again', () => {
    const setLocalRotation = vi.fn()
    const frameLoadedScene = vi.fn()
    const requestRender = vi.fn()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const runtimeState = {
      disposed: false,
      app: {},
      sceneEntity: { setLocalRotation },
      sceneAsset: {},
      status: { sceneLoaded: true },
      frameLoadedScene,
      requestRender,
    }
    Reflect.apply(
      PlayCanvasGsRuntime.prototype.updateOrientation,
      runtimeState,
      [{ quaternion: [0, 0, 0, 1] }],
    )
    expect(setLocalRotation).toHaveBeenCalledTimes(1)
    expect(frameLoadedScene).toHaveBeenCalledTimes(1)
    expect(requestRender).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

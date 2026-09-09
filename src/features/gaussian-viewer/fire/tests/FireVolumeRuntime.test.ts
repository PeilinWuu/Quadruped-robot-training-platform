import { describe, expect, it } from 'vitest'
import { sourceCOrderToWebGlTexture } from '../FireVolumeRuntime'

describe('fire volume texture layout', () => {
  it('converts NumPy C-order xyz RG data to WebGL x-fastest slices', () => {
    const dimensions: [number, number, number] = [2, 2, 2]
    const source = new Uint8Array(2 * 2 * 2 * 2)
    for (let x = 0; x < 2; x += 1) for (let y = 0; y < 2; y += 1) for (let z = 0; z < 2; z += 1) {
      const offset = ((x * 2 + y) * 2 + z) * 2
      source[offset] = x * 100 + y * 10 + z
      source[offset + 1] = 200 + x * 20 + y * 2 + z
    }
    const result = sourceCOrderToWebGlTexture(source, dimensions)
    for (let z = 0; z < 2; z += 1) for (let y = 0; y < 2; y += 1) for (let x = 0; x < 2; x += 1) {
      const offset = ((z * 2 + y) * 2 + x) * 2
      expect(result[offset]).toBe(x * 100 + y * 10 + z)
      expect(result[offset + 1]).toBe(200 + x * 20 + y * 2 + z)
    }
  })

  it('rejects truncated frames', () => {
    expect(() => sourceCOrderToWebGlTexture(new Uint8Array(3), [1, 1, 2])).toThrow('FIRE_FRAME_LENGTH_INVALID')
  })
})

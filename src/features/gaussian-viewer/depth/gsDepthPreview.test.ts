import { describe, expect, it } from 'vitest'
import { decodeGsDepth } from './gsDepthPreview'
describe('Gaussian depth readback', () => {
  it('decodes big-endian normalized floats to metres, flips rows and keeps clear pixels invalid', () => {
    const data = new Uint8Array(16); const v = new DataView(data.buffer)
    v.setFloat32(0, .5, false); v.setUint32(4, 0xffffffff, false)
    v.setFloat32(8, 0, false); v.setFloat32(12, 1, false)
    expect([...decodeGsDepth(data, 2, 2, 1, 11)]).toEqual([1, 11, 6, 0])
  })
  it('rejects truncated buffers', () => expect(() => decodeGsDepth(new Uint8Array(3), 1, 1, .1, 100)).toThrow('GS_DEPTH_LENGTH'))
})

import type { GaussianDepthFrame } from '../types'
export const gsDepthPreview = {
  enabled: false,
  alphaClip: .3,
  frame: null as GaussianDepthFrame | null,
  error: null as string | null,
  cameraMode: '自由视角',
  listeners: new Set<() => void>(),
  publish(frame: GaussianDepthFrame | null, error: string | null = null) {
    this.frame = frame; this.error = error
    for (const listener of this.listeners) listener()
  },
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
}

export function decodeGsDepth(bytes: Uint8Array, width: number, height: number, near: number, far: number): Float32Array {
  if (bytes.length !== width * height * 4) throw new Error('GS_DEPTH_LENGTH')
  const values = new Float32Array(width * height)
  const bits = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = ((height - y - 1) * width + x) * 4
    if (bits.getUint32(offset, false) === 0xffffffff) continue
    const normalized = bits.getFloat32(offset, false)
    if (Number.isFinite(normalized) && normalized >= 0 && normalized <= 1) values[y * width + x] = near + normalized * (far - near)
  }
  return values
}

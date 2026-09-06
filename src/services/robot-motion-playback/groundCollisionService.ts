export interface GroundCollisionMetadata { schema: 'gs-ground-collision-v1'; cellSize: number; originXY: [number, number]; shape: [number, number]; globalFloorHeight: number }
import { groundHeightAt, loadGroundPlane, type GroundPlane } from './groundPlaneService'

export class GroundCollisionService {
  private metadata: GroundCollisionMetadata | null = null
  private heights: Float32Array | null = null
  private valid: Uint8Array | null = null
  private plane: GroundPlane | null = null
  async load(baseUrl = '/ground-collision/office_01/'): Promise<void> {
    this.plane = loadGroundPlane('office_01')
    const root = new URL(baseUrl, window.location.href)
    if (root.origin !== window.location.origin) throw new Error('GROUND_COLLISION_ORIGIN_INVALID')
    const [metaResponse, heightResponse, validResponse] = await Promise.all([
      fetch(new URL('metadata.json', root)), fetch(new URL('floor_height.bin', root)), fetch(new URL('valid_mask.bin', root)),
    ])
    if (!metaResponse.ok || !heightResponse.ok || !validResponse.ok) throw new Error('GROUND_COLLISION_FETCH_FAILED')
    const metadata = await metaResponse.json() as GroundCollisionMetadata
    const [heightBuffer, validBuffer] = await Promise.all([heightResponse.arrayBuffer(), validResponse.arrayBuffer()])
    const count = metadata.shape[0] * metadata.shape[1]
    if (heightBuffer.byteLength !== count * 4 || validBuffer.byteLength !== count) throw new Error('GROUND_COLLISION_LENGTH_INVALID')
    this.metadata = metadata; this.heights = new Float32Array(heightBuffer); this.valid = new Uint8Array(validBuffer)
  }
  isLoaded(): boolean { return Boolean(this.metadata && this.heights && this.valid) }
  /** Query viewer X/Z position; returns source-up height in metres. */
  sample(x: number, viewerZ: number): number | null {
    if (this.plane) return groundHeightAt(this.plane, x, viewerZ)
    const m = this.metadata; const h = this.heights; const valid = this.valid
    if (!m || !h || !valid || !Number.isFinite(x) || !Number.isFinite(viewerZ)) return null
    const sourceY = -viewerZ; const gx = (x - m.originXY[0]) / m.cellSize; const gy = (sourceY - m.originXY[1]) / m.cellSize
    const x0 = Math.floor(gx); const y0 = Math.floor(gy); const x1 = x0 + 1; const y1 = y0 + 1
    if (x0 < 0 || y0 < 0 || x1 >= m.shape[0] || y1 >= m.shape[1]) return null
    const at = (ix: number, iy: number) => valid[iy * m.shape[0] + ix] ? h[iy * m.shape[0] + ix] : null
    const samples = [at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1)].filter((v): v is number => v !== null)
    return samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null
  }
}

export const groundCollisionService = new GroundCollisionService()

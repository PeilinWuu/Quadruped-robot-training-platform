import { FIRE_PLAYBACK_SCHEMA, FIRE_PLAYBACK_V2_SCHEMA } from './types'
import type {
  FirePlaybackChunkRecord,
  FirePlaybackFrame,
  FirePlaybackMetadata,
} from './types'

const MAX_METADATA_BYTES = 512 * 1024
const MAX_CHUNK_BYTES = 64 * 1024 * 1024

function finitePositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value) && Number(value) > 0
}

function safeAssetUrl(baseUrl: string, filename: string): string {
  if (!/^[a-z0-9_-]+\.bin$/.test(filename)) throw new Error('FIRE_ASSET_FILENAME_INVALID')
  const base = new URL(baseUrl, window.location.href)
  const resolved = new URL(filename, base)
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new Error('FIRE_ASSET_URL_BLOCKED')
  }
  return resolved.toString()
}

export function validateFirePlaybackMetadata(value: unknown): FirePlaybackMetadata {
  if (!value || typeof value !== 'object') throw new Error('FIRE_METADATA_INVALID')
  const metadata = value as Partial<FirePlaybackMetadata>
  if (![FIRE_PLAYBACK_SCHEMA, FIRE_PLAYBACK_V2_SCHEMA].includes(metadata.schema as typeof FIRE_PLAYBACK_SCHEMA) || metadata.sourceMode !== 'native_reignite') {
    throw new Error('FIRE_METADATA_UNSUPPORTED')
  }
  const playback = metadata.playback
  const grid = metadata.grid
  const encoding = metadata.encoding
  if (!playback || !finitePositiveInteger(playback.frameCount) || !Number.isFinite(playback.fps)
    || playback.fps <= 0 || !['loop', 'ping-pong'].includes(playback.loopMode)) {
    throw new Error('FIRE_METADATA_PLAYBACK_INVALID')
  }
  if (!grid || grid.dimensions.length !== 3 || !grid.dimensions.every(finitePositiveInteger)
    || !Number.isFinite(grid.voxelSize) || grid.voxelSize <= 0
    || grid.worldLower.length !== 3 || grid.worldUpper.length !== 3
    || ![...grid.worldLower, ...grid.worldUpper].every(Number.isFinite)
    || grid.sourceToViewer.length !== 16 || !grid.sourceToViewer.every(Number.isFinite)) {
    throw new Error('FIRE_METADATA_GRID_INVALID')
  }
  const v2 = metadata.schema === FIRE_PLAYBACK_V2_SCHEMA
  if (grid.worldUpper.some((v, i) => v <= grid.worldLower[i])
    || grid.sourceToViewer.join(',') !== '1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1') throw new Error('FIRE_METADATA_TRANSFORM_UNSUPPORTED')
  const expectedBytes = grid.dimensions.reduce((product, item) => product * item, 1) * (v2 ? 8 : 2)
  if (!encoding || encoding.layout !== (v2 ? 'source-c-order-xyz-rgba-rgba' : 'source-c-order-xyz-rg')
    || encoding.componentType !== 'uint8-unorm' || encoding.bytesPerVoxel !== (v2 ? 8 : 2)
    || encoding.quantization?.minimum !== 0 || encoding.quantization?.maximum !== 1
    || encoding.frameBytes !== expectedBytes) {
    throw new Error('FIRE_METADATA_ENCODING_INVALID')
  }
  if (metadata.rendererProfile?.xyz2rgbClipOutput !== true || metadata.rendererProfile.hdrAces !== false
    || !Number.isFinite(metadata.rendererProfile.strength) || !Number.isFinite(metadata.rendererProfile.smokeStrength)) {
    throw new Error('FIRE_METADATA_PROFILE_INVALID')
  }
  if (v2 && (encoding.emissionZero !== 128 || encoding.colorSpace !== 'native-cat02-linear-srgb-signed'
    || encoding.strengthBaked !== true || encoding.emissionScale?.length !== 3
    || !encoding.emissionScale.every((v) => Number.isFinite(v) && v > 0)
    || encoding.channels.join(',') !== 'emissionR,emissionG,emissionB,extinction,smokeR,smokeG,smokeB,smokeDensity')) {
    throw new Error('FIRE_METADATA_V2_ENCODING_INVALID')
  }
  if (!metadata.frames || metadata.frames.length !== playback.frameCount
    || !metadata.chunks || metadata.chunks.length === 0) {
    throw new Error('FIRE_METADATA_INDEX_INVALID')
  }
  metadata.frames.forEach((frame, index) => {
    if (frame.playbackIndex !== index || !Number.isInteger(frame.sourceFrame)
      || !['established', 'spread', 'late'].includes(frame.stage)
      || !Number.isInteger(frame.chunk) || frame.chunk < 0
      || !Number.isInteger(frame.offset) || frame.offset < 0) {
      throw new Error('FIRE_METADATA_FRAME_INVALID')
    }
  })
  metadata.chunks.forEach((chunk, index) => {
    if (chunk.index !== index || !finitePositiveInteger(chunk.frameCount)
      || !finitePositiveInteger(chunk.byteLength) || chunk.byteLength > MAX_CHUNK_BYTES
      || !/^[a-f0-9]{64}$/.test(chunk.sha256)) {
      throw new Error('FIRE_METADATA_CHUNK_INVALID')
    }
  })
  for (const frame of metadata.frames) {
    const chunk = metadata.chunks[frame.chunk]
    if (!chunk || frame.offset % expectedBytes !== 0 || frame.offset + expectedBytes > chunk.byteLength
      || chunk.byteLength !== chunk.frameCount * expectedBytes
      || frame.playbackIndex !== chunk.firstPlaybackIndex + frame.offset / expectedBytes) {
      throw new Error('FIRE_METADATA_CHUNK_MAPPING_INVALID')
    }
  }
  return metadata as FirePlaybackMetadata
}

export class BrowserFireAssetAdapter {
  private readonly abort = new AbortController()
  private readonly baseUrl: string
  private readonly chunks = new Map<number, Promise<ArrayBuffer>>()
  private readonly frames = new Map<number, Promise<FirePlaybackFrame>>()

  constructor(baseUrl: string) {
    const resolved = new URL(baseUrl, window.location.href)
    if (resolved.origin !== window.location.origin || !resolved.pathname.endsWith('/')) {
      throw new Error('FIRE_ASSET_BASE_URL_BLOCKED')
    }
    this.baseUrl = resolved.toString()
  }

  async loadMetadata(signal?: AbortSignal): Promise<FirePlaybackMetadata> {
    const response = await fetch(new URL('metadata.json', this.baseUrl), { signal: signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal })
    if (!response.ok) throw new Error(response.status === 404 ? 'FIRE_ASSET_NOT_FOUND' : 'FIRE_ASSET_FETCH_FAILED')
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_METADATA_BYTES) throw new Error('FIRE_METADATA_TOO_LARGE')
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES) throw new Error('FIRE_METADATA_TOO_LARGE')
    return validateFirePlaybackMetadata(JSON.parse(text))
  }

  async loadFrame(metadata: FirePlaybackMetadata, index: number): Promise<FirePlaybackFrame> {
    const cached = this.frames.get(index)
    if (cached) return cached
    const pending = this.loadFrameUncached(metadata, index).catch((error: unknown) => {
      this.frames.delete(index)
      throw error
    })
    this.frames.set(index, pending)
    return pending
  }

  retainPair(metadata: FirePlaybackMetadata, indices: number[]): void {
    const chunks = new Set(indices.map((i) => metadata.frames[i].chunk))
    for (const key of this.frames.keys()) if (!indices.includes(key)) this.frames.delete(key)
    for (const key of this.chunks.keys()) if (!chunks.has(key)) this.chunks.delete(key)
  }

  getCacheStats(): { frames: number; chunks: number } { return { frames: this.frames.size, chunks: this.chunks.size } }
  lastChunkLoadMs = 0

  clear(): void { this.abort.abort(); this.chunks.clear(); this.frames.clear() }

  private async loadFrameUncached(metadata: FirePlaybackMetadata, index: number): Promise<FirePlaybackFrame> {
    const record = metadata.frames[index]
    if (!record) throw new Error('FIRE_FRAME_OUT_OF_RANGE')
    const chunk = metadata.chunks[record.chunk]
    if (!chunk) throw new Error('FIRE_CHUNK_NOT_FOUND')
    const buffer = await this.loadChunk(chunk)
    const end = record.offset + metadata.encoding.frameBytes
    if (end > buffer.byteLength) throw new Error('FIRE_CHUNK_TRUNCATED')
    return {
      index,
      sourceFrame: record.sourceFrame,
      stage: record.stage,
      voxels: new Uint8Array(buffer.slice(record.offset, end)),
    }
  }

  private loadChunk(chunk: FirePlaybackChunkRecord): Promise<ArrayBuffer> {
    const cached = this.chunks.get(chunk.index)
    if (cached) return cached
    const started = performance.now()
    const pending = fetch(safeAssetUrl(this.baseUrl, chunk.file), { signal: this.abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('FIRE_CHUNK_FETCH_FAILED')
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== chunk.byteLength || buffer.byteLength > MAX_CHUNK_BYTES) {
        throw new Error('FIRE_CHUNK_LENGTH_INVALID')
      }
      if (crypto.subtle) {
        const hash = await crypto.subtle.digest('SHA-256', buffer)
        const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
        if (hex !== chunk.sha256) throw new Error('FIRE_CHUNK_HASH_INVALID')
      }
      this.lastChunkLoadMs = performance.now() - started
      return buffer
    }).catch((error: unknown) => {
      this.chunks.delete(chunk.index)
      throw error
    })
    this.chunks.set(chunk.index, pending)
    return pending
  }
}

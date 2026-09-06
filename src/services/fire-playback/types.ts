export const FIRE_PLAYBACK_SCHEMA = 'fierygs-fire-playback-v1' as const

export type FirePlaybackLoopMode = 'loop' | 'ping-pong'
export type FirePlaybackPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error'

export interface FirePlaybackFrameRecord {
  playbackIndex: number
  sourceFrame: number
  stage: 'established' | 'spread' | 'late'
  chunk: number
  offset: number
}

export interface FirePlaybackChunkRecord {
  index: number
  file: string
  firstPlaybackIndex: number
  frameCount: number
  byteLength: number
  sha256: string
}

export interface FirePlaybackMetadata {
  schema: typeof FIRE_PLAYBACK_SCHEMA
  scenarioId: string
  sourceMode: 'native_reignite'
  rendererProfile: {
    xyz2rgbClipOutput: true
    hdrAces: false
    strength: number
    smokeStrength: number
  }
  playback: {
    fps: number
    frameCount: number
    loopMode: FirePlaybackLoopMode
    stages: Array<'established' | 'spread' | 'late'>
  }
  grid: {
    sourceDimensions: [number, number, number]
    cropOrigin: [number, number, number]
    dimensions: [number, number, number]
    voxelSize: number
    sourceLower: [number, number, number]
    worldLower: [number, number, number]
    worldUpper: [number, number, number]
    sourceToViewer: number[]
  }
  encoding: {
    layout: 'source-c-order-xyz-rg'
    channels: ['fuel', 'temperature']
    componentType: 'uint8-unorm'
    bytesPerVoxel: 2
    frameBytes: number
    quantization: { minimum: 0; maximum: 1 }
  }
  frames: FirePlaybackFrameRecord[]
  chunks: FirePlaybackChunkRecord[]
  source: {
    simulationDirectory: string
    firstFrame: number
    lastFrame: number
    frameStep: number
    threshold: number
    padding: number
  }
}

export interface FirePlaybackFrame {
  index: number
  sourceFrame: number
  stage: FirePlaybackFrameRecord['stage']
  voxels: Uint8Array
}

export interface FirePlaybackSample {
  current: FirePlaybackFrame
  next: FirePlaybackFrame
  alpha: number
}

export interface FirePlaybackState {
  phase: FirePlaybackPhase
  scenarioId: string | null
  frameIndex: number
  frameCount: number
  sourceFrame: number | null
  stage: FirePlaybackFrameRecord['stage'] | null
  playing: boolean
  error: string | null
}


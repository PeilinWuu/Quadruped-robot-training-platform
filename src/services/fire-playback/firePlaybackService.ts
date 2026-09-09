import { BrowserFireAssetAdapter } from './browserFireAssetAdapter'
import type {
  FirePlaybackMetadata,
  FirePlaybackSample,
  FirePlaybackState,
  FireQuality,
  FireSceneMode,
  FireVersion,
} from './types'

export const FIRE_V1_URL = '/fire-playback/table_high/'
export const FIRE_V2_URL = '/fire-playback-v2/table_high_test/'

type Listener = (state: FirePlaybackState) => void
type SampleListener = (sample: FirePlaybackSample, metadata: FirePlaybackMetadata) => void

const INITIAL_STATE: FirePlaybackState = {
  phase: 'idle', scenarioId: null, frameIndex: 0, frameCount: 0,
  sourceFrame: null, stage: null, playing: false, error: null,
}

export class FirePlaybackService {
  private state: FirePlaybackState = INITIAL_STATE
  private metadata: FirePlaybackMetadata | null = null
  private adapter: BrowserFireAssetAdapter | null = null
  private readonly listeners = new Set<Listener>()
  private latestSample: FirePlaybackSample | null = null
  private readonly sampleListeners = new Set<SampleListener>()
  private generation = 0
  private elapsed = 0
  private direction: 1 | -1 = 1
  private currentIndex = 0
  private samplePromise: Promise<void> | null = null

  private sceneMode: FireSceneMode = 'single'
  private sceneGeneration = 0
  private readonly companions = new Map<string, FirePlaybackService>()
  private readonly focusListeners = new Set<(metadata: FirePlaybackMetadata) => void>()
  getCompanions(): ReadonlyMap<string, FirePlaybackService> { return this.companions }
  onFocus(listener: (metadata: FirePlaybackMetadata) => void): () => void {
    this.focusListeners.add(listener); return () => this.focusListeners.delete(listener)
  }
  focusFire(id: string): void {
    const metadata = (id === 'table_high' ? this : this.companions.get(id))?.getMetadata()
    if (metadata) for (const listener of this.focusListeners) listener(metadata)
  }
  async setSceneMode(mode: FireSceneMode): Promise<void> {
    const generation = ++this.sceneGeneration
    this.presentationSeconds = 0
    this.sceneMode = mode
    for (const companion of this.companions.values()) companion.dispose()
    this.companions.clear()
    this.setState(this.state)
    if (mode === 'single') return
    for (const id of ['sofa_high', 'curtain_high']) this.companions.set(id, new FirePlaybackService())
    const loads = [...this.companions].map(([id, service]) => service.load(`/fire-playback-room/${id}/`))
    if (this.state.version !== 'playback-v1' || this.state.phase === 'error') loads.push(this.selectVersion('playback-v1'))
    await Promise.all(loads)
    if (generation !== this.sceneGeneration) return
    if (this.state.playing) for (const companion of this.companions.values()) companion.play()
    this.setState(this.state)
  }

  atmosphereEnabled = true
  presentationSeconds = 0
  quality: FireQuality = 'medium'
  autoQuality = true
  depthOcclusion = true
  depthStatus: 'off' | 'loading' | 'ready' | 'unavailable' = 'off'
  fps = 0
  private fallbackUrl: string | null = null
  private fallbackReason: string | null = null
  private requestId = 0

  setQuality(quality: FireQuality): void { this.quality = quality }
  async selectVersion(version: FireVersion): Promise<void> {
    if (version === 'playback-v2' && this.sceneMode === 'room') await this.setSceneMode('single')
    const playing = this.state.playing
    await this.load(version === 'playback-v2' ? FIRE_V2_URL : FIRE_V1_URL, version === 'playback-v2' ? FIRE_V1_URL : undefined)
    if (playing) this.play()
  }
  getDiagnostics() { return { fps: this.fps, quality: this.quality, version: this.state.version,
    cache: this.adapter?.getCacheStats(), chunkLoadMs: this.adapter?.lastChunkLoadMs ?? 0 } }
  async fallback(error: unknown): Promise<void> {
    const url = this.fallbackUrl
    if (!url) return
    const playing = this.state.playing
    this.fallbackReason = error instanceof Error ? error.message : String(error)
    await this.load(url, undefined, true)
    if (playing) this.play()
  }

  getState(): FirePlaybackState { return { ...this.state, sceneMode: this.sceneMode, additionalFires: [...this.companions].map(([id, service]) => ({ id, phase: service.state.phase, error: service.state.error })) } }
  getMetadata(): FirePlaybackMetadata | null { return this.metadata }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener) }
  onSample(listener: SampleListener): () => void { this.sampleListeners.add(listener); if (this.latestSample && this.metadata) listener(this.latestSample, this.metadata); return () => this.sampleListeners.delete(listener) }

  async load(baseUrl: string, fallbackUrl?: string, preserveReason = false): Promise<void> {
    const generation = ++this.generation
    ++this.requestId
    this.samplePromise = null
    this.fallbackUrl = fallbackUrl ?? null
    if (!preserveReason) this.fallbackReason = null
    this.adapter?.clear()
    this.adapter = null
    this.metadata = null
    this.latestSample = null
    this.currentIndex = 0; this.elapsed = 0; this.direction = 1
    this.setState({ ...INITIAL_STATE, phase: 'loading' })
    try {
      this.adapter = new BrowserFireAssetAdapter(baseUrl)
      const metadata = await this.adapter.loadMetadata()
      if (generation !== this.generation) return
      this.metadata = metadata
      const first = metadata.frames[0]
      this.setState({ version: metadata.schema.endsWith('v2') ? 'playback-v2' : 'playback-v1', fallbackReason: this.fallbackReason, phase: 'ready', scenarioId: metadata.scenarioId, frameIndex: 0,
        frameCount: metadata.playback.frameCount, sourceFrame: first.sourceFrame,
        stage: first.stage, playing: false, error: null })
      await this.publishSample(0)
    } catch (error) {
      if (generation !== this.generation) return
      if (this.fallbackUrl) { await this.fallback(error); return }
      this.setState({ ...INITIAL_STATE, phase: 'error', error: error instanceof Error ? error.message : 'FIRE_LOAD_FAILED' })
    }
  }

  play(): void { for (const service of this.companions.values()) service.play(); if (this.metadata && this.state.phase !== 'error') this.setState({ ...this.state, phase: 'playing', playing: true }) }
  pause(): void { for (const service of this.companions.values()) service.pause(); if (this.metadata) this.setState({ ...this.state, phase: 'paused', playing: false }) }
  reset(): void { this.presentationSeconds = 0; for (const service of this.companions.values()) service.reset(); if (!this.metadata) return; this.elapsed = 0; this.direction = 1; this.currentIndex = 0; this.pause(); ++this.requestId; this.samplePromise = null; void this.publishSample(0) }
  seek(index: number): void {
    if (!this.metadata || !Number.isFinite(index)) return
    this.currentIndex = Math.min(Math.max(Math.trunc(index), 0), this.metadata.playback.frameCount - 1)
    this.elapsed = 0
    ++this.requestId; this.samplePromise = null
    void this.publishSample(0)
  }

  update(deltaSeconds: number): void {
    for (const service of this.companions.values()) {
      service.depthOcclusion = this.depthOcclusion
      service.quality = this.quality; service.autoQuality = false
      service.update(deltaSeconds)
    }
    const metadata = this.metadata
    if (!metadata || !this.state.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return
    if (this.sceneMode === 'room') this.presentationSeconds += Math.min(deltaSeconds, .25)
    const frameDuration = 1 / metadata.playback.fps
    this.elapsed += Math.min(deltaSeconds, .25)
    while (this.elapsed >= frameDuration) {
      this.elapsed -= frameDuration
      this.advance()
    }
    void this.publishSample(this.elapsed / frameDuration)
  }

  dispose(): void {
    ++this.sceneGeneration; for (const service of this.companions.values()) service.dispose(); this.companions.clear(); this.focusListeners.clear(); this.sceneMode = 'single'
    ++this.generation; this.adapter?.clear(); this.adapter = null; this.metadata = null
    this.latestSample = null; this.listeners.clear(); this.sampleListeners.clear(); this.state = INITIAL_STATE
  }

  private advance(): void {
    const metadata = this.metadata
    if (!metadata || metadata.playback.frameCount < 2) return
    const last = metadata.playback.frameCount - 1
    if (metadata.playback.loopMode === 'ping-pong') {
      if (this.currentIndex === last) this.direction = -1
      else if (this.currentIndex === 0) this.direction = 1
      this.currentIndex += this.direction
    } else {
      this.currentIndex = (this.currentIndex + 1) % metadata.playback.frameCount
    }
  }

  private nextIndex(): number {
    const metadata = this.metadata
    if (!metadata) return 0
    const last = metadata.playback.frameCount - 1
    if (metadata.playback.loopMode === 'ping-pong') {
      if (this.currentIndex === last) return Math.max(last - 1, 0)
      if (this.currentIndex === 0 && this.direction < 0) return Math.min(1, last)
      return this.currentIndex + this.direction
    }
    return (this.currentIndex + 1) % metadata.playback.frameCount
  }

  private async publishSample(alpha: number): Promise<void> {
    if (this.samplePromise || !this.adapter || !this.metadata) return
    const generation = this.generation
    const adapter = this.adapter
    const metadata = this.metadata
    const currentIndex = this.currentIndex
    const nextIndex = this.nextIndex()
    const requestId = ++this.requestId
    this.latestSample = null
    adapter.retainPair(metadata, [currentIndex, nextIndex])
    this.samplePromise = Promise.all([
      adapter.loadFrame(metadata, currentIndex),
      adapter.loadFrame(metadata, nextIndex),
    ]).then(([current, next]) => {
      if (generation !== this.generation || requestId !== this.requestId || metadata !== this.metadata) return
      const record = metadata.frames[currentIndex]
      this.setState({ ...this.state, frameIndex: currentIndex, sourceFrame: record.sourceFrame, stage: record.stage })
      const sample = { current, next, alpha: Math.min(Math.max(alpha, 0), 1) }
      this.latestSample = sample
      for (const listener of this.sampleListeners) listener(sample, metadata)
    }).catch(async (error: unknown) => {
      if (generation !== this.generation || requestId !== this.requestId) return
      if (this.fallbackUrl) { await this.fallback(error); return }
      if (generation === this.generation) this.setState({ ...this.state, phase: 'error', playing: false,
        error: error instanceof Error ? error.message : 'FIRE_FRAME_FAILED' })
    }).finally(() => { if (requestId === this.requestId) this.samplePromise = null })
    await this.samplePromise
  }

  private setState(state: FirePlaybackState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.getState())
  }
}

export const firePlaybackService = new FirePlaybackService()

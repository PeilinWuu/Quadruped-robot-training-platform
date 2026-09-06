import { BrowserFireAssetAdapter } from './browserFireAssetAdapter'
import type {
  FirePlaybackMetadata,
  FirePlaybackSample,
  FirePlaybackState,
} from './types'

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
  private readonly sampleListeners = new Set<SampleListener>()
  private generation = 0
  private elapsed = 0
  private direction: 1 | -1 = 1
  private currentIndex = 0
  private samplePromise: Promise<void> | null = null

  getState(): FirePlaybackState { return { ...this.state } }
  getMetadata(): FirePlaybackMetadata | null { return this.metadata }
  subscribe(listener: Listener): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener) }
  onSample(listener: SampleListener): () => void { this.sampleListeners.add(listener); return () => this.sampleListeners.delete(listener) }

  async load(baseUrl: string): Promise<void> {
    const generation = ++this.generation
    this.adapter?.clear()
    this.adapter = new BrowserFireAssetAdapter(baseUrl)
    this.metadata = null
    this.currentIndex = 0; this.elapsed = 0; this.direction = 1
    this.setState({ ...INITIAL_STATE, phase: 'loading' })
    try {
      const metadata = await this.adapter.loadMetadata()
      if (generation !== this.generation) return
      this.metadata = metadata
      const first = metadata.frames[0]
      this.setState({ phase: 'ready', scenarioId: metadata.scenarioId, frameIndex: 0,
        frameCount: metadata.playback.frameCount, sourceFrame: first.sourceFrame,
        stage: first.stage, playing: false, error: null })
      await this.publishSample(0)
    } catch (error) {
      if (generation !== this.generation) return
      this.setState({ ...INITIAL_STATE, phase: 'error', error: error instanceof Error ? error.message : 'FIRE_LOAD_FAILED' })
    }
  }

  play(): void { if (this.metadata && this.state.phase !== 'error') this.setState({ ...this.state, phase: 'playing', playing: true }) }
  pause(): void { if (this.metadata) this.setState({ ...this.state, phase: 'paused', playing: false }) }
  reset(): void { if (!this.metadata) return; this.elapsed = 0; this.direction = 1; this.currentIndex = 0; this.pause(); void this.publishSample(0) }
  seek(index: number): void {
    if (!this.metadata || !Number.isFinite(index)) return
    this.currentIndex = Math.min(Math.max(Math.trunc(index), 0), this.metadata.playback.frameCount - 1)
    this.elapsed = 0
    void this.publishSample(0)
  }

  update(deltaSeconds: number): void {
    const metadata = this.metadata
    if (!metadata || !this.state.playing || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return
    const frameDuration = 1 / metadata.playback.fps
    this.elapsed += Math.min(deltaSeconds, .25)
    while (this.elapsed >= frameDuration) {
      this.elapsed -= frameDuration
      this.advance()
    }
    void this.publishSample(this.elapsed / frameDuration)
  }

  dispose(): void {
    ++this.generation; this.adapter?.clear(); this.adapter = null; this.metadata = null
    this.listeners.clear(); this.sampleListeners.clear(); this.state = INITIAL_STATE
  }

  private advance(): void {
    const metadata = this.metadata
    if (!metadata) return
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
    this.samplePromise = Promise.all([
      adapter.loadFrame(metadata, currentIndex),
      adapter.loadFrame(metadata, nextIndex),
    ]).then(([current, next]) => {
      if (generation !== this.generation || metadata !== this.metadata) return
      const record = metadata.frames[currentIndex]
      this.setState({ ...this.state, frameIndex: currentIndex, sourceFrame: record.sourceFrame, stage: record.stage })
      const sample = { current, next, alpha: Math.min(Math.max(alpha, 0), 1) }
      for (const listener of this.sampleListeners) listener(sample, metadata)
    }).catch((error: unknown) => {
      if (generation === this.generation) this.setState({ ...this.state, phase: 'error', playing: false,
        error: error instanceof Error ? error.message : 'FIRE_FRAME_FAILED' })
    }).finally(() => { this.samplePromise = null })
  }

  private setState(state: FirePlaybackState): void {
    this.state = state
    for (const listener of this.listeners) listener(this.getState())
  }
}

export const firePlaybackService = new FirePlaybackService()


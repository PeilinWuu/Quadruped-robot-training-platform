import type { ViewerRuntime, ViewerRuntimeOptions, ViewerRuntimeStatus } from '../types'

const FPS_SAMPLE_INTERVAL_MS = 750
const CLEAR_COLOR: readonly [number, number, number, number] = [0.035, 0.055, 0.07, 1]
const CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
}

export class WebGl2ProbeRuntime implements ViewerRuntime {
  private canvas: HTMLCanvasElement | null
  private gl: WebGL2RenderingContext | null
  private onStatusChange: ((status: ViewerRuntimeStatus) => void) | null
  private status: ViewerRuntimeStatus
  private rafId: number | null = null
  private disposed = false
  private shouldRun = false
  private frameCount = 0
  private sampleStartedAt = 0

  constructor({ canvas, onStatusChange }: ViewerRuntimeOptions) {
    this.canvas = canvas
    this.onStatusChange = onStatusChange
    this.gl = canvas.getContext('webgl2', CONTEXT_OPTIONS)
    this.status = {
      backend: 'WebGL2 Probe',
      initialized: this.gl !== null,
      running: false,
      contextLost: false,
      fps: 0,
      width: 0,
      height: 0,
      pixelRatio: 1,
      error: this.gl ? null : 'WEBGL2_UNSUPPORTED',
    }
    canvas.addEventListener('webglcontextlost', this.handleContextLost)
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    this.emitStatus()
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed || !this.canvas) return

    const safeWidth = Math.floor(width)
    const safeHeight = Math.floor(height)
    const safePixelRatio = Math.min(Math.max(pixelRatio, 1), 2)
    if (
      !Number.isFinite(safeWidth)
      || !Number.isFinite(safeHeight)
      || !Number.isFinite(safePixelRatio)
      || safeWidth < 0
      || safeHeight < 0
    ) {
      this.status = { ...this.status, running: false, error: 'INVALID_VIEWPORT_SIZE' }
      this.stopRaf()
      this.emitStatus()
      return
    }

    const backingWidth = Math.floor(safeWidth * safePixelRatio)
    const backingHeight = Math.floor(safeHeight * safePixelRatio)
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight

    this.status = {
      ...this.status,
      width: safeWidth,
      height: safeHeight,
      pixelRatio: safePixelRatio,
      error: this.status.error === 'INVALID_VIEWPORT_SIZE' ? null : this.status.error,
    }

    if (backingWidth === 0 || backingHeight === 0) {
      this.stopRaf()
    } else {
      this.gl?.viewport(0, 0, backingWidth, backingHeight)
      this.scheduleRaf()
    }
    this.emitStatus()
  }

  start(): void {
    if (this.disposed) return
    this.shouldRun = true
    this.scheduleRaf()
  }

  pause(): void {
    if (this.disposed) return
    this.shouldRun = false
    this.stopRaf()
    this.emitStatus()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.shouldRun = false
    this.stopRaf()

    const canvas = this.canvas
    const gl = this.gl
    canvas?.removeEventListener('webglcontextlost', this.handleContextLost)
    canvas?.removeEventListener('webglcontextrestored', this.handleContextRestored)
    this.onStatusChange = null
    this.gl = null
    this.canvas = null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }

  getStatus(): ViewerRuntimeStatus {
    return { ...this.status }
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    if (this.disposed) return
    this.stopRaf()
    this.status = {
      ...this.status,
      initialized: false,
      running: false,
      contextLost: true,
      fps: 0,
      error: null,
    }
    this.emitStatus()
  }

  private readonly handleContextRestored = (): void => {
    if (this.disposed || !this.canvas) return
    this.gl = this.canvas.getContext('webgl2', CONTEXT_OPTIONS)
    this.status = {
      ...this.status,
      initialized: this.gl !== null,
      contextLost: false,
      error: this.gl ? null : 'WEBGL2_RESTORE_FAILED',
    }
    if (this.gl && this.canvas.width > 0 && this.canvas.height > 0) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    }
    this.emitStatus()
    this.scheduleRaf()
  }

  private readonly renderFrame = (now: number): void => {
    this.rafId = null
    if (!this.canRender() || !this.gl) {
      this.updateRunning(false)
      return
    }

    this.gl.clearColor(...CLEAR_COLOR)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT)
    this.frameCount += 1
    if (this.sampleStartedAt === 0) this.sampleStartedAt = now
    const elapsed = now - this.sampleStartedAt
    if (elapsed >= FPS_SAMPLE_INTERVAL_MS) {
      this.status = {
        ...this.status,
        fps: Math.round((this.frameCount * 1000) / elapsed),
      }
      this.frameCount = 0
      this.sampleStartedAt = now
      this.emitStatus()
    }
    this.rafId = requestAnimationFrame(this.renderFrame)
  }

  private canRender(): boolean {
    return !this.disposed
      && this.shouldRun
      && this.status.initialized
      && !this.status.contextLost
      && this.status.width > 0
      && this.status.height > 0
  }

  private scheduleRaf(): void {
    if (!this.canRender() || this.rafId !== null) return
    this.updateRunning(true)
    this.rafId = requestAnimationFrame(this.renderFrame)
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.frameCount = 0
    this.sampleStartedAt = 0
    this.updateRunning(false)
  }

  private updateRunning(running: boolean): void {
    if (this.status.running === running) return
    this.status = { ...this.status, running }
  }

  private emitStatus(): void {
    if (!this.disposed) this.onStatusChange?.(this.getStatus())
  }
}

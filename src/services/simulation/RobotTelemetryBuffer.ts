import type { RobotTelemetry } from './types'

export type TelemetryListener = (telemetry: RobotTelemetry) => void

function safetySignature(telemetry: RobotTelemetry): string {
  return [
    telemetry.collision.isFallen,
    telemetry.collision.isOutOfBounds,
    telemetry.locomotion.availability,
    telemetry.locomotion.state,
    telemetry.locomotion.faultReason ?? '',
    telemetry.command.timedOut,
    telemetry.command.controllerAvailability,
  ].join('|')
}

export class RobotTelemetryBuffer {
  private readonly minimumPublishIntervalMs: number
  private latest: RobotTelemetry | null = null
  private pending: RobotTelemetry | null = null
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null
  private lastPublishedAt = 0
  private lastSafetySignature: string | null = null
  private readonly listeners = new Set<TelemetryListener>()

  constructor(minimumPublishIntervalMs = 100) { this.minimumPublishIntervalMs = minimumPublishIntervalMs }

  getLatest(): RobotTelemetry | null { return this.latest }

  update(telemetry: RobotTelemetry): void {
    const nextSafetySignature = safetySignature(telemetry)
    const safetyTransition = nextSafetySignature !== this.lastSafetySignature
    this.lastSafetySignature = nextSafetySignature
    this.latest = telemetry
    this.pending = telemetry
    if (typeof document !== 'undefined' && document.hidden) return
    const elapsed = performance.now() - this.lastPublishedAt
    if (safetyTransition || elapsed >= this.minimumPublishIntervalMs) this.publish()
    else if (this.timer === null) {
      this.timer = globalThis.setTimeout(() => this.publish(), this.minimumPublishIntervalMs - elapsed)
    }
  }

  subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    this.latest = null
    this.pending = null
    this.lastSafetySignature = null
    if (this.timer !== null) globalThis.clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.clear()
    this.listeners.clear()
  }

  private publish(): void {
    if (this.timer !== null) globalThis.clearTimeout(this.timer)
    this.timer = null
    const telemetry = this.pending
    this.pending = null
    if (!telemetry) return
    this.lastPublishedAt = performance.now()
    for (const listener of this.listeners) {
      try { listener(telemetry) } catch { /* One consumer cannot interrupt others. */ }
    }
  }
}

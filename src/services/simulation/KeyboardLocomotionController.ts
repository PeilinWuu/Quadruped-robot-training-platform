import type { MotionCommand } from './types'
import type { MotionIntent, MotionIntentAdapter } from '../control/motionIntent'

export type DemoSpeed = 'low' | 'medium'
export interface KeyboardLocomotionState {
  enabled: boolean; resetting: boolean; stopReason: string | null; speed: DemoSpeed
  forwardVelocity: number; yawRate: number
}
export interface KeyboardLocomotionTransport {
  setMotionCommand(command: MotionCommand): Promise<unknown>
  clearMotionCommand(): Promise<unknown>
  reset(): Promise<unknown>
}

export interface KeyboardLocomotionDiagnostics {
  requested: number
  dispatched: number
  completed: number
  coalesced: number
  rejected: number
  inFlight: number
  maxInFlight: number
  lastInvokeLatencyMs: number
}

type DesiredMotion = {
  generation: number
  version: number
  intent: MotionIntent | null
}

class SimulationMotionIntentAdapter implements MotionIntentAdapter {
  private sequence = 1
  private readonly transport: KeyboardLocomotionTransport
  constructor(transport: KeyboardLocomotionTransport) { this.transport = transport }
  apply(intent: MotionIntent | null): Promise<unknown> {
    if (!intent) return this.transport.clearMotionCommand()
    const command: MotionCommand = {
      sequence: this.sequence++, mode: 'locomotion',
      forwardVelocity: intent.forwardVelocity, lateralVelocity: intent.lateralVelocity,
      yawRate: intent.yawRate, bodyHeight: .3, validForMs: 250,
    }
    return this.transport.setMotionCommand(command)
  }
}

const LOW = { forward: .12, reverse: -.08, yaw: .24 }
const MEDIUM = { forward: .15, reverse: -.10, yaw: .30 }
const CONTROL_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

function normalizedCode(event: KeyboardEvent): string {
  if (CONTROL_KEYS.has(event.code) || ['Escape', 'Space', 'KeyR'].includes(event.code)) return event.code
  const key = event.key.toLowerCase()
  if (key === 'escape' || key === 'esc') return 'Escape'
  if (key === ' ' || key === 'spacebar') return 'Space'
  if (key === 'r') return 'KeyR'
  if (key === 'w') return 'KeyW'
  if (key === 's') return 'KeyS'
  if (key === 'a') return 'KeyA'
  if (key === 'd') return 'KeyD'
  if (event.key.startsWith('Arrow')) return event.key
  return event.code
}

function editableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
}

export class KeyboardLocomotionController {
  private readonly pressed = new Set<string>()
  private timer: number | null = null
  private enabled = false
  private disposed = false
  private resetting = false
  private generation = 0
  private desiredVersion = 0
  private desired: DesiredMotion | null = null
  private inFlight = false
  private inFlightSettled: Promise<void> | null = null
  private speed: DemoSpeed = 'low'
  private stopReason: string | null = null
  private readonly transport: KeyboardLocomotionTransport
  private readonly intentAdapter: MotionIntentAdapter
  private readonly onState: (state: KeyboardLocomotionState) => void
  private readonly hostWindow: Window
  private readonly hostDocument: Document
  private readonly diagnostics: KeyboardLocomotionDiagnostics = {
    requested: 0, dispatched: 0, completed: 0, coalesced: 0, rejected: 0,
    inFlight: 0, maxInFlight: 0, lastInvokeLatencyMs: 0,
  }

  constructor(
    transport: KeyboardLocomotionTransport,
    onState: (state: KeyboardLocomotionState) => void = () => undefined,
    hostWindow: Window = window,
    hostDocument: Document = document,
  ) {
    this.transport = transport; this.intentAdapter = new SimulationMotionIntentAdapter(transport); this.onState = onState
    this.hostWindow = hostWindow; this.hostDocument = hostDocument; this.publish()
  }

  isEnabled(): boolean { return this.enabled }
  getDiagnostics(): KeyboardLocomotionDiagnostics { return { ...this.diagnostics } }
  setSpeed(speed: DemoSpeed): void { this.speed = speed; this.publish(); if (this.enabled) this.requestHeartbeat() }

  enable(): void {
    if (this.disposed || this.enabled) return
    this.generation += 1
    this.enabled = true
    this.stopReason = null
    this.hostWindow.addEventListener('keydown', this.keyDown)
    this.hostWindow.addEventListener('keyup', this.keyUp)
    this.hostWindow.addEventListener('blur', this.blur)
    this.hostDocument.addEventListener('visibilitychange', this.visibility)
    this.timer = this.hostWindow.setInterval(this.requestHeartbeat, 50)
    this.publish()
    this.requestHeartbeat()
  }

  disable(reason = '已解除键盘控制'): void {
    if (!this.enabled) { this.stopReason = reason; this.publish(); return }
    this.enabled = false
    this.generation += 1
    this.stopReason = reason
    this.pressed.clear()
    if (this.timer !== null) this.hostWindow.clearInterval(this.timer)
    this.timer = null
    this.hostWindow.removeEventListener('keydown', this.keyDown)
    this.hostWindow.removeEventListener('keyup', this.keyUp)
    this.hostWindow.removeEventListener('blur', this.blur)
    this.hostDocument.removeEventListener('visibilitychange', this.visibility)
    this.requestClear()
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disable('控制器已清理')
    this.disposed = true
  }

  private target(): { forwardVelocity: number; yawRate: number } {
    const values = this.speed === 'low' ? LOW : MEDIUM
    const forward = this.pressed.has('KeyW') || this.pressed.has('ArrowUp')
    const reverse = this.pressed.has('KeyS') || this.pressed.has('ArrowDown')
    const left = this.pressed.has('KeyA') || this.pressed.has('ArrowLeft')
    const right = this.pressed.has('KeyD') || this.pressed.has('ArrowRight')
    return { forwardVelocity: forward === reverse ? 0 : (forward ? values.forward : values.reverse),
      yawRate: left === right ? 0 : (left ? values.yaw : -values.yaw) }
  }

  private readonly requestHeartbeat = (): void => {
    if (!this.enabled || this.disposed || this.resetting) return
    const target = this.target()
    this.setDesired({ forwardVelocity: target.forwardVelocity, lateralVelocity: 0, yawRate: target.yawRate,
      source: 'keyboard', createdAtMs: Date.now() })
  }

  private requestClear(): void { this.setDesired(null) }

  private setDesired(intent: MotionIntent | null): void {
    this.diagnostics.requested += 1
    if (this.desired) this.diagnostics.coalesced += 1
    this.desired = {
      generation: this.generation,
      version: ++this.desiredVersion,
      intent,
    }
    this.drainDesired()
  }

  private drainDesired(): void {
    if (this.inFlight || !this.desired) return
    const desired = this.desired
    this.desired = null
    this.inFlight = true
    this.diagnostics.dispatched += 1
    this.diagnostics.inFlight = 1
    this.diagnostics.maxInFlight = Math.max(this.diagnostics.maxInFlight, 1)
    const startedAt = performance.now()
    const invoke = this.intentAdapter.apply(desired.intent)
    const settled = invoke.then(
      () => { this.diagnostics.completed += 1 },
      () => {
        this.diagnostics.rejected += 1
        if (desired.generation === this.generation && this.enabled && !this.disposed) {
          this.stopReason = '命令发送暂时失败，等待下一次心跳重试'
          this.publish()
        }
      },
    ).finally(() => {
      this.diagnostics.lastInvokeLatencyMs = performance.now() - startedAt
      this.diagnostics.inFlight = 0
      this.inFlight = false
      if (this.inFlightSettled === settled) this.inFlightSettled = null
      this.drainDesired()
    })
    this.inFlightSettled = settled
  }

  private stopImmediately(reason: string): void {
    this.pressed.clear(); this.stopReason = reason; this.publish()
    this.generation += 1
    this.requestClear()
  }

  private async resetRobot(): Promise<void> {
    if (this.resetting) return
    this.resetting = true
    this.generation += 1
    this.desired = null
    this.pressed.clear(); this.stopReason = '正在重置机器人'; this.publish()
    try {
      while (this.inFlightSettled) await this.inFlightSettled
      await this.transport.clearMotionCommand()
      await this.transport.reset()
      this.stopReason = 'R 已重置到出生点'
    } catch {
      this.stopReason = '重置失败，已停止发送运动命令'
      this.disable(this.stopReason)
    } finally {
      this.resetting = false
      this.publish()
    }
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || editableTarget(event.target)) return
    const code = normalizedCode(event)
    if (code === 'Escape') { event.preventDefault(); this.disable('Esc 已解除键盘控制'); return }
    if (code === 'Space') { event.preventDefault(); this.stopImmediately('Space 已清除运动目标'); return }
    if (code === 'KeyR') {
      event.preventDefault(); void this.resetRobot(); return
    }
    if (!CONTROL_KEYS.has(code)) return
    event.preventDefault()
    if (event.repeat || this.pressed.has(code)) return
    this.pressed.add(code); this.stopReason = null; this.publish(); this.requestHeartbeat()
  }
  private readonly keyUp = (event: KeyboardEvent): void => {
    const code = normalizedCode(event)
    if (!this.enabled || editableTarget(event.target) || !CONTROL_KEYS.has(code)) return
    event.preventDefault(); this.pressed.delete(code); this.publish(); this.requestHeartbeat()
  }
  private readonly blur = (): void => this.stopImmediately('窗口失焦，已自动停止')
  private readonly visibility = (): void => { if (this.hostDocument.hidden) this.stopImmediately('页面隐藏，已自动停止') }
  private publish(): void { const target = this.target(); this.onState({ enabled: this.enabled,
    resetting: this.resetting, stopReason: this.stopReason, speed: this.speed, ...target }) }
}

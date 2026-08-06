import type { MotionCommand } from './types'

export type DemoSpeed = 'low' | 'medium'
export interface KeyboardLocomotionState {
  enabled: boolean; stopReason: string | null; speed: DemoSpeed
  forwardVelocity: number; yawRate: number
}
export interface KeyboardLocomotionTransport {
  setMotionCommand(command: MotionCommand): Promise<unknown>
  clearMotionCommand(): Promise<unknown>
  reset(): Promise<unknown>
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
  private sequence = 1
  private timer: number | null = null
  private enabled = false
  private disposed = false
  private resetting = false
  private speed: DemoSpeed = 'low'
  private stopReason: string | null = null
  private readonly transport: KeyboardLocomotionTransport
  private readonly onState: (state: KeyboardLocomotionState) => void
  private readonly hostWindow: Window
  private readonly hostDocument: Document

  constructor(
    transport: KeyboardLocomotionTransport,
    onState: (state: KeyboardLocomotionState) => void = () => undefined,
    hostWindow: Window = window,
    hostDocument: Document = document,
  ) {
    this.transport = transport; this.onState = onState
    this.hostWindow = hostWindow; this.hostDocument = hostDocument; this.publish()
  }

  isEnabled(): boolean { return this.enabled }
  setSpeed(speed: DemoSpeed): void { this.speed = speed; this.publish(); if (this.enabled) void this.sendHeartbeat() }

  enable(): void {
    if (this.disposed || this.enabled) return
    this.enabled = true
    this.stopReason = null
    this.hostWindow.addEventListener('keydown', this.keyDown)
    this.hostWindow.addEventListener('keyup', this.keyUp)
    this.hostWindow.addEventListener('blur', this.blur)
    this.hostDocument.addEventListener('visibilitychange', this.visibility)
    this.timer = this.hostWindow.setInterval(() => void this.sendHeartbeat(), 50)
    this.publish()
    void this.sendHeartbeat()
  }

  disable(reason = '已解除键盘控制'): void {
    if (!this.enabled) { this.stopReason = reason; this.publish(); return }
    this.enabled = false
    this.stopReason = reason
    this.pressed.clear()
    if (this.timer !== null) this.hostWindow.clearInterval(this.timer)
    this.timer = null
    this.hostWindow.removeEventListener('keydown', this.keyDown)
    this.hostWindow.removeEventListener('keyup', this.keyUp)
    this.hostWindow.removeEventListener('blur', this.blur)
    this.hostDocument.removeEventListener('visibilitychange', this.visibility)
    void this.transport.clearMotionCommand().catch(() => undefined)
    this.publish()
  }

  dispose(): void { if (!this.disposed) { this.disable('控制器已清理'); this.disposed = true } }

  private target(): { forwardVelocity: number; yawRate: number } {
    const values = this.speed === 'low' ? LOW : MEDIUM
    const forward = this.pressed.has('KeyW') || this.pressed.has('ArrowUp')
    const reverse = this.pressed.has('KeyS') || this.pressed.has('ArrowDown')
    const left = this.pressed.has('KeyA') || this.pressed.has('ArrowLeft')
    const right = this.pressed.has('KeyD') || this.pressed.has('ArrowRight')
    return { forwardVelocity: forward === reverse ? 0 : (forward ? values.forward : values.reverse),
      yawRate: left === right ? 0 : (left ? values.yaw : -values.yaw) }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.enabled || this.disposed || this.resetting) return
    const target = this.target()
    const command: MotionCommand = { sequence: this.sequence++, mode: 'locomotion',
      forwardVelocity: target.forwardVelocity, lateralVelocity: 0, yawRate: target.yawRate,
      bodyHeight: .3, validForMs: 250 }
    this.publish()
    try { await this.transport.setMotionCommand(command) } catch { this.disable('命令发送失败，已自动停止') }
  }

  private stopImmediately(reason: string): void {
    this.pressed.clear(); this.stopReason = reason; this.publish()
    void this.transport.clearMotionCommand().catch(() => undefined)
  }

  private async resetRobot(): Promise<void> {
    if (this.resetting) return
    this.resetting = true
    this.pressed.clear(); this.stopReason = '正在重置机器人'; this.publish()
    try {
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
    this.pressed.add(code); this.stopReason = null; this.publish(); void this.sendHeartbeat()
  }
  private readonly keyUp = (event: KeyboardEvent): void => {
    const code = normalizedCode(event)
    if (!this.enabled || editableTarget(event.target) || !CONTROL_KEYS.has(code)) return
    event.preventDefault(); this.pressed.delete(code); this.publish(); void this.sendHeartbeat()
  }
  private readonly blur = (): void => this.stopImmediately('窗口失焦，已自动停止')
  private readonly visibility = (): void => { if (this.hostDocument.hidden) this.stopImmediately('页面隐藏，已自动停止') }
  private publish(): void { const target = this.target(); this.onState({ enabled: this.enabled,
    stopReason: this.stopReason, speed: this.speed, ...target }) }
}

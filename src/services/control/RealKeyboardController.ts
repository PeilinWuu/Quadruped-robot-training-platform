import type { MotionIntent, MotionIntentAdapter } from './motionIntent'
import { sameMotionIntent } from './motionIntent'
import { realRobotService } from '../realRobotService'

export interface RealKeyboardState {
  enabled: boolean; stopReason: string | null
  forwardVelocity: number; lateralVelocity: number; yawRate: number
}

const SPEED = { forward: .30, lateral: .30, yaw: .50 } as const
const KEEPALIVE_PERIOD_MS = 250
const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'])

function editableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
}

export class RealMotionIntentAdapter implements MotionIntentAdapter {
  apply(intent: MotionIntent | null): Promise<unknown> {
    if (!intent) return realRobotService.stop()
    return realRobotService.keyboardMotion({
      forwardVelocity: intent.forwardVelocity, lateralVelocity: intent.lateralVelocity,
      yawRate: intent.yawRate,
    })
  }
}

export class RealKeyboardController {
  private readonly pressed = new Set<string>()
  private enabled = false
  private disposed = false
  private keepalive: ReturnType<typeof globalThis.setInterval> | null = null
  private stopReason: string | null = null
  private desired: MotionIntent | null | undefined
  private lastRequested: MotionIntent | null = null
  private inFlight = false
  private readonly adapter: MotionIntentAdapter
  private readonly onState: (state: RealKeyboardState) => void
  private readonly hostWindow: Window
  private readonly hostDocument: Document

  constructor(
    adapter: MotionIntentAdapter = new RealMotionIntentAdapter(),
    onState: (state: RealKeyboardState) => void = () => undefined,
    hostWindow: Window = window,
    hostDocument: Document = document,
  ) {
    this.adapter = adapter; this.onState = onState; this.hostWindow = hostWindow; this.hostDocument = hostDocument
    this.publish()
  }

  isEnabled(): boolean { return this.enabled }

  enable(): void {
    if (this.disposed || this.enabled) return
    this.enabled = true; this.stopReason = null; this.pressed.clear(); this.lastRequested = null
    this.hostWindow.addEventListener('keydown', this.keyDown)
    this.hostWindow.addEventListener('keyup', this.keyUp)
    this.hostWindow.addEventListener('blur', this.blur)
    this.hostDocument.addEventListener('visibilitychange', this.visibility)
    this.keepalive = globalThis.setInterval(() => {
      if (this.enabled && this.pressed.size) this.request(this.intent(), true)
    }, KEEPALIVE_PERIOD_MS)
    this.publish()
  }

  private detachListeners(): void {
    this.hostWindow.removeEventListener('keydown', this.keyDown)
    this.hostWindow.removeEventListener('keyup', this.keyUp)
    this.hostWindow.removeEventListener('blur', this.blur)
    this.hostDocument.removeEventListener('visibilitychange', this.visibility)
  }

  disable(reason = '已解除真机键盘控制'): void {
    if (!this.enabled) { this.stopReason = reason; this.publish(); return }
    this.enabled = false; this.stopReason = reason; this.pressed.clear()
    this.detachListeners()
    if (this.keepalive !== null) { globalThis.clearInterval(this.keepalive); this.keepalive = null }
    this.request(null, true); this.publish()
  }

  dispose(): void { if (!this.disposed) { this.disable('真机键盘控制器已清理'); this.disposed = true } }

  private intent(): MotionIntent | null {
    const forward = this.pressed.has('KeyW'); const backward = this.pressed.has('KeyS')
    const left = this.pressed.has('KeyA'); const right = this.pressed.has('KeyD')
    const rotateLeft = this.pressed.has('KeyQ'); const rotateRight = this.pressed.has('KeyE')
    const intent: MotionIntent = {
      forwardVelocity: forward === backward ? 0 : forward ? SPEED.forward : -SPEED.forward,
      lateralVelocity: left === right ? 0 : left ? SPEED.lateral : -SPEED.lateral,
      yawRate: rotateLeft === rotateRight ? 0 : rotateLeft ? SPEED.yaw : -SPEED.yaw,
      source: 'keyboard', createdAtMs: Date.now(),
    }
    return intent.forwardVelocity || intent.lateralVelocity || intent.yawRate ? intent : null
  }

  private requestCurrent(): void { this.request(this.intent()) }
  private request(intent: MotionIntent | null, force = false): void {
    if (!force && sameMotionIntent(intent, this.lastRequested)) return
    this.lastRequested = intent
    this.desired = intent
    this.drain()
  }

  private drain(): void {
    if (this.inFlight || this.desired === undefined) return
    const desired = this.desired; this.desired = undefined; this.inFlight = true
    void this.adapter.apply(desired).catch(() => {
      this.stopReason = '真机键盘命令发送失败，已请求停止'
      this.pressed.clear(); this.lastRequested = null
      if (desired !== null) this.desired = null
      else { this.desired = undefined; this.enabled = false; this.detachListeners() }
      this.publish()
    }).finally(() => { this.inFlight = false; this.drain() })
  }

  private stopImmediately(reason: string): void {
    this.pressed.clear(); this.stopReason = reason; this.request(null, true); this.publish()
  }
  private readonly keyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || editableTarget(event.target)) return
    if (event.code === 'Escape') { event.preventDefault(); this.disable('Esc 已停止并解除真机键盘'); return }
    if (event.code === 'Space') { event.preventDefault(); this.stopImmediately('Space 已发送 StopMove'); return }
    if (!MOVEMENT_KEYS.has(event.code)) return
    event.preventDefault(); if (event.repeat || this.pressed.has(event.code)) return
    this.pressed.add(event.code); this.stopReason = null; this.publish(); this.requestCurrent()
  }
  private readonly keyUp = (event: KeyboardEvent): void => {
    if (!this.enabled || editableTarget(event.target) || !MOVEMENT_KEYS.has(event.code)) return
    event.preventDefault(); this.pressed.delete(event.code); this.publish(); this.requestCurrent()
  }
  private readonly blur = (): void => this.stopImmediately('窗口失焦，已发送 StopMove')
  private readonly visibility = (): void => { if (this.hostDocument.hidden) this.stopImmediately('页面隐藏，已发送 StopMove') }
  private publish(): void {
    const intent = this.intent()
    this.onState({ enabled: this.enabled, stopReason: this.stopReason,
      forwardVelocity: intent?.forwardVelocity ?? 0, lateralVelocity: intent?.lateralVelocity ?? 0, yawRate: intent?.yawRate ?? 0 })
  }
}

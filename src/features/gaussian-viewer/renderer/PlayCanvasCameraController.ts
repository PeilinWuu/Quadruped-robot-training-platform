import { Entity, Vec3 } from 'playcanvas'

const MIN_DISTANCE = 0.05
const MAX_DISTANCE = 100_000
const MAX_PITCH = Math.PI * 0.495
const ROTATE_SPEED = 0.006
const PAN_SPEED = 0.0015
const ZOOM_SPEED = 0.001

type PointerMode = 'orbit' | 'pan'

export class PlayCanvasCameraController {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: Entity
  private readonly requestRender: () => void
  private readonly target = new Vec3()
  private pointerId: number | null = null
  private pointerMode: PointerMode = 'orbit'
  private lastX = 0
  private lastY = 0
  private yaw = 0
  private pitch = 0
  private distance = 3
  private enabled = false
  private disposed = false
  private readonly previousTouchAction: string

  constructor(canvas: HTMLCanvasElement, camera: Entity, requestRender: () => void) {
    this.canvas = canvas
    this.camera = camera
    this.requestRender = requestRender
    this.previousTouchAction = canvas.style.touchAction
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    canvas.addEventListener('pointercancel', this.handlePointerUp)
    canvas.addEventListener('wheel', this.handleWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.handleContextMenu)
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) this.releasePointer()
  }

  isEnabled(): boolean {
    return this.enabled && !this.disposed
  }

  reset(target: Vec3, distance: number, yaw = 0, pitch = 0): void {
    if (this.disposed) return
    this.target.copy(target)
    this.distance = Math.min(Math.max(distance, MIN_DISTANCE), MAX_DISTANCE)
    this.yaw = yaw
    this.pitch = Math.min(Math.max(pitch, -MAX_PITCH), MAX_PITCH)
    this.applyPose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.enabled = false
    this.releasePointer()
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp)
    this.canvas.removeEventListener('wheel', this.handleWheel)
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu)
    this.canvas.style.touchAction = this.previousTouchAction
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null || event.button > 2) return
    this.pointerId = event.pointerId
    this.pointerMode = event.button === 1 || event.button === 2 || event.shiftKey ? 'pan' : 'orbit'
    this.lastX = event.clientX
    this.lastY = event.clientY
    this.canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled || event.pointerId !== this.pointerId) return
    const dx = event.clientX - this.lastX
    const dy = event.clientY - this.lastY
    this.lastX = event.clientX
    this.lastY = event.clientY

    if (this.pointerMode === 'orbit') {
      this.yaw -= dx * ROTATE_SPEED
      this.pitch = Math.min(Math.max(this.pitch - dy * ROTATE_SPEED, -MAX_PITCH), MAX_PITCH)
    } else {
      const scale = this.distance * PAN_SPEED
      const rightX = Math.cos(this.yaw)
      const rightZ = -Math.sin(this.yaw)
      this.target.x -= rightX * dx * scale
      this.target.z -= rightZ * dx * scale
      this.target.y += dy * scale
    }

    this.applyPose()
    event.preventDefault()
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return
    this.releasePointer()
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.enabled) return
    this.distance = Math.min(
      Math.max(this.distance * Math.exp(event.deltaY * ZOOM_SPEED), MIN_DISTANCE),
      MAX_DISTANCE,
    )
    this.applyPose()
    event.preventDefault()
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (this.enabled) event.preventDefault()
  }

  private applyPose(): void {
    const horizontalDistance = Math.cos(this.pitch) * this.distance
    const position = new Vec3(
      this.target.x + Math.sin(this.yaw) * horizontalDistance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horizontalDistance,
    )
    this.camera.setPosition(position)
    this.camera.lookAt(this.target)
    this.requestRender()
  }

  private releasePointer(): void {
    if (this.pointerId === null) return
    if (this.canvas.hasPointerCapture(this.pointerId)) {
      this.canvas.releasePointerCapture(this.pointerId)
    }
    this.pointerId = null
  }
}

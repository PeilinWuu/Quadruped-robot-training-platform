import { Entity, Quat, Vec3 } from 'playcanvas'

const MIN_DISTANCE = 0.05
const MAX_DISTANCE = 100_000
const ROTATE_SPEED_DEGREES = 0.006 * 180 / Math.PI
const PAN_SPEED = 0.0015
const ZOOM_SPEED = 0.001
const WORLD_UP = new Vec3(0, 1, 0)
const BASE_RIGHT = new Vec3(1, 0, 0)
const BASE_UP = new Vec3(0, 1, 0)
const BASE_OFFSET = new Vec3(0, 0, 1)

type PointerMode = 'orbit' | 'pan'

export interface OrbitFrame {
  position: Vec3
  right: Vec3
  up: Vec3
}

export function rotateOrbitQuaternion(
  current: Quat,
  horizontalDegrees: number,
  verticalDegrees: number,
): Quat {
  const result = current.clone().normalize()
  if (Number.isFinite(horizontalDegrees) && horizontalDegrees !== 0) {
    const yaw = new Quat().setFromAxisAngle(WORLD_UP, horizontalDegrees)
    result.mul2(yaw, result).normalize()
  }
  if (Number.isFinite(verticalDegrees) && verticalDegrees !== 0) {
    const right = result.transformVector(BASE_RIGHT, new Vec3()).normalize()
    const pitch = new Quat().setFromAxisAngle(right, verticalDegrees)
    result.mul2(pitch, result).normalize()
  }
  return result
}

export function orbitFrame(
  target: Vec3,
  distance: number,
  orientation: Quat,
): OrbitFrame {
  const safeDistance = Number.isFinite(distance)
    ? Math.min(Math.max(distance, MIN_DISTANCE), MAX_DISTANCE)
    : MIN_DISTANCE
  const rotation = orientation.clone().normalize()
  const offset = rotation.transformVector(BASE_OFFSET, new Vec3()).mulScalar(safeDistance)
  return {
    position: target.clone().add(offset),
    right: rotation.transformVector(BASE_RIGHT, new Vec3()).normalize(),
    up: rotation.transformVector(BASE_UP, new Vec3()).normalize(),
  }
}

export class PlayCanvasCameraController {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: Entity
  private readonly requestRender: () => void
  private readonly target = new Vec3()
  private orbitOrientation = new Quat()
  private pointerId: number | null = null
  private pointerMode: PointerMode = 'orbit'
  private lastX = 0
  private lastY = 0
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

  reset(target: Vec3, distance: number): void {
    if (this.disposed) return
    this.target.copy(target)
    this.distance = Number.isFinite(distance)
      ? Math.min(Math.max(distance, MIN_DISTANCE), MAX_DISTANCE)
      : MIN_DISTANCE
    this.orbitOrientation.set(0, 0, 0, 1)
    this.applyPose()
  }

  followTarget(target: Vec3, smoothing = 0.18): void {
    if (this.disposed || !Number.isFinite(target.x + target.y + target.z)) return
    const alpha = Math.min(Math.max(smoothing, 0), 1)
    this.target.lerp(this.target, target, alpha)
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
      this.orbitOrientation = rotateOrbitQuaternion(
        this.orbitOrientation,
        -dx * ROTATE_SPEED_DEGREES,
        -dy * ROTATE_SPEED_DEGREES,
      )
    } else {
      const scale = this.distance * PAN_SPEED
      const frame = orbitFrame(this.target, this.distance, this.orbitOrientation)
      this.target.add(frame.right.mulScalar(-dx * scale))
      this.target.add(frame.up.mulScalar(dy * scale))
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
    if (this.disposed) return
    const frame = orbitFrame(this.target, this.distance, this.orbitOrientation)
    this.camera.setPosition(frame.position)
    this.camera.lookAt(this.target, frame.up)
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

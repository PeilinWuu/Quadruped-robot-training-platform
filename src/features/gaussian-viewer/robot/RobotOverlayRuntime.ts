import { Application, Entity, Quat } from 'playcanvas'
import type { RobotPose } from '../../../services/simulation/types'
import { hasExactQuadrupedJoints, MinimalQuadrupedRig } from './MinimalQuadrupedRig'
import type { RobotBounds } from './MinimalQuadrupedRig'
import { PoseInterpolator } from './PoseInterpolator'
import { finitePoseScalars, normalizeQuaternionTuple } from './robotMath'

export interface RobotOverlayCalibration {
  translation: [number, number, number]
  rotation: [number, number, number, number]
  scale: number
}

export interface RobotOverlayStatus {
  visible: boolean
  hasPose: boolean
  sequence: number | null
  entityCount: number
  primitiveCount: number
}

export const DEFAULT_ROBOT_CALIBRATION: RobotOverlayCalibration = {
  translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1,
}

export class RobotOverlayRuntime {
  readonly overlayRoot: Entity
  readonly alignmentRoot: Entity
  private readonly rig: MinimalQuadrupedRig
  private readonly interpolator = new PoseInterpolator()
  private visible = false
  private hasPose = false
  private sequence: number | null = null
  private contextLost = false
  private disposed = false

  constructor(app: Application) {
    this.overlayRoot = new Entity('Robot Overlay Root', app)
    this.alignmentRoot = new Entity('Simulation Alignment Root', app)
    app.root.addChild(this.overlayRoot)
    this.overlayRoot.addChild(this.alignmentRoot)
    this.rig = new MinimalQuadrupedRig(app, this.alignmentRoot)
    this.overlayRoot.enabled = false
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return
    this.visible = visible
    this.overlayRoot.enabled = visible && this.hasPose && !this.contextLost
  }

  updatePose(pose: RobotPose, immediate = false): boolean {
    if (this.disposed || !hasExactQuadrupedJoints(pose) || !finitePoseScalars(pose)) return false
    const accepted = this.interpolator.push(pose)
    if (!accepted) return false
    this.hasPose = true
    this.sequence = pose.sequence
    const normalizedPose = immediate ? this.interpolator.sample() : null
    if (normalizedPose) this.rig.applyPose(normalizedPose)
    this.overlayRoot.enabled = this.visible && !this.contextLost
    return true
  }

  update(now?: number): void {
    if (this.disposed || !this.visible || !this.hasPose || this.contextLost) return
    const pose = this.interpolator.sample(now)
    if (pose) this.rig.applyPose(pose)
  }

  clearPose(): void {
    this.interpolator.reset()
    this.hasPose = false
    this.sequence = null
    this.overlayRoot.enabled = false
  }

  setContextLost(lost: boolean): void {
    this.contextLost = lost
    this.overlayRoot.enabled = this.visible && this.hasPose && !lost
    if (!lost) this.update()
  }

  setCalibration(calibration: RobotOverlayCalibration): boolean {
    const rotation = normalizeQuaternionTuple(calibration.rotation)
    if (!rotation || calibration.translation.some((value) => !Number.isFinite(value))
      || !Number.isFinite(calibration.scale) || calibration.scale < 0.1 || calibration.scale > 10) return false
    this.alignmentRoot.setLocalPosition(...calibration.translation)
    this.alignmentRoot.setLocalRotation(new Quat(...rotation))
    this.alignmentRoot.setLocalScale(calibration.scale, calibration.scale, calibration.scale)
    return true
  }

  resetCalibration(): void { this.setCalibration(DEFAULT_ROBOT_CALIBRATION) }
  getBounds(): RobotBounds | null { return this.hasPose ? this.rig.getBounds() : null }
  getStatus(): RobotOverlayStatus {
    return {
      visible: this.visible && this.hasPose, hasPose: this.hasPose, sequence: this.sequence,
      entityCount: this.rig.entityCount + 2, primitiveCount: this.rig.primitiveCount,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.interpolator.dispose()
    this.rig.dispose()
    this.overlayRoot.destroy()
  }
}

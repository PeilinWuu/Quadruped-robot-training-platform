export type MotionIntentSource = 'keyboard' | 'planner' | 'policy'

export interface MotionIntent {
  forwardVelocity: number
  lateralVelocity: number
  yawRate: number
  source: MotionIntentSource
  createdAtMs: number
}

export interface MotionIntentAdapter {
  apply(intent: MotionIntent | null): Promise<unknown>
}

export function sameMotionIntent(left: MotionIntent | null, right: MotionIntent | null): boolean {
  if (left === null || right === null) return left === right
  return left.forwardVelocity === right.forwardVelocity
    && left.lateralVelocity === right.lateralVelocity
    && left.yawRate === right.yawRate
    && left.source === right.source
}

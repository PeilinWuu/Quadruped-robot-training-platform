import type { RobotPose } from '../simulation/types'

export type RobotMotionPhase = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error'

export interface RobotMotionMetadata {
  schema: 'go2-motion-playback-v1'
  clipId: string
  displayName: string
  fps: number
  frameCount: number
  loopMode: 'loop'
  componentsPerFrame: 19
  frameBytes: 76
  componentType: 'float32-little-endian'
  jointOrder: string[]
  cycleDeltaPosition: [number, number, number]
}

export interface RobotMotionState {
  phase: RobotMotionPhase
  clipId: string | null
  displayName: string | null
  frameIndex: number
  frameCount: number
  playing: boolean
  speed: number
  keyboardEnabled: boolean
  forwardInput: -1 | 0 | 1
  lateralInput: -1 | 0 | 1
  turnInput: -1 | 0 | 1
  error: string | null
}

export type RobotMotionPoseListener = (pose: RobotPose) => void
export type RobotMotionStateListener = (state: RobotMotionState) => void

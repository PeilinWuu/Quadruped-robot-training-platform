// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RobotPose } from '../simulation/types'
import { RobotMotionPlaybackService } from './robotMotionPlaybackService'

afterEach(() => vi.restoreAllMocks())

describe('RobotMotionPlaybackService animation-driven control', () => {
  it('applies movement constraints before emitting position and stops the gait when blocked',async()=> {
    const service=new RobotMotionPlaybackService();await service.load()
    let pose:RobotPose|null=null;service.onPose(p=>pose=p)
    service.movementConstraint=(start)=>start
    service.play();service.setControlInput(1,0);service.update(.1)
    expect(pose!.rootPosition[0]).toBe(0)
    expect(service.getState().frameIndex).toBe(0)
    expect(pose!.joints[1].position).toBe(.72)
    service.movementConstraint=null;service.update(.1)
    expect(pose!.rootPosition[0]).toBeCloseTo(.03)
  })
  it('uses WASD for root motion while joint animation remains clip-driven', async () => {
    const service = new RobotMotionPlaybackService()
    await service.load()
    let pose: RobotPose | null = null
    const unsubscribe = service.onPose((value) => { pose = value })
    service.play(); service.setControlInput(1, 0)
    service.update(.1)
    expect(service.getState().forwardInput).toBe(1)
    expect(pose!.rootPosition[0]).toBeCloseTo(.03)
    service.setControlInput(1, 0, 1)
    service.update(.1)
    expect(service.getState().turnInput).toBe(1)
    expect(pose!.rootOrientation[1]).not.toBe(0)
    service.setControlInput(0, 0, 0)
    expect(service.getState().forwardInput).toBe(0)
    expect(service.getState().turnInput).toBe(0)
    unsubscribe()
  })
})

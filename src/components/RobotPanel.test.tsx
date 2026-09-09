import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RobotMotionState } from '../services/robot-motion-playback/types'
import type { RobotPose } from '../services/simulation/types'
import { RobotPanelContent } from './RobotPanel'

const motion: RobotMotionState = {
  phase: 'playing', clipId: 'solo8_walk', displayName: 'Solo8 Walk', frameIndex: 41,
  frameCount: 120, playing: true, speed: 1, keyboardEnabled: true,
  forwardInput: 0, lateralInput: 0, turnInput: 0, error: null,
}
const pose: RobotPose = {
  sequence: 42, simulationTime: 1.25, wallTime: 1000,
  rootPosition: [1, 2, 3], rootOrientation: [0, 0, 0, 1],
  joints: Array.from({ length: 12 }, (_, index) => ({ name: `playback-joint-${index}`, position: index / 10 })),
}

describe('RobotPanel motion playback fields', () => {
  it('renders the playback root pose, progress and all 12 joints', () => {
    const html = renderToStaticMarkup(<RobotPanelContent motion={motion} pose={pose}/>)
    expect(html).toContain('X 1.000 · Y 2.000 · Z 3.000')
    expect(html).toContain('42 / 120')
    for (let index = 0; index < 12; index += 1) expect(html).toContain(`playback-joint-${index}`)
  })
  it('states that dynamics are unavailable and real Go2 is not connected', () => {
    const html = renderToStaticMarkup(<RobotPanelContent motion={motion} pose={pose}/>)
    expect(html).toContain('不运行 MuJoCo、MPC、逆运动学或碰撞求解')
    expect(html).toContain('关节速度、力矩、足端接触力、虚拟 IMU 和碰撞状态')
    expect(html).toContain('实体 Go2 尚未连接')
  })
})

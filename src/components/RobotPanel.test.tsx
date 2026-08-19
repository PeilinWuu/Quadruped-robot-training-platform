import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../store/useAppStore'
import { RobotPanelContent } from './RobotPanel'
import { FLAT_GROUND_ENVIRONMENT } from '../services/simulation/types'

describe('RobotPanel real simulation fields', () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({ simulation: {
      ...state.simulation,
      processState: 'ready', simulationState: 'paused', speed: 2,
      selectedModelId: 'minimal-quadruped-v1',
      model: { modelId: 'minimal-quadruped-v1', environmentId: 'flat-ground-v1', environment: FLAT_GROUND_ENVIRONMENT, timestep: .002, jointCount: 12, actuatorCount: 12, bodyCount: 14 },
      latestPose: {
        sequence: 42, simulationTime: 1.25, updatedAt: 1000,
        rootPosition: [1, 2, 3], rootOrientation: [0, 0, 0, 1],
        joints: Array.from({ length: 12 }, (_, index) => ({ name: `real-joint-${index}`, position: index / 10 })),
      },
    } }))
  })

  it('renders the real root pose and all 12 joints', () => {
    const html = renderToStaticMarkup(<RobotPanelContent simulation={useAppStore.getState().simulation}/>)
    expect(html).toContain('X 1.000 · Y 2.000 · Z 3.000')
    expect(html).toContain('Pose sequence')
    expect(html).toContain('42')
    for (let index = 0; index < 12; index += 1) expect(html).toContain(`real-joint-${index}`)
  })

  it('labels unavailable telemetry instead of presenting mock values as real', () => {
    const html = renderToStaticMarkup(<RobotPanelContent simulation={useAppStore.getState().simulation}/>)
    expect(html).toContain('已接入电池、IMU、足端力、12 关节与 Sport 状态摘要')
    expect(html).toContain('暂未接入')
    expect(html).toContain('真机在线只由近期实体遥测确认')
    expect(html).toContain('项目测试模型')
  })

  it('renders the low-rate ROS bridge control summary', () => {
    const html = renderToStaticMarkup(<RobotPanelContent
      simulation={useAppStore.getState().simulation}
      rosBridge={{
        state: 'running', available: true, controlSource: 'ros', bridgeVersion: '0.1.0',
        lastCmdVelAgeMs: 42, watchdogState: 'armed', error: null,
      }}/>)
    expect(html).toContain('Control Source')
    expect(html).toContain('Running')
    expect(html).toContain('42 ms')
    expect(html).toContain('armed · 300 ms')
  })
})

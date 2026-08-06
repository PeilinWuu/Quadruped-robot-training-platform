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
    expect(html).toContain('电池、CPU 温度、网络信号、真实步态、传感器状态、Actuator telemetry')
    expect(html).toContain('暂未接入')
    expect(html).toContain('实体机器人未连接')
    expect(html).toContain('项目测试模型')
  })
})

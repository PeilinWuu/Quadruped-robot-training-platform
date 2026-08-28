import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RealRobotControls } from './RealRobotControls'
import type { RealRobotStatus } from '../services/realRobotService'
import { spatialStateFromSimulationPose } from '../services/spatial/simulationSpatialAdapter'

const status = (overrides: Partial<RealRobotStatus> = {}): RealRobotStatus => ({
  state: 'ready', available: true, live: false, controlEnabled: false, activeMove: false,
  gatewayVersion: 'go2-real-gateway-0.1.0', lastAction: null, robotOnline: false,
  telemetryAgeMs: null, telemetry: null, error: null, ...overrides,
})

describe('RealRobotControls', () => {
  it('keeps all robot motion unavailable in dry-run', () => {
    const html = renderToStaticMarkup(<RealRobotControls initialStatus={status()}/>)
    expect(html).toContain('DRY-RUN')
    expect(html).toContain('UI 不能自行升级为 LIVE')
    expect(html).toContain('disabled=""')
  })

  it('labels online only from recent physical telemetry', () => {
    const html = renderToStaticMarkup(<RealRobotControls initialStatus={status({
      live: true, robotOnline: true, telemetryAgeMs: 42,
      telemetry: { lowState: { tick: 1, batterySoc: 80, powerVoltage: 28.5, powerCurrent: 1.2, rpy: [0, 0, 0], gyroscope: [0, 0, 0], accelerometer: [0, 0, 9.8], footForce: [1, 2, 3, 4], joints: Array.from({ length: 12 }, () => ({ position: 0, velocity: 0, torque: 0, temperature: 30 })) }, sportModeState: null },
    })}/>)
    expect(html).toContain('是 · 42 ms')
    expect(html).toContain('80% · 28.5 V · 1.2 A')
    expect(html).toContain('12/12')
  })

  it('renders Sport error_code as raw data without declaring a fault', () => {
    const html = renderToStaticMarkup(<RealRobotControls initialStatus={status({
      live: true, robotOnline: true, telemetryAgeMs: 10,
      telemetry: { lowState: null, sportModeState: { errorCode: 16, mode: 1, gaitType: 1, position: [0, 0, 0.3], velocity: [0, 0, 0], bodyHeight: .3, yawSpeed: 0 } },
    })}/>)
    expect(html).toContain('Sport error_code（原始）')
    expect(html).toContain('16 / 0x00000010')
    expect(html).toContain('不参与控制授权或运动判定')
  })

  it('documents the unified keyboard target and watchdog', () => {
    const html = renderToStaticMarkup(<RealRobotControls initialStatus={status({
      live: true, robotOnline: true, telemetryAgeMs: 10, controlEnabled: true,
    })}/>)
    expect(html).toContain('真机已加入统一键盘目标')
    expect(html).toContain('启用同步键盘控制')
    expect(html).toContain('W/S 前后 · A/D 横移 · Q/E 旋转')
    expect(html).toContain('保持期间每 250 ms 刷新一次高层 Move')
    expect(html).toContain('vx/vy ±0.30 m/s · yaw ±0.50 rad/s')
    expect(html).toContain('真机离线或未解锁时，键盘只控制仿真')
  })

  it('shows real spatial input and enables origin alignment with a simulation reference', () => {
    const reference = spatialStateFromSimulationPose({
      sequence: 9, simulationTime: 1, wallTime: 1000,
      rootPosition: [2, 1, -3], rootOrientation: [0, 0, 0, 1], joints: [],
    })
    const html = renderToStaticMarkup(<RealRobotControls referenceSpatialState={reference} initialStatus={status({
      live: true, robotOnline: true, telemetryAgeMs: 10,
      telemetry: {
        lowState: { tick: 5, batterySoc: 80, powerVoltage: 28, powerCurrent: 1, rpy: [0, 0, .2], gyroscope: [0, 0, 0], accelerometer: [0, 0, 9.8], footForce: [1, 1, 1, 1], joints: [] },
        sportModeState: { errorCode: 0, mode: 1, gaitType: 1, position: [10, -4, .3], velocity: [0, 0, 0], bodyHeight: .3, yawSpeed: 0 },
      },
    })}/>)
    expect(html).toContain('真机/仿真统一坐标')
    expect(html).toContain('10.000 / -4.000 / 0.300')
    expect(html).toContain('以当前仿真位姿设置同步原点')
    expect(html).toContain('Sport position + IMU RPY · low confidence')
    expect(html).not.toContain('请先启动 MuJoCo 仿真')
  })
})

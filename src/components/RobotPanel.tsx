import { Bot, Cpu, Gauge, RadioTower } from 'lucide-react'
import { Panel } from './Panel'
import { useAppStore, type SimulationUiState } from '../store/useAppStore'
import { SIMULATION_MODELS } from '../services/simulation/types'

const number = (value: number) => value.toFixed(3)
const vector = (value: [number, number, number]) => value.map(number).join(', ')

export function RobotPanel() {
  const simulation = useAppStore((state) => state.simulation)
  return <RobotPanelContent simulation={simulation}/>
}

export function RobotPanelContent({ simulation }: { simulation: SimulationUiState }) {
  const pose = simulation.latestPose
  const telemetry = simulation.latestTelemetry
  const connected = simulation.processState === 'ready'
  const description = SIMULATION_MODELS.find((model) => model.id === simulation.selectedModelId)!
  const updatedAt = telemetry?.wallTime ?? pose?.updatedAt
  const updated = updatedAt ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '暂未接入'
  const command = telemetry?.command ?? simulation.latestMotionCommand
  return <Panel title="机器人状态" extra={<span className={connected ? 'online' : 'offline'}><i/>{connected ? ' SIDECAR READY' : ' OFFLINE'}</span>}>
    <div className="robot-live-summary">
      <div className="robot-model"><div className="model-body"><Bot size={38}/></div><span>{simulation.model?.modelId ?? '暂未加载模型'}</span></div>
      <dl>
        <div><dt>数据源</dt><dd>{telemetry ? 'MuJoCo 虚拟机器人' : '等待虚拟遥测'}</dd></div>
        <div><dt>实体机器人</dt><dd>未连接</dd></div>
        <div><dt>Simulation</dt><dd>{simulation.simulationState}</dd></div>
        <div><dt>当前模型</dt><dd>{description.displayName}</dd></div>
        <div><dt>模型来源</dt><dd>{description.source}</dd></div>
        <div><dt>外观</dt><dd>{simulation.visualMode === 'official-mesh' ? 'Go2 官方网格' : '基础几何'}</dd></div>
        <div><dt>仿真时间</dt><dd>{telemetry ? `${number(telemetry.simulationTime)} s` : pose ? `${number(pose.simulationTime)} s` : '暂未接入'}</dd></div>
        <div><dt>倍速</dt><dd>{simulation.speed.toFixed(2)}×</dd></div>
        <div><dt>Telemetry sequence</dt><dd>{telemetry?.sequence ?? '暂未接入'}</dd></div>
        <div><dt>Pose sequence</dt><dd>{pose?.sequence ?? '暂未接入'}</dd></div>
        <div><dt>更新时间</dt><dd>{updated}</dd></div>
      </dl>
    </div>
    <div className="robot-pose-grid">
      <section><h4><Gauge size={13}/>根节点 · 世界 Y-up</h4><p>位置：{telemetry ? vector(telemetry.root.position) : pose ? `X ${number(pose.rootPosition[0])} · Y ${number(pose.rootPosition[1])} · Z ${number(pose.rootPosition[2])}` : '暂未接入'}</p><p>线速度：{telemetry ? `${vector(telemetry.root.linearVelocityWorld)} m/s（${number(telemetry.root.linearSpeed)}）` : '暂未接入'}</p><p>角速度：{telemetry ? `${vector(telemetry.root.angularVelocityWorld)} rad/s（${number(telemetry.root.angularSpeed)}）` : '暂未接入'}</p></section>
      <section><h4><RadioTower size={13}/>虚拟 IMU · body frame</h4>{telemetry ? <><p>姿态 [x,y,z,w]：{telemetry.imu.orientation.map(number).join(', ')}</p><p>角速度：{vector(telemetry.imu.angularVelocityBody)} rad/s</p><p>线加速度：{vector(telemetry.imu.linearAccelerationBody)} m/s²</p><p>包含重力：{telemetry.imu.includesGravity ? '是' : '否'} · {telemetry.imu.source}</p></> : <p>暂未接入</p>}</section>
    </div>
    <details className="robot-telemetry-details"><summary>12 关节遥测 {telemetry ? `${telemetry.joints.length}/12` : ''}</summary>
      <div className="robot-telemetry-table"><div className="head"><b>Joint</b><b>Pos</b><b>Vel</b><b>Torque</b><b>Force</b><b>Target</b><b>Limit</b></div>{telemetry?.joints.map((joint) => <div key={joint.name}><i>{joint.name}</i><span>{number(joint.position)}</span><span>{number(joint.velocity)}</span><span>{number(joint.actuatorTorque)}</span><span>{number(joint.actuatorForce)}</span><span>{number(joint.controlTarget)}</span><span>{joint.limited ? `${number(joint.lowerLimit!)}…${number(joint.upperLimit!)}` : 'unlimited'}</span></div>) ?? pose?.joints.map((joint) => <div key={joint.name}><i>{joint.name}</i><span>{number(joint.position)}</span><span>暂未接入</span><span>暂未接入</span><span>暂未接入</span><span>暂未接入</span><span>暂未接入</span></div>) ?? <p>暂未接入</p>}</div>
    </details>
    <details className="robot-telemetry-details" open><summary>四足接触 · 世界 Y-up</summary><div className="robot-feet-grid">{telemetry?.feet.map((foot) => <span key={foot.name}><b>{foot.name} · {foot.inContact ? '接触' : '未接触'}</b><i>{foot.contactCount} 点 · {number(foot.normalForce)} N</i><i>Force {vector(foot.forceWorld)}</i></span>) ?? <p>暂未接入</p>}</div></details>
    <details className="robot-telemetry-details"><summary>仿真性能（非硬实时保证）</summary>{telemetry ? <dl className="robot-performance"><div><dt>Physics / Control</dt><dd>{number(telemetry.performance.physicsFrequencyHz)} / {number(telemetry.performance.controlFrequencyHz)} Hz</dd></div><div><dt>Pose / Telemetry</dt><dd>{number(telemetry.performance.posePublishFrequencyHz)} / {number(telemetry.performance.telemetryPublishFrequencyHz)} Hz</dd></div><div><dt>Real-time factor</dt><dd>{number(telemetry.performance.realTimeFactor)}</dd></div><div><dt>Physics mean/max</dt><dd>{number(telemetry.performance.physicsStepMeanMs)} / {number(telemetry.performance.physicsStepMaxMs)} ms</dd></div><div><dt>Control mean/max</dt><dd>{number(telemetry.performance.controlStepMeanMs)} / {number(telemetry.performance.controlStepMaxMs)} ms</dd></div><div><dt>Dropped pose/telemetry</dt><dd>{telemetry.performance.droppedPoseEvents} / {telemetry.performance.droppedTelemetryEvents}</dd></div></dl> : <p>暂未接入</p>}</details>
    <section className="robot-unavailable"><h4><Gauge size={13}/>虚拟运动命令</h4><p>{command ? `${command.mode} · [${number(command.forwardVelocity)}, ${number(command.lateralVelocity)}, ${number(command.yawRate)}] · ${command.timedOut ? '已超时' : '有效'} · ${command.appliedByController ? '控制器已执行' : '仅接收，未执行'} · ${command.controllerAvailability}` : '暂未发送'}</p></section>
    <section className="robot-unavailable"><h4><Cpu size={13}/>尚未接入的实体遥测</h4><p>电池、CPU 温度、网络信号、真实步态、传感器状态、Actuator telemetry、实体 Go2 在线状态、相机、LiDAR、真机故障码：<b>暂未接入</b></p></section>
    <section className="robot-unavailable"><h4><RadioTower size={13}/>连接边界</h4><p><b>实体机器人未连接</b>；当前数据只来自 MuJoCo 仿真。{description.description}</p></section>
  </Panel>
}

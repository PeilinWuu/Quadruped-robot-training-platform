import { Bot, Cpu, Gauge, RadioTower } from 'lucide-react'
import { Panel } from './Panel'
import { useAppStore, type SimulationUiState } from '../store/useAppStore'
import { SIMULATION_MODELS } from '../services/simulation/types'

const number = (value: number) => value.toFixed(3)

export function RobotPanel() {
  const simulation = useAppStore((state) => state.simulation)
  return <RobotPanelContent simulation={simulation}/>
}

export function RobotPanelContent({ simulation }: { simulation: SimulationUiState }) {
  const pose = simulation.latestPose
  const connected = simulation.processState === 'ready'
  const description = SIMULATION_MODELS.find((model) => model.id === simulation.selectedModelId)!
  const updated = pose ? new Date(pose.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '暂未接入'
  return <Panel title="机器人状态" extra={<span className={connected ? 'online' : 'offline'}><i/>{connected ? ' SIDECAR READY' : ' OFFLINE'}</span>}>
    <div className="robot-live-summary">
      <div className="robot-model"><div className="model-body"><Bot size={38}/></div><span>{simulation.model?.modelId ?? '暂未加载模型'}</span></div>
      <dl>
        <div><dt>Sidecar</dt><dd>{simulation.processState}</dd></div>
        <div><dt>Simulation</dt><dd>{simulation.simulationState}</dd></div>
        <div><dt>当前模型</dt><dd>{description.displayName}</dd></div>
        <div><dt>模型来源</dt><dd>{description.source}</dd></div>
        <div><dt>可视化</dt><dd>{description.visualProfile}</dd></div>
        <div><dt>外观</dt><dd>{simulation.visualMode === 'official-mesh' ? 'Go2 官方网格' : '基础几何'}</dd></div>
        <div><dt>网格状态</dt><dd>{simulation.visualPhase}{simulation.visualError ? '（已回退）' : ''}</dd></div>
        <div><dt>模型加载</dt><dd>{simulation.model ? '仿真模型已加载' : '暂未加载'}</dd></div>
        <div><dt>仿真时间</dt><dd>{pose ? `${number(pose.simulationTime)} s` : '暂未接入'}</dd></div>
        <div><dt>倍速</dt><dd>{simulation.speed.toFixed(2)}×</dd></div>
        <div><dt>Pose sequence</dt><dd>{pose?.sequence ?? '暂未接入'}</dd></div>
        <div><dt>更新时间</dt><dd>{updated}</dd></div>
      </dl>
    </div>
    <div className="robot-pose-grid">
      <section><h4><Gauge size={13}/>根节点位置</h4><p>{pose ? `X ${number(pose.rootPosition[0])} · Y ${number(pose.rootPosition[1])} · Z ${number(pose.rootPosition[2])}` : '暂未接入'}</p></section>
      <section><h4><RadioTower size={13}/>根节点朝向 [x, y, z, w]</h4><p>{pose ? pose.rootOrientation.map(number).join(', ') : '暂未接入'}</p></section>
    </div>
    <section className="robot-joints"><h4>关节位置 {pose ? `${pose.joints.length}/12` : ''}</h4><div>{pose?.joints.map((joint) => <span key={joint.name}><i>{joint.name}</i><b>{number(joint.position)} rad</b></span>) ?? <p>暂未接入</p>}</div></section>
    <section className="robot-unavailable"><h4><Cpu size={13}/>尚未接入的真实遥测</h4><p>电池、CPU 温度、网络信号、真实步态、传感器状态、Actuator telemetry：<b>暂未接入</b></p></section>
    <section className="robot-unavailable"><h4><RadioTower size={13}/>连接边界</h4><p><b>实体机器人未连接</b>；当前仅为 {description.visualProfile}。{description.description}</p></section>
  </Panel>
}

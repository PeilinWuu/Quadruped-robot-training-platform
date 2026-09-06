import { useEffect, useState } from 'react'
import { Bot, Cpu, Film, Gauge, RadioTower } from 'lucide-react'
import { Panel } from './Panel'
import { robotMotionPlaybackService } from '../services/robot-motion-playback/robotMotionPlaybackService'
import type { RobotMotionState } from '../services/robot-motion-playback/types'
import type { RobotPose } from '../services/simulation/types'

const number = (value: number) => value.toFixed(3)

export function RobotPanel() {
  const [motion, setMotion] = useState<RobotMotionState>(() => robotMotionPlaybackService.getState())
  const [pose, setPose] = useState<RobotPose | null>(null)
  useEffect(() => robotMotionPlaybackService.subscribe(setMotion), [])
  useEffect(() => robotMotionPlaybackService.onPose(setPose), [])
  return <RobotPanelContent motion={motion} pose={pose}/>
}

export function RobotPanelContent({ motion, pose }: { motion: RobotMotionState; pose: RobotPose | null }) {
  const available = motion.frameCount > 0 && motion.phase !== 'error'
  const progress = motion.frameCount > 0 ? `${motion.frameIndex + 1} / ${motion.frameCount}` : '未加载'
  return <Panel title="机器人状态" extra={<span className={available ? 'online' : 'offline'}><i/>{available ? ' PLAYBACK READY' : ' OFFLINE'}</span>}>
    <div className="robot-live-summary">
      <div className="robot-model"><div className="model-body"><Bot size={38}/></div><span>unitree-go2</span></div>
      <dl>
        <div><dt>数据源</dt><dd>程序化运动播片</dd></div>
        <div><dt>实体机器人</dt><dd>未连接</dd></div>
        <div><dt>播放状态</dt><dd>{motion.phase}</dd></div>
        <div><dt>运动片段</dt><dd>{motion.displayName ?? 'Solo8 Walk'}</dd></div>
        <div><dt>当前帧</dt><dd>{progress}</dd></div>
        <div><dt>倍速</dt><dd>{motion.speed.toFixed(2)}×</dd></div>
        <div><dt>键盘控制</dt><dd>{motion.keyboardEnabled ? 'WASD 已启用' : '已关闭'}</dd></div>
        <div><dt>外观</dt><dd>Unitree Go2 官方网格</dd></div>
        <div><dt>动力学计算</dt><dd>已停用</dd></div>
      </dl>
    </div>
    <div className="robot-pose-grid"><section><h4><Gauge size={13}/>根节点 · 世界 Y-up</h4>
      <p>位置：{pose ? `X ${number(pose.rootPosition[0])} · Y ${number(pose.rootPosition[1])} · Z ${number(pose.rootPosition[2])}` : '等待运动资产'}</p>
      <p>姿态 [x,y,z,w]：{pose ? pose.rootOrientation.map(number).join(', ') : '等待运动资产'}</p>
    </section></div>
    <details className="robot-telemetry-details" open><summary>12 关节关键帧 {pose ? `${pose.joints.length}/12` : ''}</summary>
      <div className="robot-joints"><div>{pose?.joints.map((joint) => <span key={joint.name}><i>{joint.name}</i><b>{number(joint.position)}</b></span>) ?? <p>等待运动资产</p>}</div></div>
    </details>
    <section className="robot-unavailable"><h4><Film size={13}/>动画驱动控制</h4><p>W/S 控制前后，A/D 横移，Q/E 转向，Space 停止；程序化步态提供关节动画，不运行 MuJoCo、MPC、逆运动学或碰撞求解。</p></section>
    <section className="robot-unavailable"><h4><Cpu size={13}/>动力学遥测</h4><p>关节速度、力矩、足端接触力、虚拟 IMU 和碰撞状态在播片模式下<b>不生成</b>，避免把动画数据误认为真实物理量。</p></section>
    <section className="robot-unavailable"><h4><RadioTower size={13}/>真机接口边界</h4><p><b>实体 Go2 尚未连接</b>；后续直接对接 Unitree 高层运动指令及真实传感器遥测，演示播片不参与真机控制。</p></section>
    {motion.error && <section className="robot-unavailable"><h4>运动资产错误</h4><p>{motion.error}</p></section>}
  </Panel>
}

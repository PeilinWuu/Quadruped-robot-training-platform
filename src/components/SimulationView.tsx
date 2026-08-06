import { lazy, Suspense, useState } from 'react'
import { Box, Camera, Crosshair, Expand, Eye, Pause, Play, RefreshCw, SkipForward, Square, Video } from 'lucide-react'
import { Dropdown, Segmented, Select, Tooltip } from 'antd'
import { useAppStore, type SimulationActionResult } from '../store/useAppStore'
import { SIMULATION_MODELS, type MotionCommandMode, type SimulationModelId } from '../services/simulation/types'

const GaussianViewport = lazy(() => import('../features/gaussian-viewer/GaussianViewport'))

export function SimulationView({ notify }: { notify: (text: string) => void }) {
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const simulation = useAppStore((state) => state.simulation)
  const start = useAppStore((state) => state.startSimulation)
  const pause = useAppStore((state) => state.pauseSimulation)
  const resume = useAppStore((state) => state.resumeSimulation)
  const step = useAppStore((state) => state.stepSimulation)
  const reset = useAppStore((state) => state.resetSimulation)
  const stop = useAppStore((state) => state.stopSimulation)
  const setSpeed = useAppStore((state) => state.setSimulationSpeed)
  const selectModel = useAppStore((state) => state.selectSimulationModel)
  const sendMotion = useAppStore((state) => state.setMotionCommand)
  const clearMotion = useAppStore((state) => state.clearMotionCommand)
  const setTelemetryRate = useAppStore((state) => state.setTelemetryRate)
  const sensor = useAppStore((state) => state.sensor)
  const [mode, setMode] = useState<MotionCommandMode>('stand')
  const [forward, setForward] = useState(0)
  const [lateral, setLateral] = useState(0)
  const [yaw, setYaw] = useState(0)
  const [height, setHeight] = useState(.3)
  const [validForMs, setValidForMs] = useState(500)
  const [sequence, setSequence] = useState(1)
  const [telemetryRate, setTelemetryRateValue] = useState(50)

  const run = async (operation: () => Promise<SimulationActionResult>, success: string) => {
    const result = await operation()
    notify(result.ok ? success : result.error ?? '仿真操作失败')
  }
  const toggleRun = () => simulation.simulationState === 'running'
    ? run(pause, '仿真已暂停')
    : simulation.simulationState === 'paused'
      ? run(resume, '仿真已继续')
      : run(start, 'MuJoCo 仿真已启动')
  const toggleLabel = simulation.simulationState === 'running'
    ? '暂停'
    : simulation.simulationState === 'paused' ? '继续' : '启动'
  const changeMode = (next: MotionCommandMode) => {
    setMode(next)
    if (next === 'stand') { setForward(0); setLateral(0); setYaw(0) }
  }
  const sendTarget = async () => {
    const result = await sendMotion({
      sequence, mode,
      forwardVelocity: mode === 'stand' ? 0 : forward,
      lateralVelocity: mode === 'stand' ? 0 : lateral,
      yawRate: mode === 'stand' ? 0 : yaw,
      bodyHeight: height, validForMs,
    })
    if (result.ok) setSequence((value) => value + 1)
    notify(result.ok ? '目标已接收' : result.error ?? '目标发送失败')
  }
  const commandValid = Number.isInteger(sequence) && sequence >= 0
    && Number.isFinite(height) && height >= .18 && height <= .4
    && Number.isInteger(validForMs) && validForMs >= 100 && validForMs <= 2000
    && (mode === 'stand' || (Number.isFinite(forward) && forward >= -.2 && forward <= .3
      && lateral === 0 && Number.isFinite(yaw) && yaw >= -.5 && yaw <= .5))

  return <section className="sim-panel"><div className="sim-toolbar"><div className="view-modes"><button className="active"><Box size={15} />漫游</button><button onClick={() => notify('自由视角接口已预留，等待仿真引擎接入')}><Eye size={15} />自由视角</button><button onClick={() => notify('跟随视角接口已预留，等待仿真引擎接入')}><Camera size={15} />跟随</button><button onClick={() => notify('第一人称接口已预留，等待视频流接入')}><Video size={15} />第一人称</button></div><div className="play-controls" aria-label="MuJoCo 仿真控制">
    <Select aria-label="仿真模型" size="small" className="simulation-model-select" open={modelMenuOpen} onOpenChange={setModelMenuOpen} value={simulation.selectedModelId} disabled={simulation.busy || simulation.simulationState === 'running'} options={SIMULATION_MODELS.map((model) => ({ value: model.id, label: model.displayName }))} onChange={(value: SimulationModelId) => { setModelMenuOpen(false); void run(() => selectModel(value), '仿真模型已切换') }} />
    <span className={`simulation-process simulation-process--${simulation.processState}`}>{simulation.desktop ? simulation.processState : '仅桌面版'}</span>
    <Tooltip title={toggleLabel}><button aria-label={toggleLabel} disabled={simulation.busy} className={simulation.simulationState === 'paused' ? 'active' : ''} onClick={() => void toggleRun()}>{simulation.simulationState === 'running' ? <Pause size={16} /> : <Play size={16} />}</button></Tooltip>
    <Tooltip title="单步（固定 1 步）"><button aria-label="单步" disabled={simulation.busy || !simulation.model} onClick={() => void run(step, '仿真已推进 1 步')}><SkipForward size={15}/></button></Tooltip>
    <Tooltip title="停止物理仿真"><button aria-label="停止仿真" disabled={simulation.busy || ['unloaded', 'stopped'].includes(simulation.simulationState)} onClick={() => void run(stop, '物理仿真已停止，Sidecar 保持就绪')}><Square size={15} /></button></Tooltip>
    <Tooltip title="重置"><button aria-label="重置仿真" disabled={simulation.busy || !simulation.model} onClick={() => void run(reset, '仿真已重置')}><RefreshCw size={15} /></button></Tooltip>
    <Segmented size="small" disabled={simulation.busy || !simulation.model} value={simulation.speed} onChange={(value) => void run(() => setSpeed(Number(value)), `仿真倍速已切换为 ${value}×`)} options={[{ label: '0.25×', value: .25 }, { label: '0.5×', value: .5 }, { label: '1×', value: 1 }, { label: '2×', value: 2 }, { label: '4×', value: 4 }]} />
  </div><Dropdown menu={{ items: [{ key: 'engine', label: 'PlayCanvas / MuJoCo' }, { key: 'stream', label: 'ROS / WebSocket 视频流预留' }] }}><button><Expand size={15} />画面源</button></Dropdown></div>
  <details className="motion-command-panel"><summary>虚拟运动指令 <span>{simulation.latestMotionCommand?.timedOut ? '已超时' : simulation.latestMotionCommand ? '目标已接收' : '待发送'}</span></summary>
    <div className="motion-command-grid">
      <label>控制模式<select value={mode} onChange={(event) => changeMode(event.target.value as MotionCommandMode)}><option value="stand">站立保持</option><option value="locomotion">Convex MPC（D5V-MPC-1）</option></select></label>
      <label>前向速度（m/s，-0.20～0.30）<input type="number" min="-0.2" max="0.3" step="0.01" disabled={mode === 'stand'} value={mode === 'stand' ? 0 : forward} onChange={(event) => setForward(event.currentTarget.valueAsNumber)}/></label>
      <label>横向速度（本阶段固定 0）<input type="number" value={0} disabled/></label>
      <label>偏航角速度（rad/s，-0.50～0.50）<input type="number" min="-0.5" max="0.5" step="0.05" disabled={mode === 'stand'} value={mode === 'stand' ? 0 : yaw} onChange={(event) => setYaw(event.currentTarget.valueAsNumber)}/></label>
      <label>机身高度（m，0.18～0.40）<input type="number" min="0.18" max="0.4" step="0.01" value={height} onChange={(event) => setHeight(event.currentTarget.valueAsNumber)}/></label>
      <label>有效时间（ms，100～2000）<input type="number" min="100" max="2000" step="100" value={validForMs} onChange={(event) => setValidForMs(event.currentTarget.valueAsNumber)}/></label>
      <label>遥测频率（Hz，10～100）<input type="number" min="10" max="100" step="10" value={telemetryRate} onChange={(event) => setTelemetryRateValue(event.currentTarget.valueAsNumber)} onBlur={() => void run(() => setTelemetryRate(telemetryRate), '遥测频率已更新')}/></label>
      <div className="motion-command-status"><span>序列 {simulation.latestMotionCommand?.sequence ?? sequence}</span><span>年龄 {simulation.latestMotionCommand ? `${simulation.latestMotionCommand.ageMs.toFixed(0)} ms` : '—'}</span><span>超时 {simulation.latestMotionCommand?.timedOut ? '是' : '否'}</span><span>控制器执行 {simulation.latestMotionCommand?.appliedByController ? '是' : '否'}</span></div>
    </div>
    {mode === 'locomotion' && <p className="motion-command-warning">go2-convex-mpc-v1 仅用于 Go2 + flat-ground-v1；MuJoCo仿真专用Convex MPC，不代表实体Go2控制器。侧移尚未接入。</p>}
    <div className="motion-command-actions"><button disabled={!commandValid || simulation.busy || !simulation.desktop || !simulation.model} onClick={() => void sendTarget()}>发送目标</button><button disabled={simulation.busy || !simulation.desktop || !simulation.model} onClick={() => void run(clearMotion, '目标已清除，恢复站立保持')}>清除目标</button></div>
  </details>
  <div className="sim-viewport"><Suspense fallback={<div className="gaussian-viewport__loading">正在加载 GPU 视口模块</div>}><GaussianViewport/></Suspense>{simulation.simulationState !== 'running' && <div className="sim-overlay sim-overlay--simulation"><div>{simulation.simulationState === 'paused' ? <Pause size={30} /> : simulation.simulationState === 'unloaded' ? <Play size={28}/> : <Square size={28} />}</div><strong>{simulation.simulationState === 'paused' ? '仿真已暂停' : simulation.simulationState === 'unloaded' ? '等待启动 MuJoCo' : '物理仿真已停止'}</strong>{simulation.lastError ? <small>{simulation.lastError}</small> : null}</div>}
  {sensor && <div className="telemetry"><strong>环境检测 · MOCK</strong><span>温度 <b>{sensor.temperature}°C</b></span><span>烟雾 <b>{sensor.smoke}</b></span><span>可见度 <b>{sensor.visibility} m</b></span><span>CO 浓度 <b>{sensor.co} ppm</b></span><span>氧浓度 <b>{sensor.oxygen}%</b></span></div>}
  <div className="sim-actions">{['添加目标', '清除目标', '设置禁区', '清除路径', '标记点', '测量距离'].map((label) => <button key={label} onClick={() => notify(`${label}接口已预留，等待仿真引擎接入`)}><Crosshair size={13} />{label}</button>)}</div></div></section>
}

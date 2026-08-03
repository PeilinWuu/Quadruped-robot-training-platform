import { lazy, Suspense } from 'react'
import { Box, Camera, Crosshair, Expand, Eye, Pause, Play, RefreshCw, SkipForward, Square, Video } from 'lucide-react'
import { Dropdown, Segmented, Tooltip } from 'antd'
import { useAppStore, type SimulationActionResult } from '../store/useAppStore'

const GaussianViewport = lazy(() => import('../features/gaussian-viewer/GaussianViewport'))

export function SimulationView({ notify }: { notify: (text: string) => void }) {
  const simulation = useAppStore((state) => state.simulation)
  const start = useAppStore((state) => state.startSimulation)
  const pause = useAppStore((state) => state.pauseSimulation)
  const resume = useAppStore((state) => state.resumeSimulation)
  const step = useAppStore((state) => state.stepSimulation)
  const reset = useAppStore((state) => state.resetSimulation)
  const stop = useAppStore((state) => state.stopSimulation)
  const setSpeed = useAppStore((state) => state.setSimulationSpeed)
  const sensor = useAppStore((state) => state.sensor)

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

  return <section className="sim-panel"><div className="sim-toolbar"><div className="view-modes"><button className="active"><Box size={15} />漫游</button><button onClick={() => notify('自由视角接口已预留，等待仿真引擎接入')}><Eye size={15} />自由视角</button><button onClick={() => notify('跟随视角接口已预留，等待仿真引擎接入')}><Camera size={15} />跟随</button><button onClick={() => notify('第一人称接口已预留，等待视频流接入')}><Video size={15} />第一人称</button></div><div className="play-controls" aria-label="MuJoCo 仿真控制">
    <span className={`simulation-process simulation-process--${simulation.processState}`}>{simulation.desktop ? simulation.processState : '仅桌面版'}</span>
    <Tooltip title={toggleLabel}><button aria-label={toggleLabel} disabled={simulation.busy} className={simulation.simulationState === 'paused' ? 'active' : ''} onClick={() => void toggleRun()}>{simulation.simulationState === 'running' ? <Pause size={16} /> : <Play size={16} />}</button></Tooltip>
    <Tooltip title="单步（固定 1 步）"><button aria-label="单步" disabled={simulation.busy || !simulation.model} onClick={() => void run(step, '仿真已推进 1 步')}><SkipForward size={15}/></button></Tooltip>
    <Tooltip title="停止物理仿真"><button aria-label="停止仿真" disabled={simulation.busy || ['unloaded', 'stopped'].includes(simulation.simulationState)} onClick={() => void run(stop, '物理仿真已停止，Sidecar 保持就绪')}><Square size={15} /></button></Tooltip>
    <Tooltip title="重置"><button aria-label="重置仿真" disabled={simulation.busy || !simulation.model} onClick={() => void run(reset, '仿真已重置')}><RefreshCw size={15} /></button></Tooltip>
    <Segmented size="small" disabled={simulation.busy || !simulation.model} value={simulation.speed} onChange={(value) => void run(() => setSpeed(Number(value)), `仿真倍速已切换为 ${value}×`)} options={[{ label: '0.25×', value: .25 }, { label: '0.5×', value: .5 }, { label: '1×', value: 1 }, { label: '2×', value: 2 }, { label: '4×', value: 4 }]} />
  </div><Dropdown menu={{ items: [{ key: 'engine', label: 'PlayCanvas / MuJoCo' }, { key: 'stream', label: 'ROS / WebSocket 视频流预留' }] }}><button><Expand size={15} />画面源</button></Dropdown></div>
  <div className="sim-viewport"><Suspense fallback={<div className="gaussian-viewport__loading">正在加载 GPU 视口模块</div>}><GaussianViewport/></Suspense>{simulation.simulationState !== 'running' && <div className="sim-overlay sim-overlay--simulation"><div>{simulation.simulationState === 'paused' ? <Pause size={30} /> : simulation.simulationState === 'unloaded' ? <Play size={28}/> : <Square size={28} />}</div><strong>{simulation.simulationState === 'paused' ? '仿真已暂停' : simulation.simulationState === 'unloaded' ? '等待启动 MuJoCo' : '物理仿真已停止'}</strong>{simulation.lastError ? <small>{simulation.lastError}</small> : null}</div>}
  {sensor && <div className="telemetry"><strong>环境检测 · MOCK</strong><span>温度 <b>{sensor.temperature}°C</b></span><span>烟雾 <b>{sensor.smoke}</b></span><span>可见度 <b>{sensor.visibility} m</b></span><span>CO 浓度 <b>{sensor.co} ppm</b></span><span>氧浓度 <b>{sensor.oxygen}%</b></span></div>}
  <div className="sim-actions">{['添加目标', '清除目标', '设置禁区', '清除路径', '标记点', '测量距离'].map((label) => <button key={label} onClick={() => notify(`${label}接口已预留，等待仿真引擎接入`)}><Crosshair size={13} />{label}</button>)}</div></div></section>
}

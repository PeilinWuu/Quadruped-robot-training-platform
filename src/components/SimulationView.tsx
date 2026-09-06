import { lazy, Suspense, useEffect, useState } from 'react'
import { Box, Camera, Crosshair, Expand, Eye, Flame, Keyboard, Pause, Play, RefreshCw, Video } from 'lucide-react'
import { Dropdown, Segmented, Tooltip } from 'antd'
import { useAppStore } from '../store/useAppStore'
import { firePlaybackService } from '../services/fire-playback/firePlaybackService'
import type { FirePlaybackState } from '../services/fire-playback/types'
import { robotMotionPlaybackService } from '../services/robot-motion-playback/robotMotionPlaybackService'
import type { RobotMotionState } from '../services/robot-motion-playback/types'

const GaussianViewport = lazy(() => import('../features/gaussian-viewer/GaussianViewport'))

export function SimulationView({ notify }: { notify: (text: string) => void }) {
  const sensor = useAppStore((state) => state.sensor)
  const robotFirstPerson = useAppStore((state) => state.simulation.robotFirstPerson)
  const setRobotFirstPerson = useAppStore((state) => state.setRobotFirstPerson)
  const [fire, setFire] = useState<FirePlaybackState>(() => firePlaybackService.getState())
  const [motion, setMotion] = useState<RobotMotionState>(() => robotMotionPlaybackService.getState())

  useEffect(() => firePlaybackService.subscribe(setFire), [])
  useEffect(() => {
    let activated = false
    const unsubscribe = robotMotionPlaybackService.subscribe((state) => {
      setMotion(state)
      if (!activated && state.phase === 'ready') {
        activated = true
        robotMotionPlaybackService.setKeyboardEnabled(true)
        robotMotionPlaybackService.play()
      }
    })
    if (robotMotionPlaybackService.getState().phase === 'idle') void robotMotionPlaybackService.load()
    return () => { unsubscribe(); robotMotionPlaybackService.setKeyboardEnabled(false) }
  }, [])

  const loadFire = () => void firePlaybackService.load('/fire-playback/table_high/')
  const loadMotion = () => void robotMotionPlaybackService.load().then(() => {
    robotMotionPlaybackService.setKeyboardEnabled(true); robotMotionPlaybackService.play()
  })

  return <section className="sim-panel">
    <div className="sim-toolbar">
      <div className="view-modes">
        <button className="active"><Box size={15}/>漫游</button>
        <button onClick={() => notify('自由视角已启用，可使用鼠标旋转、平移和缩放')}><Eye size={15}/>自由视角</button>
        <button onClick={() => notify('跟随视角默认关闭，避免覆盖手动平移')}><Camera size={15}/>跟随</button>
        <button
          className={robotFirstPerson ? 'active' : ''}
          disabled={motion.frameCount === 0}
          onClick={() => setRobotFirstPerson(!robotFirstPerson)}
          title="切换 Go2 机身前端实时 RGB 视角"
        ><Video size={15}/>{robotFirstPerson ? '退出第一人称' : '第一人称'}</button>
      </div>

      <div className="play-controls" aria-label="Go2 motion playback controls">
        <span className={`simulation-process simulation-process--${motion.phase}`}>播片 · {motion.phase}</span>
        {motion.phase === 'idle' || motion.phase === 'error'
          ? <button type="button" onClick={loadMotion}>{motion.phase === 'error' ? '重试运动资产' : '加载运动'}</button>
          : <Tooltip title={motion.playing ? '暂停运动播片' : '播放运动播片'}><button
              aria-label={motion.playing ? '暂停运动播片' : '播放运动播片'}
              disabled={motion.phase === 'loading'}
              onClick={() => motion.playing ? robotMotionPlaybackService.pause() : robotMotionPlaybackService.play()}
            >{motion.playing ? <Pause size={16}/> : <Play size={16}/>}</button></Tooltip>}
        <Tooltip title="重置运动播片"><button aria-label="重置运动播片" disabled={motion.frameCount === 0} onClick={() => robotMotionPlaybackService.reset()}><RefreshCw size={15}/></button></Tooltip>
        <Tooltip title="W/S 前后，A/D 横移，Q/E 转向，Space 停止"><button aria-label="切换键盘运动控制" disabled={motion.frameCount === 0} className={motion.keyboardEnabled ? 'active' : ''} onClick={() => robotMotionPlaybackService.setKeyboardEnabled(!motion.keyboardEnabled)}><Keyboard size={15}/></button></Tooltip>
        <Segmented size="small" disabled={motion.frameCount === 0} value={motion.speed} onChange={(value) => robotMotionPlaybackService.setSpeed(Number(value))} options={[{ label: '0.25×', value: .25 }, { label: '0.5×', value: .5 }, { label: '1×', value: 1 }, { label: '2×', value: 2 }]}/>
        <small>{motion.displayName ?? motion.error ?? 'Go2 程序化对角步态'} · {motion.frameCount ? `${motion.frameIndex + 1}/${motion.frameCount}` : '—'} · {motion.keyboardEnabled ? 'WASD/QE' : '键盘关闭'}</small>
      </div>

      <div className="fire-playback-controls" aria-label="FieryGS fire playback controls">
        <span className={`fire-playback-status fire-playback-status--${fire.phase}`}><Flame size={14}/>Table HIGH · {fire.stage ?? fire.phase}</span>
        {fire.phase === 'idle' || fire.phase === 'error'
          ? <button type="button" onClick={loadFire}>{fire.phase === 'error' ? '重试火灾资产' : '加载火灾'}</button>
          : <button type="button" disabled={fire.phase === 'loading'} onClick={() => fire.playing ? firePlaybackService.pause() : firePlaybackService.play()}>{fire.playing ? <Pause size={14}/> : <Play size={14}/>}</button>}
        <button type="button" disabled={fire.frameCount === 0} onClick={() => firePlaybackService.reset()}><RefreshCw size={13}/></button>
        <small>{fire.sourceFrame === null ? (fire.error ?? '未加载') : `${fire.frameIndex + 1}/${fire.frameCount} · source ${fire.sourceFrame}`}</small>
      </div>

      <Dropdown menu={{ items: [{ key: 'playback', label: 'Go2 运动播片 / FieryGS 播片' }, { key: 'stream', label: 'Unitree 高层接口 / 视频流预留' }] }}>
        <button><Expand size={15}/>画面源</button>
      </Dropdown>
    </div>

    <div className="sim-viewport">
      <Suspense fallback={<div className="gaussian-viewport__loading">正在加载 GPU 视口模块</div>}><GaussianViewport/></Suspense>
      {motion.phase === 'loading' && <div className="sim-overlay sim-overlay--simulation"><div><Play size={28}/></div><strong>正在加载 Go2 运动播片</strong></div>}
      {motion.phase === 'error' && <div className="sim-overlay sim-overlay--simulation"><strong>运动播片加载失败</strong><small>{motion.error}</small></div>}
      {sensor && <div className="telemetry"><strong>环境检测 · MOCK</strong><span>温度 <b>{sensor.temperature}°C</b></span><span>烟雾 <b>{sensor.smoke}</b></span><span>可见度 <b>{sensor.visibility} m</b></span><span>CO 浓度 <b>{sensor.co} ppm</b></span><span>氧浓度 <b>{sensor.oxygen}%</b></span></div>}
      <div className="sim-actions">{['添加目标', '清除目标', '设置禁区', '清除路径', '标记点', '测量距离'].map((label) => <button key={label} onClick={() => notify(`${label}接口已预留，等待任务层接入`)}><Crosshair size={13}/>{label}</button>)}</div>
    </div>
  </section>
}

import { lazy, Suspense, useEffect, useState } from 'react'
import { Box, Camera, Crosshair, Expand, Eye, Flame, Keyboard, Pause, Play, RefreshCw, Video } from 'lucide-react'
import { Dropdown, Segmented, Tooltip } from 'antd'
import { useAppStore } from '../store/useAppStore'
import { firePlaybackService } from '../services/fire-playback/firePlaybackService'
import type { FirePlaybackState, FireQuality, FireVersion } from '../services/fire-playback/types'
import { robotMotionPlaybackService } from '../services/robot-motion-playback/robotMotionPlaybackService'
import type { RobotMotionState } from '../services/robot-motion-playback/types'

const GaussianViewport = lazy(() => import('../features/gaussian-viewer/GaussianViewport'))

export function SimulationView({ notify }: { notify: (text: string) => void }) {
  const sensor = useAppStore((state) => state.sensor)
  const robotFirstPerson = useAppStore((state) => state.simulation.robotFirstPerson)
  const setRobotFirstPerson = useAppStore((state) => state.setRobotFirstPerson)
  const [fire, setFire] = useState<FirePlaybackState>(() => firePlaybackService.getState())
  const [fireVersion, setFireVersion] = useState<FireVersion>('playback-v1')
  const [fireQuality, setFireQuality] = useState<FireQuality>('medium')
  const [atmosphere, setAtmosphere] = useState(firePlaybackService.atmosphereEnabled)
  const [roomBusy, setRoomBusy] = useState(false)
  const [depthStatus, setDepthStatus] = useState(firePlaybackService.depthStatus)
  const [fireFps, setFireFps] = useState(0)
  const [motion, setMotion] = useState<RobotMotionState>(() => robotMotionPlaybackService.getState())

  useEffect(() => firePlaybackService.subscribe(setFire), [])
  useEffect(() => {
    const timer = window.setInterval(() => { setDepthStatus(firePlaybackService.depthStatus); setFireQuality(firePlaybackService.quality); setFireFps(firePlaybackService.fps) }, 1000)
    return () => window.clearInterval(timer)
  }, [])
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

  const toggleRoomFire = async () => {
    setRoomBusy(true)
    try {
      if (fire.sceneMode === 'room') await firePlaybackService.setSceneMode('single')
      else { await firePlaybackService.setSceneMode('room'); setFireVersion('playback-v1'); firePlaybackService.reset(); firePlaybackService.play() }
    } finally { setRoomBusy(false) }
  }
  const lookAtFire = (id: string) => { setRobotFirstPerson(false); firePlaybackService.focusFire(id) }
  const loadFire = () => void firePlaybackService.selectVersion(fireVersion)
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

      <div className="fire-playback-controls" role="toolbar" aria-label="火焰播放">
        <strong className="fire-playback-title"><Flame size={15}/>火焰播放</strong>
        <button type="button" disabled={roomBusy} onClick={() => void toggleRoomFire()}>{roomBusy ? '正在加载多点火场…' : fire.sceneMode === 'room' ? '切回单桌火焰' : '启动多点火场'}</button>
        <select disabled={roomBusy || fire.sceneMode === 'room'} aria-label="火焰播放版本" value={fire.version ?? fireVersion} onChange={(event) => {
          const version = event.target.value as FireVersion; setFireVersion(version); void firePlaybackService.selectVersion(version)
        }}><option value="playback-v1">V1</option><option value="playback-v2">V2 原型</option></select>
        <select aria-label="火焰质量" value={fireQuality} onChange={(event) => {
          const quality = event.target.value as FireQuality; setFireQuality(quality); firePlaybackService.setQuality(quality)
        }}><option value="high">High 128</option><option value="medium">Medium 96</option><option value="low">Low 64</option><option value="off">Off</option></select>
        <label title="只降低火焰质量"><input type="checkbox" defaultChecked onChange={(event) => { firePlaybackService.autoQuality = event.target.checked }}/>自动</label>
        <label title="根据场景深度截断火焰，取消可对照原效果"><input type="checkbox" defaultChecked={firePlaybackService.depthOcclusion} onChange={(event) => { firePlaybackService.depthOcclusion = event.target.checked }}/>遮挡</label>
        {depthStatus === 'unavailable' && <small role="alert">场景遮挡加载失败，当前未遮挡</small>}
        <span className={`fire-playback-status fire-playback-status--${fire.phase}`}>{fire.sceneMode === 'room' ? '桌子＋沙发＋窗帘' : '桌面火焰'} · {fire.stage ?? fire.phase}</span>
        {fire.phase === 'idle' || fire.phase === 'error'
          ? <button type="button" onClick={loadFire}>{fire.phase === 'error' ? '重试火灾资产' : '加载火灾'}</button>
          : <button type="button" aria-label={fire.playing ? '暂停火焰' : '播放火焰'} disabled={fire.phase === 'loading'} onClick={() => fire.playing ? firePlaybackService.pause() : firePlaybackService.play()}>{fire.playing ? '暂停火焰' : '播放火焰'}</button>}
        <button type="button" disabled={fire.frameCount === 0} onClick={() => firePlaybackService.reset()}>重置火焰</button>
        {fire.sceneMode === 'room' && <label><input type="checkbox" checked={atmosphere} onChange={(event) => { setAtmosphere(event.target.checked); firePlaybackService.atmosphereEnabled = event.target.checked }}/>火场氛围</label>}
        {fire.sceneMode === 'room' && <span className="fire-scene-views">
          <button type="button" onClick={() => lookAtFire('table_high')}>看桌子</button>
          <button type="button" onClick={() => lookAtFire('sofa_high')}>看沙发</button>
          <button type="button" onClick={() => lookAtFire('curtain_high')}>看窗帘</button>
        </span>}
        {fire.additionalFires?.some((item) => item.error) && <small role="alert">部分火点加载失败，请切回单桌后重试：{fire.additionalFires.filter((item) => item.error).map((item) => `${item.id}: ${item.error}`).join('；')}</small>}
        <small title={fire.fallbackReason ?? undefined}>{fire.fallbackReason ? '已回退 V1 · ' : ''}{fireFps > 0 ? `${fireFps.toFixed(0)} FPS · ` : ''}{fire.sourceFrame === null ? (fire.error ?? '未加载') : `${fire.frameIndex + 1}/${fire.frameCount} · source ${fire.sourceFrame}`}</small>
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

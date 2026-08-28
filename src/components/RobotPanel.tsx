import { useEffect, useRef, useState } from 'react'
import { Bot, Cpu, Gauge, RadioTower } from 'lucide-react'
import { Panel } from './Panel'
import { useAppStore, type SimulationUiState } from '../store/useAppStore'
import { SIMULATION_MODELS } from '../services/simulation/types'
import { simulationService } from '../services/simulation/simulationService'
import { KeyboardLocomotionController, type DemoSpeed, type KeyboardLocomotionState } from '../services/simulation/KeyboardLocomotionController'
import { editableElement, keyboardUiState, nativeKeyboardService, shouldAutoDisarmKeyboard, type NativeKeyboardDiagnostics } from '../services/simulation/nativeKeyboardService'
import { rosBridgeService, rosPerfDiagnostic, UNAVAILABLE_ROS_BRIDGE, type ControlSource, type RosBridgeStatus } from '../services/simulation/rosBridgeService'
import { RealRobotControls } from './RealRobotControls'
import { yawFromQuaternion } from '../services/spatial/transformMath'

const number = (value: number) => value.toFixed(3)
const vector = (value: [number, number, number]) => value.map(number).join(', ')
const latency = (later: number, earlier: number) => later >= earlier && earlier > 0 ? `${((later - earlier) / 1000).toFixed(2)} ms` : '—'
const rosStateLabel = (state: RosBridgeStatus['state']) => ({ unavailable: 'Unavailable', ready: 'Ready', running: 'Running', fault: 'Fault' })[state]

export function RobotPanel({ diagnostic = false }: { diagnostic?: boolean }) {
  if (diagnostic) return <DiagnosticRobotPanel/>
  return <RuntimeRobotPanel/>
}

function DiagnosticRobotPanel() {
  const counters = window.__D6_CHROMIUM_POC__
  if (counters) counters.robotPanelRenders += 1
  const simulation = useAppStore((state) => state.simulation)
  return <RobotPanelContent simulation={simulation}/>
}

function RuntimeRobotPanel() {
  rosPerfDiagnostic.recordRender()
  const simulation = useAppStore((state) => state.simulation)
  const reset = useAppStore((state) => state.resetSimulation)
  const clearEvent = useAppStore((state) => state.clearLatestCollisionEvent)
  const setFollowRobot = useAppStore((state) => state.setFollowRobot)
  const controllerRef = useRef<KeyboardLocomotionController | null>(null)
  const nativeModeRef = useRef(false)
  const [nativeMode, setNativeMode] = useState(false)
  const [nativeDiagnostics, setNativeDiagnostics] = useState<NativeKeyboardDiagnostics | null>(null)
  const [rosBridge, setRosBridge] = useState<RosBridgeStatus>(UNAVAILABLE_ROS_BRIDGE)
  const [keyboard, setKeyboard] = useState<KeyboardLocomotionState>({ enabled: false, resetting: false, stopReason: null, speed: 'medium', forwardVelocity: 0, lateralVelocity: 0, yawRate: 0 })
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    let unlistenReset: (() => void) | null = null
    const focusIn = (event: FocusEvent) => {
      if (editableElement(event.target)) void nativeKeyboardService.setInputSuppressed(true).then((state) => !disposed && setKeyboard(keyboardUiState(state)))
    }
    const focusOut = (event: FocusEvent) => {
      if (editableElement(event.target) && !editableElement(event.relatedTarget)) void nativeKeyboardService.setInputSuppressed(false).then((state) => !disposed && setKeyboard(keyboardUiState(state)))
    }
    void nativeKeyboardService.capabilities().then(async (capabilities) => {
      if (disposed) return
      if (capabilities.realtimeInputMode === 'native') {
        nativeModeRef.current = true
        setNativeMode(true)
        unlisten = await nativeKeyboardService.subscribe((state) => { if (!disposed) setKeyboard(keyboardUiState(state)) })
        if (disposed) { unlisten(); return }
        unlistenReset = await nativeKeyboardService.subscribeResetRequested(() => { if (!disposed) void reset() })
        if (disposed) { unlistenReset(); return }
        const state = await nativeKeyboardService.state()
        if (!disposed) setKeyboard(keyboardUiState(state))
        document.addEventListener('focusin', focusIn)
        document.addEventListener('focusout', focusOut)
        if (editableElement(document.activeElement)) void nativeKeyboardService.setInputSuppressed(true)
        return
      }
      const controller = new KeyboardLocomotionController({
        setMotionCommand: (command) => simulationService.setMotionCommand(command),
        clearMotionCommand: () => simulationService.clearMotionCommand(),
        reset: () => simulationService.reset(),
      }, setKeyboard)
      controllerRef.current = controller
    })
    return () => {
      disposed = true
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
      unlisten?.()
      unlistenReset?.()
      if (nativeModeRef.current) void nativeKeyboardService.disarm()
      controllerRef.current?.dispose()
      controllerRef.current = null
      nativeModeRef.current = false
    }
  }, [reset])
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void rosBridgeService.status().then((status) => { if (!disposed) { rosPerfDiagnostic.recordStateUpdate(); setRosBridge(status) } })
    void rosBridgeService.subscribe((status) => { if (!disposed) { rosPerfDiagnostic.recordStateUpdate(); setRosBridge(status) } }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(() => {
    if (!rosPerfDiagnostic.enabled()) return
    let previous = rosPerfDiagnostic.snapshot()
    let previousAt = performance.now()
    const timer = globalThis.setInterval(() => {
      const current = rosPerfDiagnostic.snapshot()
      const now = performance.now()
      const elapsed = Math.max((now - previousAt) / 1000, 0.001)
      console.info('D6_ROS_PERF_DIAGNOSTIC', {
        component: 'frontend', time_s: (now - current.startedAt) / 1000,
        active_listeners: current.activeListeners, max_active_listeners: current.maxActiveListeners,
        ros_event_hz: (current.events - previous.events) / elapsed,
        ros_state_update_hz: (current.stateUpdates - previous.stateUpdates) / elapsed,
        robot_panel_render_hz: (current.renders - previous.renders) / elapsed,
        event_count: current.events, state_update_count: current.stateUpdates, render_count: current.renders,
      })
      previous = current
      previousAt = now
    }, 1000)
    return () => globalThis.clearInterval(timer)
  }, [])
  const locomotionAllowed = simulation.selectedModelId === 'unitree-go2-menagerie'
    && simulation.simulationState === 'running' && !simulation.latestTelemetry?.collision.isFallen
    && simulation.latestTelemetry?.locomotion.state !== 'fault'
  useEffect(() => {
    if (shouldAutoDisarmKeyboard(locomotionAllowed, nativeModeRef.current, keyboard.resetting)) {
      if (nativeModeRef.current && keyboard.enabled) void nativeKeyboardService.disarm().then((state) => setKeyboard(keyboardUiState(state)))
      if (controllerRef.current?.isEnabled()) controllerRef.current.disable('仿真状态变化，已自动停止')
    }
  }, [keyboard.enabled, keyboard.resetting, locomotionAllowed])
  return <RobotPanelContent simulation={simulation} keyboard={keyboard} rosBridge={rosBridge}
    nativeMode={nativeMode} nativeDiagnostics={nativeDiagnostics}
    onControlSource={(source) => void rosBridgeService.setControlSource(source).then(setRosBridge)}
    onToggleKeyboard={() => {
      if (rosBridge.controlSource !== 'manual') return
      if (nativeModeRef.current) {
        const action = keyboard.enabled ? nativeKeyboardService.disarm() : locomotionAllowed ? nativeKeyboardService.arm() : null
        if (action) void action.then((state) => setKeyboard(keyboardUiState(state)))
      } else if (keyboard.enabled) controllerRef.current?.disable()
      else if (locomotionAllowed) controllerRef.current?.enable()
    }}
    onSpeed={(speed) => {
      if (nativeModeRef.current) void nativeKeyboardService.setSpeed(speed).then((state) => setKeyboard(keyboardUiState(state)))
      else controllerRef.current?.setSpeed(speed)
    }} onRefreshNativeDiagnostics={nativeMode ? () => void nativeKeyboardService.diagnostics().then(setNativeDiagnostics) : undefined}
    onFollow={setFollowRobot}
    onReset={() => void reset()} onClearEvent={clearEvent}/>
}

export function RobotPanelContent({ simulation, keyboard, nativeMode, nativeDiagnostics, rosBridge = UNAVAILABLE_ROS_BRIDGE, onControlSource, onToggleKeyboard, onSpeed, onFollow, onReset, onClearEvent, onRefreshNativeDiagnostics }: {
  simulation: SimulationUiState; keyboard?: KeyboardLocomotionState; onToggleKeyboard?: () => void
  nativeMode?: boolean; nativeDiagnostics?: NativeKeyboardDiagnostics | null
  rosBridge?: RosBridgeStatus; onControlSource?: (source: ControlSource) => void
  onSpeed?: (speed: DemoSpeed) => void; onFollow?: (enabled: boolean) => void
  onReset?: () => void; onClearEvent?: () => void; onRefreshNativeDiagnostics?: () => void
}) {
  const pose = simulation.latestPose
  const telemetry = simulation.latestTelemetry
  const connected = simulation.processState === 'ready'
  const description = SIMULATION_MODELS.find((model) => model.id === simulation.selectedModelId)!
  const updatedAt = telemetry?.wallTime ?? pose?.updatedAt
  const updated = updatedAt ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '暂未接入'
  const command = telemetry?.command ?? simulation.latestMotionCommand
  const collision = telemetry?.collision
  const collisionEvent = simulation.latestCollisionEvent
  const locomotion = telemetry?.locomotion
  const spatial = simulation.latestSpatialState
  const keyboardAllowed = simulation.selectedModelId === 'unitree-go2-menagerie'
    && simulation.simulationState === 'running' && !collision?.isFallen && locomotion?.state !== 'fault'
  return <Panel title="机器人状态" extra={<span className={connected ? 'online' : 'offline'}><i/>{connected ? ' SIDECAR READY' : ' OFFLINE'}</span>}>
    <div className="robot-live-summary">
      <div className="robot-model"><div className="model-body"><Bot size={38}/></div><span>{simulation.model?.modelId ?? '暂未加载模型'}</span></div>
      <dl>
        <div><dt>数据源</dt><dd>{telemetry ? 'MuJoCo 虚拟机器人' : '等待虚拟遥测'}</dd></div>
        <div><dt>实体机器人</dt><dd>以近期真机遥测判定</dd></div>
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
      <section><h4><RadioTower size={13}/>统一坐标 · ROS Z-up</h4>{spatial ? <><p>Frame：{spatial.worldToOdom.parentFrame} → {spatial.odomToBase.parentFrame} → {spatial.odomToBase.childFrame}</p><p>位置：X {number(spatial.odomToBase.transform.translation[0])} · Y {number(spatial.odomToBase.transform.translation[1])} · Z {number(spatial.odomToBase.transform.translation[2])}</p><p>Yaw：{number(yawFromQuaternion(spatial.odomToBase.transform.rotation))} rad · [x,y,z,w]</p><p>协议 v{spatial.schemaVersion} · {spatial.source} · {spatial.confidence}</p></> : <p>等待统一位姿</p>}</section>
      <section><h4><RadioTower size={13}/>虚拟 IMU · body frame</h4>{telemetry ? <><p>姿态 [x,y,z,w]：{telemetry.imu.orientation.map(number).join(', ')}</p><p>角速度：{vector(telemetry.imu.angularVelocityBody)} rad/s</p><p>线加速度：{vector(telemetry.imu.linearAccelerationBody)} m/s²</p><p>包含重力：{telemetry.imu.includesGravity ? '是' : '否'} · {telemetry.imu.source}</p></> : <p>暂未接入</p>}</section>
    </div>
    <details className="robot-telemetry-details"><summary>12 关节遥测 {telemetry ? `${telemetry.joints.length}/12` : ''}</summary>
      <div className="robot-telemetry-table"><div className="head"><b>Joint</b><b>Pos</b><b>Vel</b><b>Torque</b><b>Force</b><b>Target</b><b>Limit</b></div>{telemetry?.joints.map((joint) => <div key={joint.name}><i>{joint.name}</i><span>{number(joint.position)}</span><span>{number(joint.velocity)}</span><span>{number(joint.actuatorTorque)}</span><span>{number(joint.actuatorForce)}</span><span>{number(joint.controlTarget)}</span><span>{joint.limited ? `${number(joint.lowerLimit!)}…${number(joint.upperLimit!)}` : 'unlimited'}</span></div>) ?? pose?.joints.map((joint) => <div key={joint.name}><i>{joint.name}</i><span>{number(joint.position)}</span><span>暂未接入</span><span>暂未接入</span><span>暂未接入</span><span>暂未接入</span><span>暂未接入</span></div>) ?? <p>暂未接入</p>}</div>
    </details>
    <details className="robot-telemetry-details" open><summary>四足接触 · 世界 Y-up</summary><div className="robot-feet-grid">{telemetry?.feet.map((foot) => <span key={foot.name}><b>{foot.name} · {foot.inContact ? '接触' : '未接触'}</b><i>{foot.contactCount} 点 · {number(foot.normalForce)} N</i><i>Force {vector(foot.forceWorld)}</i></span>) ?? <p>暂未接入</p>}</div></details>
    <section className="robot-unavailable ros-control-source">
      <h4><RadioTower size={13}/>ROS 2 本机桥接</h4>
      <label>Control Source <select value={rosBridge.controlSource} onChange={(event) => onControlSource?.(event.target.value as ControlSource)}><option value="manual">Manual Keyboard</option><option value="ros" disabled={!rosBridge.available}>ROS 2</option></select></label>
      <dl className="robot-performance">
        <div><dt>ROS 2</dt><dd>{rosStateLabel(rosBridge.state)}</dd></div>
        <div><dt>Bridge availability</dt><dd>{rosBridge.available ? `Ready${rosBridge.bridgeVersion ? ` · ${rosBridge.bridgeVersion}` : ''}` : 'Unavailable'}</dd></div>
        <div><dt>Control source</dt><dd>{rosBridge.controlSource}</dd></div>
        <div><dt>Last cmd_vel age</dt><dd>{rosBridge.lastCmdVelAgeMs == null ? '—' : `${rosBridge.lastCmdVelAgeMs} ms`}</dd></div>
        <div><dt>Watchdog</dt><dd>{rosBridge.watchdogState} · 300 ms</dd></div>
      </dl>
      {rosBridge.error && <p className="collision-alert">ROS bridge: {rosBridge.error}</p>}
    </section>
    <RealRobotControls referenceSpatialState={spatial}/>
    <details className="robot-telemetry-details flat-ground-collision" open><summary>平地碰撞演示</summary>
      {collision ? <>
        <dl className="robot-performance">
          <div><dt>环境</dt><dd>{simulation.model?.environment.displayName ?? collision.environmentId}</dd></div>
          <div><dt>地面 / 摩擦</dt><dd>{simulation.model ? `${simulation.model.environment.halfExtent * 2}m · ${simulation.model.environment.friction.join(' / ')}` : '—'}</dd></div>
          <div><dt>总接触 / 足端</dt><dd>{collision.totalEnvironmentContacts} / {collision.footContacts}</dd></div>
          <div><dt>非足端 / 躯干</dt><dd>{collision.nonFootContacts} / {collision.torsoContacts}</dd></div>
          <div><dt>最大 / 总法向力</dt><dd>{number(collision.maxNormalForce)} / {number(collision.totalNormalForce)} N</dd></div>
          <div><dt>根高度</dt><dd>{number(collision.rootHeightAboveFloor)} m</dd></div>
          <div><dt>Roll / Pitch</dt><dd>{number(collision.roll)} / {number(collision.pitch)} rad</dd></div>
          <div><dt>跌倒</dt><dd className={collision.isFallen ? 'collision-alert' : ''}>{collision.isFallen ? `是 · ${collision.fallReason}` : '否'}</dd></div>
          <div><dt>越界</dt><dd className={collision.isOutOfBounds ? 'collision-alert' : ''}>{collision.isOutOfBounds ? '是' : '否'}</dd></div>
          <div><dt>最近事件</dt><dd>{collisionEvent ? `${collisionEvent.kind} · ${number(collisionEvent.normalForce)} N` : '无'}</dd></div>
        </dl>
        <div className="collision-demo-actions"><button type="button" disabled={!onReset || simulation.busy || !simulation.model} onClick={onReset}>重置机器人</button><button type="button" disabled={!onClearEvent || !collisionEvent} onClick={onClearEvent}>清除最近事件</button></div>
        <section className={`locomotion-demo ${keyboard?.enabled ? 'locomotion-demo--active' : ''}`}>
          <div className="locomotion-demo__actions">
            <button type="button" disabled={!onToggleKeyboard || rosBridge.controlSource !== 'manual' || (!keyboard?.enabled && !keyboardAllowed)} onClick={onToggleKeyboard}>{keyboard?.enabled ? '解除同步键盘控制' : '启用同步键盘控制'}</button>
            <label>演示速度<select value={keyboard?.speed ?? 'low'} onChange={(event) => onSpeed?.(event.target.value as DemoSpeed)}><option value="low">低</option><option value="medium">中</option></select></label>
            <label><input type="checkbox" checked={simulation.followRobot} onChange={(event) => onFollow?.(event.target.checked)}/> 跟随机器人</label>
            {nativeMode && <button type="button" onClick={onRefreshNativeDiagnostics}>刷新 native 诊断</button>}
          </div>
          <p><b>{keyboard?.enabled ? '同步键盘控制已启用' : keyboard?.stopReason ?? '键盘控制默认未启用'}</b> · W/S 前后 · A/D 横移 · Q/E 旋转 · Space 停止 · R 重置仿真 · Esc 解除</p>
          <p>当前统一意图：vx {(keyboard?.forwardVelocity ?? 0).toFixed(2)} · vy {(keyboard?.lateralVelocity ?? 0).toFixed(2)} · yaw {(keyboard?.yawRate ?? 0).toFixed(2)}。真机在线且控制已解锁时自动同步，否则仅驱动仿真。</p>
          {!keyboardAllowed && <p className="collision-alert">仅 Go2 + running + 无故障时可启用；Minimal 不支持运动。需要 reset 清除跌倒或 fault。</p>}
          <dl className="robot-performance">
            {nativeMode && <>
              <div><dt>Native key → desired</dt><dd>{nativeDiagnostics ? latency(nativeDiagnostics.lastDesiredStateUnixMicros, nativeDiagnostics.lastKeyEventUnixMicros) : '点击刷新'}</dd></div>
              <div><dt>Native desired → send</dt><dd>{nativeDiagnostics ? latency(nativeDiagnostics.lastHeartbeatSendUnixMicros, nativeDiagnostics.lastDesiredStateUnixMicros) : '点击刷新'}</dd></div>
              <div><dt>Native key → send</dt><dd>{nativeDiagnostics ? latency(nativeDiagnostics.lastHeartbeatSendUnixMicros, nativeDiagnostics.lastKeyEventUnixMicros) : '点击刷新'}</dd></div>
              <div><dt>Native send round-trip</dt><dd>{nativeDiagnostics ? `${(nativeDiagnostics.lastSendLatencyMicros / 1000).toFixed(2)} ms` : '点击刷新'}</dd></div>
              <div><dt>Native in-flight / max</dt><dd>{nativeDiagnostics ? `${nativeDiagnostics.inFlight} / ${nativeDiagnostics.maxInFlight}` : '点击刷新'}</dd></div>
              <div><dt>Sidecar command age</dt><dd>{nativeDiagnostics ? `${nativeDiagnostics.lastSidecarCommandAgeMs} ms` : '点击刷新'}</dd></div>
            </>}
            <div><dt>控制器 / 状态</dt><dd>{locomotion ? `${locomotion.controllerId} / ${locomotion.state}` : '—'}</dd></div>
            <div><dt>动画频率 / Phase</dt><dd>{locomotion ? `${number(locomotion.gaitFrequencyHz)} Hz / ${number(locomotion.gaitPhase)}` : '—'}</dd></div>
            <div><dt>动画接触提示</dt><dd>{locomotion ? locomotion.expectedContacts.map(Number).join('') : '—'}</dd></div>
            <div><dt>Commanded</dt><dd>{locomotion ? `${number(locomotion.commandedForwardVelocity)} m/s · ${number(locomotion.commandedYawRate)} rad/s` : '—'}</dd></div>
            <div><dt>坐标积分速度</dt><dd>{locomotion ? `${number(locomotion.integratedForwardVelocity)} / ${number(locomotion.integratedLateralVelocity)} m/s · ${number(locomotion.integratedYawRate)} rad/s` : '—'}</dd></div>
            <div><dt>动力学求解</dt><dd>未启用</dd></div>
          </dl>
          <p>前后、横移与旋转均由统一意图直接驱动坐标和程序化动画，不复现实体 Go2 的底层运动控制。</p>
        </section>
      </> : <p>等待 MuJoCo 碰撞遥测</p>}
      <p className="collision-demo-warning">当前为虚拟碰撞演示，不代表实体 Go2 安全评估。</p>
    </details>
    <details className="robot-telemetry-details"><summary>仿真性能（非硬实时保证）</summary>{telemetry ? <dl className="robot-performance"><div><dt>Step / Command</dt><dd>{number(telemetry.performance.physicsFrequencyHz)} / {number(telemetry.performance.controlFrequencyHz)} Hz</dd></div><div><dt>Pose / Telemetry</dt><dd>{number(telemetry.performance.posePublishFrequencyHz)} / {number(telemetry.performance.telemetryPublishFrequencyHz)} Hz</dd></div><div><dt>Real-time factor</dt><dd>{number(telemetry.performance.realTimeFactor)}</dd></div><div><dt>Step mean/max</dt><dd>{number(telemetry.performance.physicsStepMeanMs)} / {number(telemetry.performance.physicsStepMaxMs)} ms</dd></div><div><dt>Command mean/max</dt><dd>{number(telemetry.performance.controlStepMeanMs)} / {number(telemetry.performance.controlStepMaxMs)} ms</dd></div><div><dt>Dropped pose/telemetry</dt><dd>{telemetry.performance.droppedPoseEvents} / {telemetry.performance.droppedTelemetryEvents}</dd></div></dl> : <p>暂未接入</p>}</details>
    <section className="robot-unavailable"><h4><Gauge size={13}/>虚拟运动命令</h4><p>{command ? `${command.mode} · [${number(command.forwardVelocity)}, ${number(command.lateralVelocity)}, ${number(command.yawRate)}] · ${command.timedOut ? '已超时' : '有效'} · ${command.appliedByController ? '控制器已执行' : '仅接收，未执行'} · ${command.controllerAvailability}` : '暂未发送'}</p></section>
    <section className="robot-unavailable"><h4><Cpu size={13}/>实体遥测边界</h4><p>已接入电池、IMU、足端力、12 关节与 Sport 状态摘要。CPU 温度、网络信号、相机、完整 LiDAR 数据和厂商故障语义：<b>暂未接入</b></p></section>
    <section className="robot-unavailable"><h4><RadioTower size={13}/>连接边界</h4><p>真机在线只由近期实体遥测确认；MuJoCo 与实体控制链路保持隔离。{description.description}</p></section>
  </Panel>
}

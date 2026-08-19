import { useEffect, useRef, useState } from 'react'
import { RadioTower } from 'lucide-react'
import { realRobotService, UNAVAILABLE_REAL_ROBOT, type RealMoveCommand, type RealRobotStatus } from '../services/realRobotService'
import { RealKeyboardController, type RealKeyboardState } from '../services/control/RealKeyboardController'
import { announceKeyboardControlMode, KEYBOARD_CONTROL_MODE_EVENT, type KeyboardControlMode } from '../services/control/keyboardControlMode'

const INITIAL_MOVE: RealMoveCommand = { forwardVelocity: 0.05, lateralVelocity: 0, yawRate: 0, durationMs: 500 }
const INITIAL_KEYBOARD: RealKeyboardState = { enabled: false, stopReason: '真机键盘默认未启用', forwardVelocity: 0, lateralVelocity: 0, yawRate: 0 }

export function RealRobotControls({ initialStatus }: { initialStatus?: RealRobotStatus }) {
  const [status, setStatus] = useState(initialStatus ?? UNAVAILABLE_REAL_ROBOT)
  const [move, setMove] = useState(INITIAL_MOVE)
  const [siteConfirmed, setSiteConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyboard, setKeyboard] = useState(INITIAL_KEYBOARD)
  const keyboardRef = useRef<RealKeyboardController | null>(null)
  useEffect(() => {
    const controller = new RealKeyboardController(undefined, setKeyboard)
    keyboardRef.current = controller
    const modeChanged = (event: Event) => {
      if ((event as CustomEvent<KeyboardControlMode>).detail === 'simulation' && controller.isEnabled()) controller.disable('已切换到仿真键盘控制')
    }
    window.addEventListener(KEYBOARD_CONTROL_MODE_EVENT, modeChanged)
    return () => { window.removeEventListener(KEYBOARD_CONTROL_MODE_EVENT, modeChanged); controller.dispose(); keyboardRef.current = null }
  }, [])
  useEffect(() => {
    if (initialStatus) return
    let disposed = false; let cleanup: (() => void) | null = null
    void realRobotService.status().then((next) => { if (!disposed) setStatus(next) })
    void realRobotService.subscribe((next) => { if (!disposed) setStatus(next) }).then((nextCleanup) => {
      if (disposed) nextCleanup(); else cleanup = nextCleanup
    })
    const timer = globalThis.setInterval(() => void realRobotService.status().then((next) => { if (!disposed) setStatus(next) }), 1000)
    return () => { disposed = true; globalThis.clearInterval(timer); cleanup?.() }
  }, [initialStatus])
  const run = (operation: () => Promise<RealRobotStatus>) => {
    setBusy(true); setError(null)
    void operation().then(setStatus).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }
  const field = (key: keyof RealMoveCommand, value: string) => {
    const numeric = key === 'durationMs' ? Number.parseInt(value, 10) : Number(value)
    setMove((current) => ({ ...current, [key]: Number.isFinite(numeric) ? numeric : 0 }))
  }
  const canArm = status.available && status.live && status.robotOnline && siteConfirmed && !busy
  const canAct = status.available && status.live && status.robotOnline && status.controlEnabled && !busy
  useEffect(() => {
    if ((!status.live || !status.controlEnabled) && keyboardRef.current?.isEnabled()) {
      keyboardRef.current.disable('真机状态变化，已自动停止键盘控制')
    }
  }, [status.controlEnabled, status.live])
  return <section className={`robot-unavailable real-robot-controls ${status.controlEnabled ? 'real-robot-controls--armed' : ''}`}>
    <h4><RadioTower size={13}/>Go2 实体机器人高层控制</h4>
    <dl className="robot-performance">
      <div><dt>Gateway</dt><dd>{status.state}{status.gatewayVersion ? ` · ${status.gatewayVersion}` : ''}</dd></div>
      <div><dt>运行模式</dt><dd>{status.live ? 'LIVE（可发布真机指令）' : 'DRY-RUN'}</dd></div>
      <div><dt>控制授权</dt><dd>{status.controlEnabled ? '已解锁' : '未解锁'}</dd></div>
      <div><dt>运动状态</dt><dd>{status.activeMove ? '定时运动中' : '静止/未知'}</dd></div>
      <div><dt>最近动作</dt><dd>{status.lastAction ?? '—'}</dd></div>
      <div><dt>真机在线</dt><dd>{status.robotOnline ? `是 · ${status.telemetryAgeMs ?? 0} ms` : '否（无近期遥测）'}</dd></div>
    </dl>
    {status.telemetry?.lowState && <dl className="robot-performance real-telemetry">
      <div><dt>电池</dt><dd>{status.telemetry.lowState.batterySoc}% · {status.telemetry.lowState.powerVoltage.toFixed(1)} V · {status.telemetry.lowState.powerCurrent.toFixed(1)} A</dd></div>
      <div><dt>IMU RPY</dt><dd>{status.telemetry.lowState.rpy.map((value) => value.toFixed(3)).join(' / ')}</dd></div>
      <div><dt>足端力</dt><dd>{status.telemetry.lowState.footForce.join(' / ')}</dd></div>
      <div><dt>关节遥测</dt><dd>{status.telemetry.lowState.joints.length}/12</dd></div>
    </dl>}
    {status.telemetry?.sportModeState && <dl className="robot-performance real-telemetry">
      <div><dt>Mode / Gait</dt><dd>{status.telemetry.sportModeState.mode} / {status.telemetry.sportModeState.gaitType}</dd></div>
      <div><dt>位置</dt><dd>{status.telemetry.sportModeState.position.map((value) => value.toFixed(3)).join(' / ')}</dd></div>
      <div><dt>速度 / Yaw</dt><dd>{status.telemetry.sportModeState.velocity.map((value) => value.toFixed(3)).join(' / ')} · {status.telemetry.sportModeState.yawSpeed.toFixed(3)}</dd></div>
      <div><dt>Sport error_code（原始）</dt><dd>{status.telemetry.sportModeState.errorCode} / 0x{status.telemetry.sportModeState.errorCode.toString(16).toUpperCase().padStart(8, '0')}</dd></div>
    </dl>}
    {!status.live && <p className="collision-demo-warning">当前仅为 dry-run。真机模式必须从外部环境显式启动，UI 不能自行升级为 LIVE。</p>}
    <label className="real-robot-confirm"><input type="checkbox" checked={siteConfirmed} onChange={(event) => setSiteConfirmed(event.target.checked)}/> 我已确认现场空旷、遥控器与人工急停就绪</label>
    <div className="real-robot-actions">
      <button type="button" disabled={status.controlEnabled ? busy : !canArm} onClick={() => run(() => realRobotService.setEnabled(!status.controlEnabled))}>{status.controlEnabled ? '立即锁定控制' : '解锁真机控制'}</button>
      <button className="real-stop" type="button" disabled={!status.available || !status.live || busy} onClick={() => run(realRobotService.stop)}>STOP MOVE</button>
      <button type="button" disabled={!canAct} onClick={() => run(realRobotService.standUp)}>站起</button>
      <button type="button" disabled={!canAct} onClick={() => run(realRobotService.standDown)}>趴下</button>
      <button type="button" disabled={!status.available || !status.live || busy || status.activeMove} onClick={() => run(() => realRobotService.setLidar(true))}>LiDAR ON</button>
      <button type="button" disabled={!status.available || !status.live || busy || status.activeMove} onClick={() => run(() => realRobotService.setLidar(false))}>LiDAR OFF</button>
    </div>
    <div className="real-move-fields">
      <label>vx m/s<input type="number" min="-0.3" max="0.3" step="0.01" value={move.forwardVelocity} onChange={(event) => field('forwardVelocity', event.target.value)}/></label>
      <label>vy m/s<input type="number" min="-0.3" max="0.3" step="0.01" value={move.lateralVelocity} onChange={(event) => field('lateralVelocity', event.target.value)}/></label>
      <label>yaw rad/s<input type="number" min="-0.5" max="0.5" step="0.05" value={move.yawRate} onChange={(event) => field('yawRate', event.target.value)}/></label>
      <label>时长 ms<input type="number" min="1" max="3000" step="100" value={move.durationMs} onChange={(event) => field('durationMs', event.target.value)}/></label>
    </div>
    <button className="real-move-once" type="button" disabled={!canAct || status.activeMove} onClick={() => run(() => realRobotService.moveOnce(move))}>执行一次定时 Move</button>
    <div className={`real-keyboard ${keyboard.enabled ? 'real-keyboard--active' : ''}`}>
      <div className="real-keyboard-actions">
        <button type="button" disabled={!keyboard.enabled && !canAct} onClick={() => {
          const controller = keyboardRef.current; if (!controller) return
          if (controller.isEnabled()) controller.disable()
          else { announceKeyboardControlMode('real'); controller.enable() }
        }}>{keyboard.enabled ? '解除真机键盘' : '启用真机键盘'}</button>
      </div>
      <p><b>{keyboard.enabled ? '真机键盘已启用' : keyboard.stopReason ?? '真机键盘默认未启用'}</b></p>
      <p>W/S 前后 · A/D 横移 · Q/E 旋转 · Space 停止 · Esc 停止并解除。输入框聚焦时不响应。</p>
      <p>速度与 go2_wasd_control.py 一致：vx/vy ±0.30 m/s · yaw ±0.50 rad/s。</p>
      <p>当前意图：vx {keyboard.forwardVelocity.toFixed(2)} · vy {keyboard.lateralVelocity.toFixed(2)} · yaw {keyboard.yawRate.toFixed(2)}</p>
      <p>按键状态保持到组合变化或松开；保持期间每 250 ms 刷新一次高层 Move。窗口失焦、锁定控制或模式切换都会 StopMove。</p>
    </div>
    <p>键盘组合变化时立即发送 API 1008，保持期间周期刷新；松开全部运动键或 STOP 后发送三次 API 1003。定时 Move 仍保持有界时长。</p>
    <p>Sport error_code 当前仅作原始观测，尚未映射厂商故障语义，也不参与控制授权或运动判定。</p>
    {(error ?? status.error) && <p className="collision-alert">真机网关：{error ?? status.error}</p>}
  </section>
}

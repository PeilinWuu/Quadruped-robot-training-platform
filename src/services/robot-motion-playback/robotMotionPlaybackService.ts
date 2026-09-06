import type { RobotPose } from '../simulation/types'
import type { RobotMotionPoseListener, RobotMotionState, RobotMotionStateListener } from './types'
import { groundCollisionService } from './groundCollisionService'

const JOINTS = ['FL_hip_joint','FL_thigh_joint','FL_calf_joint','FR_hip_joint','FR_thigh_joint','FR_calf_joint','RL_hip_joint','RL_thigh_joint','RL_calf_joint','RR_hip_joint','RR_thigh_joint','RR_calf_joint'] as const
const FRAME_COUNT = 120; const GAIT_HZ = 1.8; const ROOT_Y = .30
const HOME = [0, .72, -1.45]; const V_FORWARD = .30; const V_LATERAL = .30; const V_YAW = .50
const lateral = (state: RobotMotionState) => state.lateralInput
function editable(target: EventTarget | null): boolean { return target instanceof HTMLElement && (target.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(target.tagName)) }

export class RobotMotionPlaybackService {
  private elapsed = 0; private sequence = 0; private x = 0; private y = 0; private yaw = 0; private phase = 0
  private keys = new Set<string>()
  private state: RobotMotionState = { phase:'idle', clipId:'go2-kinematic-animation-v1', displayName:'Go2 程序化对角步态', frameIndex:0, frameCount:FRAME_COUNT, playing:false, speed:1, keyboardEnabled:false, forwardInput:0, lateralInput:0, turnInput:0, error:null }
  private states = new Set<RobotMotionStateListener>(); private poses = new Set<RobotMotionPoseListener>()
  getState(): RobotMotionState { return { ...this.state } }
  subscribe(listener: RobotMotionStateListener): () => void { this.states.add(listener); listener(this.getState()); return () => this.states.delete(listener) }
  onPose(listener: RobotMotionPoseListener): () => void { this.poses.add(listener); listener(this.pose()); return () => this.poses.delete(listener) }
  async load(_baseUrl?: string): Promise<void> {
    this.patch({ phase:'loading', playing:false, error:null })
    try { await groundCollisionService.load() } catch { /* ground proxy is optional; keep the fixed calibrated fallback */ }
    this.resetTransform(); this.patch({ phase:'ready', frameIndex:0, frameCount:FRAME_COUNT }); this.emit()
  }
  play(): void { this.patch({ phase:'playing', playing:true }) }
  pause(): void { this.clearInput(); this.patch({ phase:'paused', playing:false }); this.emit() }
  reset(): void { this.resetTransform(); this.clearInput(); this.patch({ phase:'ready', playing:false, frameIndex:0 }); this.emit() }
  setSpeed(speed: number): void { if ([.25,.5,1,2].includes(speed)) this.patch({ speed }) }
  setKeyboardEnabled(enabled: boolean): void {
    if (enabled === this.state.keyboardEnabled) return; this.keys.clear(); this.patch({ keyboardEnabled:enabled, forwardInput:0, turnInput:0, lateralInput:0 } as Partial<RobotMotionState>)
    if (typeof window === 'undefined') return
    if (enabled) { window.addEventListener('keydown', this.keyDown); window.addEventListener('keyup', this.keyUp); window.addEventListener('blur', this.blur) }
    else { window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp); window.removeEventListener('blur', this.blur) }
  }
  setControlInput(forward: -1|0|1, side: -1|0|1, turn: -1|0|1 = 0): void { this.patch({ forwardInput:forward, lateralInput:side, turnInput:turn }) }
  update(seconds: number): void {
    if (!this.state.playing || !Number.isFinite(seconds) || seconds <= 0) return; const dt = Math.min(seconds,.1) * this.state.speed; const side = lateral(this.state)
    this.yaw += this.state.turnInput * V_YAW * dt; const wx = Math.cos(this.yaw)*this.state.forwardInput*V_FORWARD - Math.sin(this.yaw)*side*V_LATERAL; const wy = Math.sin(this.yaw)*this.state.forwardInput*V_FORWARD + Math.cos(this.yaw)*side*V_LATERAL; this.x += wx*dt; this.y += wy*dt
    if (this.state.forwardInput || side || this.state.turnInput) this.phase = (this.phase + dt*GAIT_HZ*Math.PI*2) % (Math.PI*2); else this.phase = 0
    this.elapsed += dt; const index = Math.floor(this.phase/(Math.PI*2)*FRAME_COUNT)%FRAME_COUNT; if (index !== this.state.frameIndex) this.patch({ frameIndex:index }); this.emit()
  }
  private pose(): RobotPose {
    const side = lateral(this.state); const moving = this.state.forwardInput !== 0 || side !== 0 || this.state.turnInput !== 0; const joints = JOINTS.map((name,index) => { const leg=Math.floor(index/3); const joint=index%3; const p=(leg===0||leg===3)?this.phase:this.phase+Math.PI; if(!moving) return {name,position:HOME[joint]}; const s=Math.sin(p); const ss=leg%2===0?-1:1; if(joint===0) return {name,position:HOME[0]+.035*Math.cos(p)+ss*.025*side}; if(joint===1) return {name,position:HOME[1]+.18*s-.08*this.state.turnInput*(leg<2?1:-1)}; return {name,position:HOME[2]-.28*Math.max(0,s)+.08*Math.min(0,s)} })
    const sampledGround = groundCollisionService.sample(this.x, -this.y)
    const rootY = sampledGround === null ? ROOT_Y : sampledGround + ROOT_Y
    return { sequence:++this.sequence, simulationTime:this.elapsed, wallTime:(typeof performance==='undefined'?Date.now():performance.now())/1000, rootPosition:[this.x,rootY,-this.y], rootOrientation:[0,Math.sin(this.yaw/2),0,Math.cos(this.yaw/2)], joints }
  }
  private keyDown = (event: KeyboardEvent) => { if(!this.state.keyboardEnabled||editable(event.target)) return; const key=event.key.toLowerCase(); if(!['w','a','s','d','q','e',' '].includes(key)) return; event.preventDefault(); if(key===' '){this.keys.clear();this.updateKeys();return} this.keys.add(key);this.updateKeys() }
  private keyUp = (event: KeyboardEvent) => { const key=event.key.toLowerCase(); if(['w','a','s','d','q','e'].includes(key)){this.keys.delete(key);this.updateKeys()} }
  private blur = () => { this.keys.clear(); this.updateKeys() }
  private updateKeys(): void { const f=Number(this.keys.has('w'))-Number(this.keys.has('s')); const s=Number(this.keys.has('a'))-Number(this.keys.has('d')); const t=Number(this.keys.has('q'))-Number(this.keys.has('e')); this.setControlInput(Math.sign(f) as -1|0|1,Math.sign(s) as -1|0|1,Math.sign(t) as -1|0|1) }
  private clearInput(): void { this.keys.clear(); this.patch({forwardInput:0,lateralInput:0,turnInput:0}) }
  private resetTransform(): void { this.elapsed=0;this.x=0;this.y=0;this.yaw=0;this.phase=0 }
  private emit(): void { const pose=this.pose(); for(const listener of this.poses) listener(pose) }
  private patch(value: Partial<RobotMotionState>): void { this.state={...this.state,...value}; const snapshot=this.getState(); for(const listener of this.states) listener(snapshot) }
}
export const robotMotionPlaybackService = new RobotMotionPlaybackService()

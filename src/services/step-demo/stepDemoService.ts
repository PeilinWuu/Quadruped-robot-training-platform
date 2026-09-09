import { solveStepStance } from './stepMath'
import type { StepPose } from './stepMath'
export const stepDemoService={
  enabled:false,showProxy:true,mode:'straddle' as StepPose,edge:-.54,lower:0,rise:.15,
  listeners:new Set<()=>void>(),
  subscribe(listener:()=>void) {this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}},
  notify() {for(const listener of this.listeners)listener()},
  setEnabled(value:boolean) {this.enabled=value;this.notify()},
  setMode(mode:StepPose) {this.mode=mode;this.notify()},
  setRise(value:number) {if(Number.isFinite(value)){this.rise=Math.max(.08,Math.min(.22,value));this.notify()}},
  setEdge(value:number) {if(Number.isFinite(value)){this.edge=Math.max(-.64,Math.min(-.44,value));this.notify()}},
  setLower(value:number) {if(Number.isFinite(value)){this.lower=Math.max(-.03,Math.min(.03,value));this.notify()}},
  setProxy(value:boolean) {this.showProxy=value;this.notify()},
  solve() {return solveStepStance(this)},
}

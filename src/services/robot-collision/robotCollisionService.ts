import boxes from './officeCollision.json'
import { sweepAndSlide, constrainRotation } from './collisionMath'
import type { Footprint, Point2 } from './collisionMath'
export const robotCollisionService = {
  boxes, enabled:true, debug:false, sceneAvailable:false, blocked:null as string|null,
  listeners:new Set<()=>void>(),
  subscribe(listener:()=>void) {this.listeners.add(listener);return ()=>{this.listeners.delete(listener)}},
  notify() {for(const listener of this.listeners) listener()},
  setEnabled(enabled:boolean) {this.enabled=enabled;this.blocked=null;this.notify()},
  setDebug(debug:boolean) {this.debug=debug;this.notify()},
  setScene(available:boolean) {this.sceneAvailable=available;this.blocked=null;this.notify()},
  turn(position:Point2,half:Point2,start:number,end:number,bottom:number,top:number) {
    const result=this.enabled&&this.sceneAvailable?constrainRotation(position,half,start,end,bottom,top,this.boxes):{yaw:end,blocked:null}
    if(result.blocked!==this.blocked) {this.blocked=result.blocked;this.notify()}
    return result.yaw
  },
  resolve(start:[number,number],end:[number,number],foot:Footprint,bottom:number,top:number) {
    const result=this.enabled&&this.sceneAvailable?sweepAndSlide(start,end,foot,bottom,top,this.boxes):{position:end,blocked:null}
    if(result.blocked!==this.blocked) {this.blocked=result.blocked;this.notify()}
    return result.position
  },
}

export interface ObstacleBox { id:string; label:string; center:number[]; half:number[]; bottom:number; top:number; yaw:number }
export type Point2 = [number,number]
export interface Footprint { half:Point2; yaw:number }
export const ROBOT_HALF_SIZE:Point2=[.38,.18]
const axes=(yaw:number):Point2[]=>[[Math.cos(yaw),Math.sin(yaw)],[-Math.sin(yaw),Math.cos(yaw)]]
const dot=(a:number[],b:number[])=>a[0]*b[0]+a[1]*b[1]
function projections(start:Point2,box:ObstacleBox,foot:Footprint) {
  const robotAxes=axes(foot.yaw), boxAxes=axes(box.yaw)
  const relative=[start[0]-box.center[0],start[1]-box.center[1]]
  return [...boxAxes,...robotAxes].map(axis=>({axis,p:dot(relative,axis),h:
    foot.half[0]*Math.abs(dot(robotAxes[0],axis))+foot.half[1]*Math.abs(dot(robotAxes[1],axis))+
    box.half[0]*Math.abs(dot(boxAxes[0],axis))+box.half[1]*Math.abs(dot(boxAxes[1],axis))}))
}
export function overlapDepth(start:Point2,box:ObstacleBox,foot:Footprint):number {
  return Math.min(...projections(start,box,foot).map(({p,h})=>h-Math.abs(p)))
}
// Continuous SAT on both rectangles' axes: exact for fixed-heading translation.
function hitBox(start:Point2,delta:Point2,box:ObstacleBox,foot:Footprint) {
  const intervals=projections(start,box,foot)
  if(intervals.every(({p,h})=>Math.abs(p)<h-1e-9)) {
    const nearest=intervals.reduce((a,b)=>a.h-Math.abs(a.p)<b.h-Math.abs(b.p)?a:b)
    const sign=nearest.p<0?-1:1,normal=nearest.axis.map(v=>v*sign)
    if(dot(delta,normal)>0) return null
    return {time:0,normal}
  }
  let enter=-Infinity,exit=Infinity,normal:number[]=[0,0]
  for(const {axis,p,h} of intervals) {
    const velocity=dot(delta,axis)
    if(Math.abs(velocity)<1e-10) {if(Math.abs(p)>=h-1e-9) return null;continue}
    const a=(-h-p)/velocity,b=(h-p)/velocity
    if(Math.min(a,b)>enter) {enter=Math.min(a,b);normal=axis.map(v=>v*(velocity>0?-1:1))}
    exit=Math.min(exit,Math.max(a,b))
  }
  if(enter>exit||exit<0||enter<0||enter>1) return null
  return {time:enter,normal}
}
export function sweepAndSlide(start:Point2,end:Point2,foot:Footprint|number,bottom:number,top:number,boxes:readonly ObstacleBox[]) {
  const shape:Footprint=typeof foot==='number'?{half:[foot,foot],yaw:0}:foot
  const position:Point2=[...start];let delta:Point2=[end[0]-start[0],end[1]-start[1]],blocked:string|null=null
  for(let iteration=0;iteration<4;iteration++) {
    let nearest:ReturnType<typeof hitBox>=null
    for(const box of boxes) {
      if(top<=box.bottom||bottom>=box.top) continue
      const hit=hitBox(position,delta,box,shape)
      if(hit&&(!nearest||hit.time<nearest.time)) {nearest=hit;blocked=box.label}
    }
    if(!nearest) {position[0]+=delta[0];position[1]+=delta[1];break}
    const time=Math.max(0,nearest.time-.001/Math.max(Math.hypot(...delta),.001))
    position[0]+=delta[0]*time;position[1]+=delta[1]*time
    delta=[delta[0]*(1-time),delta[1]*(1-time)]
    const normalSpeed=dot(delta,nearest.normal)
    if(normalSpeed<0) {delta[0]-=normalSpeed*nearest.normal[0];delta[1]-=normalSpeed*nearest.normal[1]}
    if(Math.hypot(...delta)<1e-8) break
  }
  return {position,blocked}
}
// Small angular intervals use an expanded midpoint rectangle enclosing the
// entire angular sweep, so even a thin wall cannot be skipped by a corner.
export function constrainRotation(position:Point2,half:Point2,start:number,end:number,bottom:number,top:number,boxes:readonly ObstacleBox[]) {
  const steps=Math.max(1,Math.ceil(Math.abs(end-start)/.01)),delta=(end-start)/steps
  let yaw=start,blocked:string|null=null
  for(let i=0;i<steps;i++) {
    const next=yaw+delta,margin=Math.hypot(...half)*Math.abs(delta)/2
    for(const box of boxes) {
      if(top<=box.bottom||bottom>=box.top) continue
      const before=overlapDepth(position,box,{half,yaw})
      const after=overlapDepth(position,box,{half,yaw:next})
      const swept=overlapDepth(position,box,{half:[half[0]+margin,half[1]+margin],yaw:(yaw+next)/2})
      if(swept>1e-8 && !(before>0 && after<before-1e-8)) {blocked=box.label;return {yaw,blocked}}
    }
    yaw=next
  }
  return {yaw,blocked}
}

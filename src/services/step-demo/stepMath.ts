export type V3=[number,number,number]
export type StepPose='lower'|'straddle'|'upper'
export interface StepSettings { edge:number; lower:number; rise:number; mode:StepPose }
export const STEP_X=3.5, FOOT_RADIUS=.022, LINK=.213
export const LEG_NAMES=['FL','FR','RL','RR'] as const
export const rotateYaw=(v:V3,a:number):V3=>[Math.cos(a)*v[0]+Math.sin(a)*v[2],v[1],-Math.sin(a)*v[0]+Math.cos(a)*v[2]]
export const rotatePitch=(v:V3,a:number):V3=>[Math.cos(a)*v[0]-Math.sin(a)*v[1],Math.sin(a)*v[0]+Math.cos(a)*v[1],v[2]]
const rotateHip=(v:V3,a:number):V3=>[v[0],Math.cos(a)*v[1]-Math.sin(a)*v[2],Math.sin(a)*v[1]+Math.cos(a)*v[2]]
export function stepHeight(x:number,z:number,s:StepSettings):number|null {
  if(x<3.05||x>3.95||z<s.edge-.9||z>s.edge+.8) return null
  return s.lower+(z<s.edge?s.rise:0)
}
export function footForward(leg:number,joints:V3):V3 {
  const [a,b,c]=joints, hipX=leg<2?.1934:-.1934, side=leg%2===0?-1:1
  const v=rotateHip([-LINK*Math.sin(b)-LINK*Math.sin(b+c),-LINK*Math.cos(b)-LINK*Math.cos(b+c),side*.0955],a)
  return [v[0]+hipX,v[1],v[2]+side*.0465]
}
export function solveLeg(leg:number,target:V3):V3 {
  const side=leg%2===0?-1:1,x=target[0]-(leg<2?.1934:-.1934),y=target[1],z=target[2]-side*.0465
  const lateral=side*.0955, down=-Math.sqrt(Math.max(1e-8,y*y+z*z-lateral*lateral))
  let hip=Math.atan2(z,y)-Math.atan2(lateral,down)
  hip=Math.atan2(Math.sin(hip),Math.cos(hip))
  const cosine=Math.max(-1,Math.min(1,(x*x+down*down-2*LINK*LINK)/(2*LINK*LINK)))
  const calf=-Math.acos(cosine)
  const thigh=Math.atan2(-x,-down)-Math.atan2(LINK*Math.sin(calf),LINK+LINK*Math.cos(calf))
  return [hip,thigh,calf]
}
export function solveStepStance(s:StepSettings) {
  const yaw=Math.PI/2, z=s.edge+(s.mode==='lower'?.3:s.mode==='upper'?-.3:0)
  const targets:V3[]=LEG_NAMES.map((_,leg)=>{
    const offset=rotateYaw([leg<2?.1934:-.1934,0,leg%2===0?-.142:.142],yaw)
    const x=STEP_X+offset[0],fz=z+offset[2]
    return [x,stepHeight(x,fz,s)!+FOOT_RADIUS,fz]
  })
  const front=(targets[0][1]+targets[1][1])/2,back=(targets[2][1]+targets[3][1])/2
  const pitch=Math.max(-.25,Math.min(.25,Math.atan2(front-back,.3868)))
  const root:V3=[STEP_X,(front+back)/2+.32,z]
  const joints:V3[]=targets.map((target,leg)=>solveLeg(leg,rotatePitch(rotateYaw([target[0]-root[0],target[1]-root[1],target[2]-root[2]],-yaw),-pitch)))
  const achieved=joints.map((angles,leg)=>{
    const v=rotateYaw(rotatePitch(footForward(leg,angles),pitch),yaw)
    return [v[0]+root[0],v[1]+root[1],v[2]+root[2]] as V3
  })
  const maxError=Math.max(...achieved.map((v,i)=>Math.hypot(...v.map((n,k)=>n-targets[i][k]))))
  // Quaternion multiplication: yaw around Y followed by local pitch around Z.
  const sy=Math.sin(yaw/2),cy=Math.cos(yaw/2),sp=Math.sin(pitch/2),cp=Math.cos(pitch/2)
  const orientation:[number,number,number,number]=[sy*sp,sy*cp,cy*sp,cy*cp]
  return {root,orientation,joints,targets,achieved,maxError,pitch}
}

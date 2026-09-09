import { Color, Mat4, Vec3 } from 'playcanvas'
import type { Application, Entity } from 'playcanvas'
import { robotCollisionService as collision } from '../../../services/robot-collision/robotCollisionService'
import { ROBOT_HALF_SIZE } from '../../../services/robot-collision/collisionMath'

export function constrainRobotMovement(alignment:Entity,start:[number,number,number],end:[number,number,number],yaw:number):[number,number,number] {
  // Obstacles and the robot's alignment parent share the scene orientation.
  // Work in that common scene frame, then invert the robot-only calibration.
  const matrix=alignment.getLocalTransform(), inverse=new Mat4().copy(matrix).invert()
  const a=matrix.transformPoint(new Vec3(...start)), b=matrix.transformPoint(new Vec3(...end))
  const scale=matrix.getScale().x
  const up=matrix.transformVector(Vec3.UP).normalize()
  const vertical=Math.abs(up.y)>.99?.30:.43
  const direction=matrix.transformVector(new Vec3(Math.cos(yaw),0,-Math.sin(yaw)))
  const result=collision.resolve([a.x,a.z],[b.x,b.z],{half:[ROBOT_HALF_SIZE[0]*scale,ROBOT_HALF_SIZE[1]*scale],yaw:Math.atan2(direction.z,direction.x)},a.y-vertical*scale,a.y+.25*scale)
  const resolved=inverse.transformPoint(new Vec3(result[0],b.y,result[1]))
  return [resolved.x,resolved.y,resolved.z]
}

export function constrainRobotTurn(alignment:Entity,position:[number,number,number],start:number,end:number):number {
  if(Math.abs(end-start)<1e-10) return end
  const matrix=alignment.getLocalTransform(),center=matrix.transformPoint(new Vec3(...position)),scale=matrix.getScale().x
  const forward=matrix.transformVector(new Vec3(Math.cos(start),0,-Math.sin(start)))
  const yaw=Math.atan2(forward.z,forward.x)
  const allowed=collision.turn([center.x,center.z],[ROBOT_HALF_SIZE[0]*scale,ROBOT_HALF_SIZE[1]*scale],yaw,yaw-(end-start),center.y-.30*scale,center.y+.25*scale)
  return start-(allowed-yaw)
}

export function drawCollisionOverlay(app:Application,scene:Entity,alignment:Entity,robotPosition:Vec3|null,heading:number) {
  if(!collision.debug||!collision.sceneAvailable) return
  const transform=scene.getWorldTransform(), color=new Color(0,1,.8)
  for(const box of collision.boxes) {
    const c=Math.cos(box.yaw),s=Math.sin(box.yaw), points:Vec3[]=[]
    for(const y of [box.bottom,box.top]) for(const [u,v] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
      const x=u*box.half[0], z=v*box.half[1]
      points.push(transform.transformPoint(new Vec3(box.center[0]+c*x-s*z,y,box.center[1]+s*x+c*z)))
    }
    const tint=collision.blocked===box.label?new Color(1,.25,.1):color
    for(let i=0;i<4;i++) {app.drawLine(points[i],points[(i+1)%4],tint,false);app.drawLine(points[i+4],points[(i+1)%4+4],tint,false);app.drawLine(points[i],points[i+4],tint,false)}
  }
  if(robotPosition) {
    const scale=alignment.getLocalScale().x,c=Math.cos(heading),s=Math.sin(heading)
    const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([u,v])=> {
      const x=u*ROBOT_HALF_SIZE[0]*scale,z=v*ROBOT_HALF_SIZE[1]*scale
      return transform.transformPoint(new Vec3(robotPosition.x+c*x-s*z,robotPosition.y-.28*scale,robotPosition.z+s*x+c*z))
    })
    for(let i=0;i<4;i++) app.drawLine(corners[i],corners[(i+1)%4],new Color(1,1,0),false)
  }
}

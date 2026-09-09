import { Color, Vec3 } from 'playcanvas'
import type { Application, Entity } from 'playcanvas'
import { stepDemoService as demo } from '../../../services/step-demo/stepDemoService'
import { robotMotionPlaybackService as motion } from '../../../services/robot-motion-playback/robotMotionPlaybackService'
import { robotCollisionService as collision } from '../../../services/robot-collision/robotCollisionService'
import type { RobotOverlayRuntime, RobotOverlayCalibration } from './RobotOverlayRuntime'

export class StepDemoRuntime {
  private saved:{calibration:RobotOverlayCalibration;playing:boolean;keyboard:boolean}|null=null
  private remove:()=>void
  private app:Application
  private robot:RobotOverlayRuntime
  private focus:()=>void
  get active() {return this.saved!==null}
  constructor(app:Application,robot:RobotOverlayRuntime,focus:()=>void) {
    this.app=app;this.robot=robot;this.focus=focus
    this.remove=demo.subscribe(()=>this.sync())
  }
  private sync() {
    if(demo.enabled && collision.sceneAvailable) {
      if(!this.saved) {
        const a=this.robot.alignmentRoot,p=a.getLocalPosition(),q=a.getLocalRotation(),s=a.getLocalScale()
        const state=motion.getState()
        this.saved={calibration:{translation:[p.x,p.y,p.z],rotation:[q.x,q.y,q.z,q.w],scale:s.x},playing:state.playing,keyboard:state.keyboardEnabled}
        motion.pause();motion.setKeyboardEnabled(false)
        this.robot.clearPose()
        this.robot.setCalibration({translation:[0,0,0],rotation:[0,0,0,1],scale:1})
        motion.setPoseOverride(pose=> {
          const solution=demo.solve()
          return {...pose,rootPosition:solution.root,rootOrientation:solution.orientation,
            joints:pose.joints.map((joint,i)=>({...joint,position:solution.joints[Math.floor(i/3)][i%3]}))}
        })
        this.focus()
      }
      motion.refreshPose()
    } else this.restore()
  }
  private restore() {
    if(!this.saved)return
    const saved=this.saved;this.saved=null
    this.robot.setCalibration(saved.calibration)
    this.robot.clearPose()
    motion.setPoseOverride(null)
    motion.setKeyboardEnabled(saved.keyboard)
    if(saved.playing)motion.play();else motion.pause()
  }
  clear() {if(demo.enabled)demo.setEnabled(false);else this.restore()}
  dispose() {this.clear();this.remove()}
  draw(scene:Entity) {
    if(!demo.enabled||!demo.showProxy||!this.saved)return
    const transform=scene.getWorldTransform(),blue=new Color(.1,.8,1),orange=new Color(1,.6,.1),green=new Color(.2,1,.3)
    const line=(a:number[],b:number[],color:Color)=>this.app.drawLine(transform.transformPoint(new Vec3(...a)),transform.transformPoint(new Vec3(...b)),color,false)
    for(const [z0,z1,height,color] of [[demo.edge,demo.edge+.8,demo.lower,blue],[demo.edge-.9,demo.edge,demo.lower+demo.rise,orange]] as const) {
      for(let i=0;i<=6;i++) {const x=3.05+i*.15;line([x,height,z0],[x,height,z1],color)}
      for(let i=0;i<=4;i++) {const z=z0+(z1-z0)*i/4;line([3.05,height,z],[3.95,height,z],color)}
    }
    for(const x of [3.05,3.95])line([x,demo.lower,demo.edge],[x,demo.lower+demo.rise,demo.edge],orange)
    const solution=demo.solve()
    for(const [x,y,z] of solution.achieved) {
      for(let i=0;i<16;i++) {const a=i*Math.PI/8,b=(i+1)*Math.PI/8;line([x+.025*Math.cos(a),y-.022,z+.025*Math.sin(a)],[x+.025*Math.cos(b),y-.022,z+.025*Math.sin(b)],green)}
      line([x,y-.022,z],[x,y+.055,z],green)
    }
  }
}

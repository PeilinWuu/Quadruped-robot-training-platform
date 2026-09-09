// Browser QA fixture: test-only camera/robot placement; no production controller changes.
import { PlayCanvasGsRuntime } from '/src/features/gaussian-viewer/renderer/PlayCanvasGsRuntime'
import { firePlaybackService as fire } from '/src/services/fire-playback/firePlaybackService'
import { robotMotionPlaybackService as robot } from '/src/services/robot-motion-playback/robotMotionPlaybackService'
const canvas = document.querySelector('canvas')!
const runtime = new PlayCanvasGsRuntime({ canvas, onStatusChange: (s) => { window.statusData = s } })
runtime.resize(1280,720,1); runtime.start()
window.runtime = runtime; window.fire = fire; window.robot = robot
await runtime.loadScene({kind:'dev-public-url',url:'/gs/local/v2-qa.sog',displayName:'office_01'})
await robot.load(); robot.setKeyboardEnabled(true); robot.play()
window.nativeCamera = () => {
  runtime.setRobotFirstPerson(false)
  const c=runtime.cameraEntity
  c.setPosition(5.7338507312,1.2,3.3937656); c.lookAt(2.9188926,.612,3.3937656)
  c.camera.fov=60
}
window.nativeCamera()
fire.autoQuality=false
window.ready = true

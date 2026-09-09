import { useEffect, useState } from 'react'
import { stepDemoService as demo } from '../services/step-demo/stepDemoService'
import { robotCollisionService as collision } from '../services/robot-collision/robotCollisionService'
import { useAppStore } from '../store/useAppStore'
export function StepDemoControls() {
  const [,refresh]=useState(0)
  useEffect(()=> {
    const update=()=>refresh(n=>n+1),a=demo.subscribe(update),b=collision.subscribe(update)
    return ()=>{a();b()}
  },[])
  return <div className="fire-playback-controls step-demo-controls" role="toolbar" aria-label="局部台阶样例">
    <strong>台阶贴地</strong>
    <button disabled={!collision.sceneAvailable} onClick={()=>{if(!demo.enabled)useAppStore.getState().setRobotFirstPerson(false);demo.setEnabled(!demo.enabled)}}>{demo.enabled?'退出站立样例':'查看台阶样例'}</button>
    {demo.enabled&&<>
      {(['lower','straddle','upper'] as const).map((mode,i)=><button key={mode} className={demo.mode===mode?'active':''} onClick={()=>demo.setMode(mode)}>{['台阶下','跨台阶','台阶上'][i]}</button>)}
      <label><input type="checkbox" checked={demo.showProxy} onChange={e=>demo.setProxy(e.target.checked)}/>接触面</label>
      <label>台阶高 <input aria-label="台阶高度厘米" type="number" min={8} max={22} step={.5} value={Math.round(demo.rise*1000)/10} onChange={e=>demo.setRise(e.currentTarget.valueAsNumber/100)}/> cm</label>
      <label>边缘 Z <input aria-label="台阶边缘坐标" type="number" min={-.64} max={-.44} step={.005} value={demo.edge} onChange={e=>demo.setEdge(e.currentTarget.valueAsNumber)}/> m</label>
      <label>地面高 <input aria-label="局部地面高度厘米" type="number" min={-3} max={3} step={.5} value={Math.round(demo.lower*1000)/10} onChange={e=>demo.setLower(e.currentTarget.valueAsNumber/100)}/> cm</label>
      <small>卡座入口 · 四足站立贴地 · 尚未接入跨阶行走</small>
    </>}
  </div>
}

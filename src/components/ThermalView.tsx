import { useEffect, useRef, useState } from 'react'
import { thermalPreview } from '../features/gaussian-viewer/thermal/thermalPreview'
import { thermalColor } from '../features/gaussian-viewer/thermal/thermalMath'

export function ThermalView() {
  const canvas=useRef<HTMLCanvasElement>(null)
  const [palette,setPalette]=useState<'iron'|'white'|'black'>('iron')
  const [label,setLabel]=useState('等待 GS 场景和温度数据')
  const [heat,setHeat]=useState('')
  useEffect(()=> {
    const draw=()=> {
      const node=canvas.current, frame=thermalPreview.frame
      if(!node) return
      const context=node.getContext('2d')!
      if(!frame) {context.clearRect(0,0,node.width,node.height);setLabel(thermalPreview.error??'等待 GS 场景和温度数据');return}
      node.width=frame.width;node.height=frame.height
      const pixels=context.createImageData(frame.width,frame.height)
      for(let i=0;i<frame.values.length;i++) {
        const color=frame.valid[i]?thermalColor(frame.values[i],palette):[25,32,38]
        pixels.data.set([...color,255],i*4)
      }
      context.putImageData(pixels,0,0)
      setLabel(`${thermalPreview.cameraMode} · ${frame.width}×${frame.height} · ${thermalPreview.tracks} 处热源`)
    }
    draw();return thermalPreview.subscribe(draw)
  },[palette])
  return <div className="gs-depth-view thermal-view">
    <div className="thermal-image"><canvas ref={canvas} aria-label="仿真相对热像图" onPointerMove={e=> {
      const frame=thermalPreview.frame;if(!frame)return
      const r=e.currentTarget.getBoundingClientRect()
      const scale=Math.min(r.width/frame.width,r.height/frame.height)
      const px=e.clientX-r.left-(r.width-frame.width*scale)/2
      const py=e.clientY-r.top-(r.height-frame.height*scale)/2
      if(px<0||py<0||px>=frame.width*scale||py>=frame.height*scale) {setHeat('');return}
      const x=Math.floor(px/scale), y=Math.floor(py/scale)
      const i=y*frame.width+x;setHeat(frame.valid[i]?`相对热度 ${frame.values[i].toFixed(2)}`:'无有效 GS 深度')
    }}/></div>
    <label className="gs-depth-threshold">色带 <select aria-label="热像色带" value={palette} onChange={e=>setPalette(e.target.value as typeof palette)}>
      <option value="iron">铁红</option><option value="white">白热</option><option value="black">黑热</option>
    </select> 固定范围 0–1</label>
    <div className={`thermal-legend ${palette}`} aria-label="固定相对热度色标"><span>冷 0</span><span>热 1</span></div>
    <small>{label}<br/>仿真展示 · 非摄氏度 · 环境基线 0.08<br/>{heat || '灰蓝区域：深度未知'}</small>
  </div>
}

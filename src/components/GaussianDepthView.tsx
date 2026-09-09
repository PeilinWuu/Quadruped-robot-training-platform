import { useEffect, useRef, useState } from 'react'
import { gsDepthPreview } from '../features/gaussian-viewer/depth/gsDepthPreview'

export function GaussianDepthView() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [label, setLabel] = useState('等待实时 GS 深度')
  const [distance, setDistance] = useState('')
  const [clip, setClip] = useState(gsDepthPreview.alphaClip)
  useEffect(() => {
    const render = () => {
      const node = canvas.current, frame = gsDepthPreview.frame
      if (!node) return
      if (!frame) { node.getContext('2d')?.clearRect(0, 0, node.width, node.height); setLabel(gsDepthPreview.error ?? '请加载 GS 场景'); return }
      node.width = frame.width; node.height = frame.height
      const context = node.getContext('2d')!
      const pixels = context.createImageData(frame.width, frame.height)
      let valid = 0
      for (let i = 0; i < frame.values.length; i++) {
        const d = frame.values[i], j = i * 4
        const value = d > 0 ? Math.round(255 * (1 - Math.min(d / 6, 1))) : 0
        pixels.data[j] = value; pixels.data[j + 1] = value; pixels.data[j + 2] = value; pixels.data[j + 3] = 255
        if (d > 0) valid++
      }
      context.putImageData(pixels, 0, 0)
      setLabel(`${gsDepthPreview.cameraMode} · ${frame.width}×${frame.height} · 有效 ${(100 * valid / frame.values.length).toFixed(0)}%`)
    }
    render(); return gsDepthPreview.subscribe(render)
  }, [])
  return <div className="gs-depth-view">
    <canvas ref={canvas} aria-label="实时 GS 深度图" onPointerMove={event => {
      const frame = gsDepthPreview.frame; if (!frame) return
      const r = event.currentTarget.getBoundingClientRect()
      const x = Math.min(frame.width - 1, Math.max(0, Math.floor((event.clientX - r.left) / r.width * frame.width)))
      const y = Math.min(frame.height - 1, Math.max(0, Math.floor((event.clientY - r.top) / r.height * frame.height)))
      const d = frame.values[y * frame.width + x]; setDistance(d > 0 ? `${d.toFixed(3)} m（相机前向）` : '无有效深度')
    }}/>
    <label className="gs-depth-threshold">透明度阈值 <select aria-label="GS 深度透明度阈值" value={clip} onChange={e => { const value = Number(e.target.value); setClip(value); gsDepthPreview.alphaClip = value }}>
      <option value={.1}>0.1</option><option value={.3}>0.3</option><option value={.5}>0.5</option>
    </select></label>
    <small>{label}<br/>近白远黑 · 显示范围 0–6 m · {distance}</small>
  </div>
}

import { useEffect } from 'react'
import { ThermometerSun, Waves } from 'lucide-react'
import { Segmented } from 'antd'
import { GaussianDepthView } from './GaussianDepthView'
import { ThermalView } from './ThermalView'
import { Panel } from './Panel'
import { gsDepthPreview } from '../features/gaussian-viewer/depth/gsDepthPreview'
import { thermalPreview } from '../features/gaussian-viewer/thermal/thermalPreview'
import { useAppStore } from '../store/useAppStore'

const options = [
  { label: '多视图', value: 'all' },
  { label: 'GS 实时深度', value: 'depth' },
  { label: '仿真热像', value: 'thermal' },
]
const feeds = [
  { id: 'depth', label: 'GS 实时深度', icon: Waves },
  { id: 'thermal', label: '仿真热像', icon: ThermometerSun },
]

export function SensorPanel() {
  const { activeSensor, setSensor } = useAppStore()
  const sensor = activeSensor === 'depth' || activeSensor === 'thermal' ? activeSensor : 'all'
  useEffect(() => {
    gsDepthPreview.enabled = sensor === 'depth' || sensor === 'all'
    thermalPreview.enabled = sensor === 'thermal' || sensor === 'all'
    if (!thermalPreview.enabled) thermalPreview.clear()
    if (!gsDepthPreview.enabled) gsDepthPreview.publish(null)
    return () => {
      thermalPreview.enabled = false
      thermalPreview.clear()
      gsDepthPreview.enabled = false
      gsDepthPreview.publish(null)
    }
  }, [sensor])
  const visible = sensor === 'all' ? feeds : feeds.filter((feed) => feed.id === sensor)
  return <Panel title="传感器视图" extra={<span>展示 / 调试</span>}>
    <Segmented block size="small" value={sensor} onChange={(value) => setSensor(String(value))} options={options} />
    <div className="sensor-mode-hint">{sensor === 'all'
      ? '当前视口相机 · GS 实时深度与仿真热像'
      : sensor === 'depth' ? '当前视口相机 · GS 实时深度 · 非训练传感器'
      : '仿真相对热度 · 非标定热像仪'}</div>
    <div className={`sensor-grid ${visible.length === 1 ? 'single' : ''}`}>
      {visible.map(({ id, label, icon: Icon }) => <div className={`sensor-feed ${id}`} key={id}>
        <div className="feed-label"><Icon size={12} />{label}<span>实时 / ≤5 Hz</span></div>
        {id === 'depth' ? <GaussianDepthView /> : <ThermalView />}
      </div>)}
    </div>
  </Panel>
}

import { Radio, ScanLine, ThermometerSun, Waves } from 'lucide-react'
import { Segmented } from 'antd'
import { Panel } from './Panel'
import { useAppStore } from '../store/useAppStore'

const options = [{ label: '多视图', value: 'all' }, { label: 'RGB', value: 'rgb' }, { label: '深度', value: 'depth' }, { label: '热成像', value: 'thermal' }, { label: '激光雷达', value: 'lidar' }]
const feeds = [{ id: 'rgb', label: 'RGB 相机', icon: Radio }, { id: 'depth', label: '深度相机', icon: Waves }, { id: 'thermal', label: '热成像', icon: ThermometerSun }, { id: 'lidar', label: '激光雷达', icon: ScanLine }]
export function SensorPanel() { const { activeSensor, setSensor } = useAppStore(); const visible = activeSensor === 'all' ? feeds : feeds.filter((f) => f.id === activeSensor); return <Panel title="传感器视图" extra={<span className="live-dot">● LIVE</span>}><Segmented block size="small" value={activeSensor} onChange={(v) => setSensor(String(v))} options={options} /><div className={`sensor-grid ${visible.length === 1 ? 'single' : ''}`}>{visible.map(({ id, label, icon: Icon }) => <div className={`sensor-feed ${id}`} key={id}><div className="feed-label"><Icon size={12} />{label}<span>30 FPS</span></div><div className="feed-art"><span className="sensor-corridor"/><span className="sensor-flame"/>{id === 'lidar' && <span className="radar-sweep"/>}</div></div>)}</div></Panel> }

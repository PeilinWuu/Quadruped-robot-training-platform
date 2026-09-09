import { useEffect } from 'react'
import { GaussianDepthView } from './GaussianDepthView'
import { gsDepthPreview } from '../features/gaussian-viewer/depth/gsDepthPreview'
import { Radio, ScanLine, ThermometerSun, Waves } from 'lucide-react'
import { Segmented } from 'antd'
import { Panel } from './Panel'
import { useAppStore } from '../store/useAppStore'

const options = [{ label: '多视图', value: 'all' }, { label: '第一视角 RGB', value: 'rgb' }, { label: 'GS 实时深度', value: 'depth' }, { label: '热成像', value: 'thermal' }, { label: '激光雷达', value: 'lidar' }]
const feeds = [{ id: 'rgb', label: '第一视角 RGB', icon: Radio }, { id: 'depth', label: 'GS 实时深度', icon: Waves }, { id: 'thermal', label: '热成像', icon: ThermometerSun }, { id: 'lidar', label: '激光雷达', icon: ScanLine }]
export function SensorPanel() { const { activeSensor, setSensor } = useAppStore(); useEffect(() => { gsDepthPreview.enabled = activeSensor === 'depth' || activeSensor === 'all'; if (!gsDepthPreview.enabled) gsDepthPreview.publish(null); return () => { gsDepthPreview.enabled = false; gsDepthPreview.publish(null) } }, [activeSensor]); const visible = activeSensor === 'all' ? feeds : feeds.filter((f) => f.id === activeSensor); return <Panel title="传感器视图" extra={<span>深度调试</span>}><Segmented block size="small" value={activeSensor} onChange={(v) => setSensor(String(v))} options={options} /><div className="sensor-mode-hint">{activeSensor === 'all' ? '深度为实时 GS，其他画面为预留展示' : activeSensor === 'depth' ? '当前视口相机 · GS 实时深度 · 非训练传感器' : activeSensor === 'rgb' ? '第一视角 · Gaussian RGB' : '单路传感器视图'}</div><div className={`sensor-grid ${visible.length === 1 ? 'single' : ''}`}>{visible.map(({ id, label, icon: Icon }) => <div className={`sensor-feed ${id}`} key={id}><div className="feed-label"><Icon size={12} />{label}<span>{id === 'depth' ? '实时 / ≤5 Hz' : '预留'}</span></div>{id === 'depth' ? <GaussianDepthView/> : <div className="feed-art"><span className="sensor-corridor"/><span className="sensor-flame"/>{id === 'lidar' && <span className="radar-sweep"/>}</div>}</div>)}</div></Panel> }

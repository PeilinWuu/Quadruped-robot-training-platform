import { AlertTriangle, Building2, ChevronRight, CloudFog, Flame, Gauge, MapPinned, Thermometer } from 'lucide-react'
import { Button, Slider, Tag } from 'antd'
import { Panel } from './Panel'
import { useAppStore } from '../store/useAppStore'
import type { EnvironmentParams } from '../types'

const envRows: { key: keyof EnvironmentParams; label: string; suffix: string; icon: typeof Flame }[] = [
  { key: 'fireIntensity', label: '火源强度', suffix: '%', icon: Flame }, { key: 'smokeDensity', label: '烟雾密度', suffix: '%', icon: CloudFog }, { key: 'ambientTemp', label: '环境温度', suffix: '°C', icon: Thermometer }, { key: 'obstacleDensity', label: '障碍密度', suffix: '%', icon: Gauge },
]
export function SceneSidebar({ notify }: { notify: (text: string) => void }) {
  const { scenes, activeSceneId, selectScene, updateEnvironment } = useAppStore(); const active = scenes.find((s) => s.id === activeSceneId)
  return <aside className="left-column">
    <Panel title="场景管理" extra={<button className="text-btn" onClick={() => notify('新建场景接口已预留，等待后端接入')}>＋ 新建场景</button>}><div className="scene-list">{scenes.map((scene) => <button key={scene.id} className={scene.id === activeSceneId ? 'selected' : ''} onClick={() => selectScene(scene.id)}><Building2 size={15} /><span>{scene.name}</span><ChevronRight size={13} /></button>)}</div></Panel>
    {active && <><Panel title="场景信息"><div className="scene-title"><MapPinned size={17} /><strong>{active.name}</strong><Tag color={active.risk === '高' ? 'error' : 'warning'}>{active.risk}风险</Tag></div><dl className="info-grid"><dt>建筑结构</dt><dd>{active.building}</dd><dt>场景面积</dt><dd>{active.area} m²</dd><dt>楼层位置</dt><dd>{active.floor}</dd><dt>火源位置</dt><dd>{active.fireLocation}</dd></dl><p className="scene-desc"><AlertTriangle size={14} />{active.description}</p></Panel>
    <Panel title="环境参数"><div className="env-controls">{envRows.map(({ key, label, suffix, icon: Icon }) => <div className="env-row" key={key}><span><Icon size={14} />{label}</span><Slider min={0} max={key === 'ambientTemp' ? 100 : 100} value={active.environment[key]} onChange={(value) => updateEnvironment(key, value)} /><b>{active.environment[key]}{suffix}</b></div>)}</div><Button block onClick={() => notify('场景参数已保存至本地 Mock 状态')}>保存场景配置</Button></Panel></>}
  </aside>
}

import { lazy, Suspense, useMemo, type ComponentType } from 'react'
import { MOCK_RESEARCH_CHARTS } from '../config/features'
import { Panel } from './Panel'

type ChartsModule = { default: ComponentType }
type ChartsLoader = () => Promise<ChartsModule>

const loadChartsPanel: ChartsLoader = () => import('./ChartsPanel')
  .then(({ ChartsPanel }) => ({ default: ChartsPanel }))

export function MockResearchChartsSlot({
  enabled = MOCK_RESEARCH_CHARTS.enabled,
  loader = loadChartsPanel,
}: {
  enabled?: boolean
  loader?: ChartsLoader
}) {
  const LazyChartsPanel = useMemo(() => lazy(loader), [loader])
  if (!enabled) {
    return <Panel title="科研图表">
      <p>Mock research charts 暂停；MuJoCo、ROS 2 与基础 telemetry 保持运行。</p>
    </Panel>
  }
  return <Suspense fallback={<Panel title="科研图表"><p>正在加载图表模块…</p></Panel>}>
    <LazyChartsPanel/>
  </Suspense>
}

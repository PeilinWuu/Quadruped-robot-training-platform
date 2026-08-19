// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockResearchChartsSlot } from './MockResearchChartsSlot'

describe('mock research charts lifecycle gate', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  function mount(element: React.ReactNode) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(element))
  }

  it('does not load or mount the ECharts module while disabled, including remounts', () => {
    const loader = vi.fn(async () => ({ default: () => <canvas data-echarts/> }))
    mount(<MockResearchChartsSlot enabled={false} loader={loader}/>)
    expect(loader).not.toHaveBeenCalled()
    expect(container?.querySelector('canvas')).toBeNull()
    act(() => root?.render(<MockResearchChartsSlot enabled={false} loader={loader}/>))
    expect(loader).not.toHaveBeenCalled()
  })

  it('loads and mounts the original chart entry when explicitly enabled', async () => {
    const loader = vi.fn(async () => ({ default: () => <canvas data-echarts/> }))
    mount(<MockResearchChartsSlot enabled loader={loader}/>)
    await act(async () => { await Promise.resolve() })
    expect(loader).toHaveBeenCalledTimes(1)
    expect(container?.querySelector('[data-echarts]')).not.toBeNull()
  })
})

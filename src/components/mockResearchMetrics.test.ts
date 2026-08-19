import { describe, expect, it, vi } from 'vitest'
import { resolveMockResearchChartsFeature } from '../config/features'
import { startMockResearchMetrics, type IntervalScheduler } from '../features/research-charts/mockResearchMetrics'

describe('mock research metrics producer', () => {
  it('is disabled by default in Dev and Production', () => {
    expect(resolveMockResearchChartsFeature({})).toEqual({ enabled: false, metricsProducerEnabled: false })
    expect(resolveMockResearchChartsFeature({ DEV: true, PROD: false })).toEqual({ enabled: false, metricsProducerEnabled: false })
    expect(resolveMockResearchChartsFeature({ DEV: false, PROD: true })).toEqual({ enabled: false, metricsProducerEnabled: false })
  })

  it('creates no timer and appends no history while disabled', () => {
    const append = vi.fn()
    const scheduler: IntervalScheduler = { setInterval: vi.fn(() => 1), clearInterval: vi.fn() }
    const stop = startMockResearchMetrics(false, append, scheduler)
    expect(scheduler.setInterval).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    stop()
    expect(scheduler.clearInterval).not.toHaveBeenCalled()
  })

  it('can be explicitly enabled and cleans up its single timer', () => {
    expect(resolveMockResearchChartsFeature({ VITE_ENABLE_MOCK_RESEARCH_CHARTS: '1' }))
      .toEqual({ enabled: true, metricsProducerEnabled: true })
    const append = vi.fn()
    const callbacks: Array<() => void> = []
    const scheduler: IntervalScheduler = {
      setInterval: vi.fn((next) => { callbacks.push(next); return 7 }),
      clearInterval: vi.fn(),
    }
    const stop = startMockResearchMetrics(true, append, scheduler)
    callbacks[0]()
    expect(append).toHaveBeenCalledTimes(1)
    stop()
    expect(scheduler.clearInterval).toHaveBeenCalledWith(7)
  })

  it('retains the default-off memory diagnostics for isolation runs', () => {
    expect(resolveMockResearchChartsFeature({
      VITE_ENABLE_MOCK_RESEARCH_CHARTS: '1',
      VITE_D6_WEBKIT_MEM_DISABLE_CHARTS: '1',
    }).enabled).toBe(false)
    expect(resolveMockResearchChartsFeature({
      VITE_ENABLE_MOCK_RESEARCH_CHARTS: '1',
      VITE_D6_WEBKIT_MEM_FREEZE_METRICS: '1',
    })).toEqual({ enabled: true, metricsProducerEnabled: false })
  })
})

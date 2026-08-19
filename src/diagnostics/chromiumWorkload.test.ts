// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createD6Pose, createD6Telemetry, D6_CHROMIUM_FRONTEND_INTERVAL_MS,
  D6_CHROMIUM_POSE_SOURCE_HZ, D6_CHROMIUM_SOURCE_HZ, startD6ChromiumWorkload,
} from './chromiumWorkload'
import { useAppStore } from '../store/useAppStore'

describe('D6 Chromium shared workload', () => {
  afterEach(() => { vi.useRealTimers(); delete window.__D6_CHROMIUM_POC__ })

  it('is deterministic and matches production telemetry structure', () => {
    expect(createD6Telemetry(42)).toEqual(createD6Telemetry(42))
    expect(createD6Telemetry(42)).not.toEqual(createD6Telemetry(43))
    expect(createD6Telemetry(42).joints).toHaveLength(12)
    expect(createD6Telemetry(42).feet).toHaveLength(4)
    expect(createD6Pose(60).joints).toHaveLength(12)
    expect(D6_CHROMIUM_SOURCE_HZ).toBe(50)
    expect(D6_CHROMIUM_POSE_SOURCE_HZ).toBe(60)
    expect(D6_CHROMIUM_FRONTEND_INTERVAL_MS).toBe(100)
  })

  it('coalesces dynamic sources into bounded store updates and cleans timers', async () => {
    vi.useFakeTimers()
    const stop = startD6ChromiumWorkload('dynamic')
    await vi.advanceTimersByTimeAsync(1000)
    const counters = window.__D6_CHROMIUM_POC__!
    expect(counters.sourceTelemetry).toBeGreaterThanOrEqual(49)
    expect(counters.sourcePose).toBeGreaterThanOrEqual(59)
    expect(counters.storeTelemetryUpdates).toBeLessThanOrEqual(11)
    expect(counters.storePoseUpdates).toBeLessThanOrEqual(11)
    expect(useAppStore.getState().simulation.latestTelemetry?.joints).toHaveLength(12)
    stop()
    expect(counters.activeTimers).toBe(0)
  })

  it('keeps static mode timer-free after one representative snapshot', () => {
    vi.useFakeTimers()
    const stop = startD6ChromiumWorkload('static')
    const counters = window.__D6_CHROMIUM_POC__!
    expect(counters.activeTimers).toBe(0)
    expect(counters.storePoseUpdates).toBe(1)
    expect(counters.sourceTelemetry).toBe(0)
    stop()
  })
})

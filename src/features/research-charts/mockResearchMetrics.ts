export interface IntervalScheduler {
  setInterval(handler: () => void, timeoutMs: number): number
  clearInterval(timerId: number): void
}

export function startMockResearchMetrics(
  enabled: boolean,
  appendMockMetrics: () => void,
  scheduler: IntervalScheduler = window,
): () => void {
  if (!enabled) return () => undefined
  const timerId = scheduler.setInterval(appendMockMetrics, 2_500)
  return () => scheduler.clearInterval(timerId)
}

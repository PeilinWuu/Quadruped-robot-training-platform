import { describe, expect, it } from 'vitest'
import { resolveVisualMaxFps } from '../../renderer/PlayCanvasGsRuntime'

describe('PlayCanvas render policy', () => {
  it('keeps Windows at 60 fps and selects 30 fps for Linux WebKit by default', () => {
    expect(resolveVisualMaxFps('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(60)
    expect(resolveVisualMaxFps('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).toBe(30)
  })

  it('accepts only the measured 60, 45 and 30 fps diagnostic tiers', () => {
    expect(resolveVisualMaxFps('Linux', '60')).toBe(60)
    expect(resolveVisualMaxFps('Linux', '45')).toBe(45)
    expect(resolveVisualMaxFps('Linux', '30')).toBe(30)
    expect(resolveVisualMaxFps('Linux', '15')).toBe(30)
  })
})

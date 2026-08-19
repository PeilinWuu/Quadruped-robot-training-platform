import { describe, expect, it } from 'vitest'
import { resolveNativeMujocoViewerPoc } from './features'

describe('native MuJoCo viewer POC feature', () => {
  it('defaults off and cannot be enabled in production', () => {
    expect(resolveNativeMujocoViewerPoc({}, true)).toBe(false)
    expect(resolveNativeMujocoViewerPoc({ VITE_D6_NATIVE_MUJOCO_VIEWER_POC: '1' }, false)).toBe(false)
  })

  it('requires an explicit development flag', () => {
    expect(resolveNativeMujocoViewerPoc({ VITE_D6_NATIVE_MUJOCO_VIEWER_POC: '1' }, true)).toBe(true)
    expect(resolveNativeMujocoViewerPoc({ VITE_D6_NATIVE_MUJOCO_VIEWER_POC: 'true' }, true)).toBe(false)
  })
})

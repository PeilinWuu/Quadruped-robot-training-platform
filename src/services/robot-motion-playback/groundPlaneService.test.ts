import { describe, expect, it } from 'vitest'
import { fitGroundPlane, groundHeightAt } from './groundPlaneService'

describe('ground plane calibration', () => {
  it('fits a horizontal plane from three viewer-space picks', () => {
    const plane = fitGroundPlane([[0, 1.25, 0], [1, 1.25, 0], [0, 1.25, 1]], 'office_01')
    expect(plane).not.toBeNull()
    expect(groundHeightAt(plane!, 3, -2)).toBeCloseTo(1.25)
  })

  it('rejects collinear picks', () => {
    expect(fitGroundPlane([[0, 0, 0], [1, 1, 1], [2, 2, 2]])).toBeNull()
  })
})

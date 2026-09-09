import { describe, expect, it } from 'vitest'
import { FOOT_RADIUS, solveStepStance, stepHeight } from './stepMath'
describe('local step standing IK',()=> {
  it('keeps the two levels discontinuous at the edge and bounds the patch',()=> {
    const s={mode:'straddle' as const,lower:0,rise:.15,edge:-.54}
    expect(stepHeight(3.5,-.539,s)).toBe(0)
    expect(stepHeight(3.5,-.541,s)).toBe(.15)
    expect(stepHeight(1,-.6,s)).toBeNull()
  })
  for(const mode of ['lower','straddle','upper'] as const) it(`puts all four feet on their own surface: ${mode}`,()=> {
    const s={mode,lower:0,rise:.15,edge:-.54},result=solveStepStance(s)
    expect(result.maxError).toBeLessThan(1e-8)
    for(const [x,y,z] of result.achieved) expect(y-FOOT_RADIUS).toBeCloseTo(stepHeight(x,z,s)!,8)
    if(mode==='straddle') {expect(result.targets[0][1]-result.targets[2][1]).toBeCloseTo(.15);expect(result.pitch).toBeGreaterThan(0)}
    else expect(result.pitch).toBe(0)
  })
  it('remains reachable throughout the allowed height adjustment range',()=> {
    for(const rise of [.08,.15,.22])for(const lower of [-.03,0,.03])for(const mode of ['lower','straddle','upper'] as const) {
      const result=solveStepStance({rise,lower,mode,edge:-.54})
      expect(result.maxError).toBeLessThan(1e-8)
      expect(result.joints.flat().every(Number.isFinite)).toBe(true)
      for(const angles of result.joints) {expect(angles[1]).toBeGreaterThan(-1.57);expect(angles[1]).toBeLessThan(3.49);expect(angles[2]).toBeGreaterThan(-2.723);expect(angles[2]).toBeLessThan(-.837)}
    }
  })
})

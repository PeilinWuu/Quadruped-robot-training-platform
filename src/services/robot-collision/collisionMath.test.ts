import { describe, expect, it } from 'vitest'
import { sweepAndSlide, constrainRotation, overlapDepth, ROBOT_HALF_SIZE } from './collisionMath'
import type { ObstacleBox } from './collisionMath'
const wall:ObstacleBox={id:'wall',label:'wall',center:[2,0],half:[.05,4],bottom:0,top:2,yaw:0}
describe('air wall swept movement',()=> {
  it('fits a narrow passage lengthwise but blocks broadside motion',()=> {
    const side={...wall,center:[0,.35],half:[5,.05]}
    const other={...side,center:[0,-.35]}
    expect(sweepAndSlide([0,0],[3,0],{half:ROBOT_HALF_SIZE,yaw:0},0,.6,[side,other]).blocked).toBeNull()
    expect(overlapDepth([0,0],side,{half:ROBOT_HALF_SIZE,yaw:Math.PI/2})).toBeGreaterThan(0)
  })
  it('limits a turn before a corner rotates into a wall',()=> {
    const side={...wall,center:[0,.35],half:[5,.01]}
    const r=constrainRotation([0,0],ROBOT_HALF_SIZE,0,Math.PI/2,0,.6,[side])
    expect(r.blocked).toBe('wall');expect(r.yaw).toBeGreaterThan(0);expect(r.yaw).toBeLessThan(Math.PI/2)
    expect(overlapDepth([0,0],side,{half:ROBOT_HALF_SIZE,yaw:r.yaw})).toBeLessThanOrEqual(0)
  })
  it('uses the long side when moving toward an end wall',()=> {
    const r=sweepAndSlide([0,0],[4,0],{half:ROBOT_HALF_SIZE,yaw:0},0,.6,[wall])
    expect(r.position[0]).toBeCloseTo(2-.05-.38-.001)
  })
  it('stops a fast move before a thin wall',()=> {
    const r=sweepAndSlide([0,0],[10,0],.4,0,.6,[wall])
    expect(r.position[0]).toBeCloseTo(1.549,3);expect(r.blocked).toBe('wall')
  })
  it('slides along the wall and permits retreat',()=> {
    const r=sweepAndSlide([0,0],[3,1],.4,0,.6,[wall])
    expect(r.position[0]).toBeLessThan(1.55);expect(r.position[1]).toBeCloseTo(1)
    expect(sweepAndSlide(r.position,[0,1],.4,0,.6,[wall]).position).toEqual([0,1])
  })
  it('blocks both directions',()=>expect(sweepAndSlide([4,0],[0,0],.4,0,.6,[wall]).position[0]).toBeGreaterThan(2.45))
  it('allows a low body under a high tabletop',()=>expect(sweepAndSlide([0,0],[4,0],.4,0,.5,[{...wall,bottom:.7}]).position).toEqual([4,0]))
  it('handles rotated walls',()=> {
    const r=sweepAndSlide([0,0],[4,0],.4,0,.6,[{...wall,yaw:Math.PI/4}])
    expect(r.blocked).toBe('wall');expect(r.position[1]).not.toBe(0)
  })
  it('prevents corner penetration',()=> {
    const second={...wall,id:'other',center:[0,2],half:[4,.05]}
    const r=sweepAndSlide([0,0],[4,4],.4,0,.6,[wall,second])
    expect(r.position[0]).toBeLessThan(1.55);expect(r.position[1]).toBeLessThan(1.55)
  })
  it('lets an overlapping spawn exit without moving deeper',()=> {
    expect(sweepAndSlide([1.8,0],[1,0],.4,0,.6,[wall]).position[0]).toBe(1)
    expect(sweepAndSlide([1.8,0],[2,0],.4,0,.6,[wall]).position[0]).toBe(1.8)
  })
})

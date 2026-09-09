import { describe, expect, it } from 'vitest'
import { rayBox, renderThermal, sampleHeat, thermalColor } from './thermalMath'
import type { ThermalGrid, ThermalInput } from './thermalMath'

const grid=(lower: [number,number,number], heat=255):ThermalGrid=>({lower,extent:[2,2,1],dimensions:[2,2,2],current:new Uint8Array(8).fill(heat),next:new Uint8Array(8).fill(heat),alpha:0,stride:1,channel:0})
const input=(depth: number):ThermalInput=>({width:1,height:1,depth:new Float32Array([depth]),cameraWorld:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],projection:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],tracks:[{gas:grid([-1,2,-.5]),solid:grid([-1,8,-.5],0),offset:0}],sequence:1,timestampMs:0})
describe('relative thermal projection',()=> {
  it('hides hot gas behind a GS surface and exposes it when depth moves behind the gas',()=> {
    expect(renderThermal(input(1)).values[0]).toBeCloseTo(.08)
    expect(renderThermal(input(5)).values[0]).toBeGreaterThan(.9)
  })
  it('masks unknown depth rather than rendering hidden heat',()=> {
    const frame=renderThermal(input(0));expect(frame.valid[0]).toBe(0);expect(frame.values[0]).toBe(0)
  })
  it('samples hot solid at the visible surface without requiring gas',()=> {
    const i=input(3);i.tracks[0].gas=grid([-1,8,-.5],0);i.tracks[0].solid=grid([-1,2,-.5])
    expect(renderThermal(i).values[0]).toBeCloseTo(1)
    i.tracks[0].offset=.2;expect(renderThermal(i).values[0]).toBeCloseTo(1)
  })
  it('uses the temperature channel and interpolates frames',()=> {
    const g=grid([0,0,0]);g.stride=2;g.channel=1;g.current=new Uint8Array(16);g.next=new Uint8Array(16)
    for(let j=0;j<8;j++){g.current[j*2]=255;g.next[j*2+1]=255}
    g.alpha=.25;expect(sampleHeat(g,1,1,.5)).toBeCloseTo(.25)
    expect(sampleHeat(g,3,1,.5)).toBe(0)
  })
  it('does not change heat when track order changes',()=> {
    const i=input(5);i.tracks.push({gas:grid([-1,1,-.5],128),solid:grid([-1,8,-.5],0),offset:0})
    const a=renderThermal(i).values[0];i.tracks.reverse();expect(renderThermal(i).values[0]).toBeCloseTo(a,6)
  })
  it('handles parallel rays and fixed palettes',()=> {
    expect(rayBox([0,0,0],[0,1,0],[1,2,-1],[2,2,2])).toBeNull()
    expect(thermalColor(0,'white')).toEqual([0,0,0]);expect(thermalColor(1,'black')).toEqual([0,0,0])
  })
})

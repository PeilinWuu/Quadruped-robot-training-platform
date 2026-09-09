// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { GroundCollisionService } from './groundCollisionService'
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear()})
it('reads a non-square NumPy [X,Y] C-order heightfield without transposing the coordinates',async()=> {
  localStorage.clear()
  const heights=new Float32Array([0,1,2,3,10,11,12,13,20,21,22,23])
  const valid=new Uint8Array(12).fill(1)
  vi.stubGlobal('fetch',vi.fn(async(url:URL)=>({ok:true,
    json:async()=>({schema:'gs-ground-collision-v1',cellSize:1,originXY:[0,0],shape:[3,4],globalFloorHeight:0}),
    arrayBuffer:async()=>url.pathname.endsWith('floor_height.bin')?heights.buffer:valid.buffer})))
  const service=new GroundCollisionService();await service.load()
  expect(service.sample(.2,-.2)).toBe(5.5)
  expect(service.sample(1.2,-2.2)).toBe(17.5)
})

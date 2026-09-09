export type Triple = [number, number, number]
export interface ThermalGrid {
  dimensions: Triple; lower: Triple; extent: Triple
  current: Uint8Array; next: Uint8Array; alpha: number; stride: number; channel: number
}
export interface ThermalTrack { gas: ThermalGrid; solid: ThermalGrid; offset: number }
export interface ThermalInput {
  width: number; height: number; depth: Float32Array; cameraWorld: number[]; projection: number[]
  tracks: ThermalTrack[]; sequence: number; timestampMs: number
}
export interface ThermalFrame {
  width: number; height: number; values: Float32Array; valid: Uint8Array
  sequence: number; timestampMs: number; renderMs: number
}

// Match the fire atlas's (dimensions - 1) filtered coordinate convention.
export function sampleHeat(grid: ThermalGrid, x: number, y: number, z: number): number {
  const uv = [(x-grid.lower[0])/grid.extent[0], (y-grid.lower[1])/grid.extent[1], (z-grid.lower[2])/grid.extent[2]]
  if (uv.some(v => v < 0 || v > 1)) return 0
  const [nx, ny, nz] = grid.dimensions
  const px=uv[0]*(nx-1), py=uv[1]*(ny-1), pz=uv[2]*(nz-1)
  const ix=Math.floor(px), iy=Math.floor(py), iz=Math.floor(pz)
  const fx=px-ix, fy=py-iy, fz=pz-iz
  let result=0
  for(let a=0;a<2;a++) for(let b=0;b<2;b++) for(let c=0;c<2;c++) {
    const i=((Math.min(ix+a,nx-1)*ny+Math.min(iy+b,ny-1))*nz+Math.min(iz+c,nz-1))*grid.stride+grid.channel
    const weight=(a?fx:1-fx)*(b?fy:1-fy)*(c?fz:1-fz)
    result+=((1-grid.alpha)*grid.current[i]+grid.alpha*grid.next[i])*weight/255
  }
  return result
}

export function rayBox(origin: Triple, ray: Triple, lower: Triple, extent: Triple): [number, number] | null {
  let entry=0, exit=Infinity
  for(let i=0;i<3;i++) {
    if(Math.abs(ray[i])<1e-9) { if(origin[i]<lower[i] || origin[i]>lower[i]+extent[i]) return null; continue }
    const a=(lower[i]-origin[i])/ray[i], b=(lower[i]+extent[i]-origin[i])/ray[i]
    entry=Math.max(entry,Math.min(a,b)); exit=Math.min(exit,Math.max(a,b))
  }
  return exit>entry?[entry,exit]:null
}

export function renderThermal(input: ThermalInput): ThermalFrame {
  const start=performance.now(), {width,height,depth,tracks,cameraWorld:m,projection:p}=input
  const values=new Float32Array(width*height), valid=new Uint8Array(width*height)
  const origin: Triple=[m[12],-m[14],m[13]]
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const index=y*width+x, surface=depth[index]
    // Parameter t is camera-forward distance, matching GS depth (not ray length).
    const cx=(2*(x+.5)/width-1)/p[0], cy=(1-2*(y+.5)/height)/p[5]
    const ray: Triple=[m[0]*cx+m[4]*cy-m[8], -(m[2]*cx+m[6]*cy-m[10]), m[1]*cx+m[5]*cy-m[9]]
    let background=.08
    if(surface>0) {
      const sx=origin[0]+ray[0]*surface, sy=origin[1]+ray[1]*surface, sz=origin[2]+ray[2]*surface
      for(const track of tracks) background=Math.max(background,sampleHeat(track.solid,sx,sy,sz))
      valid[index]=1
    }
    const intervals=tracks.map(track => {
      const shifted: Triple=[origin[0],origin[1]+track.offset,origin[2]]
      return rayBox(shifted,ray,track.gas.lower,track.gas.extent)
    })
    let entry=Infinity, exit=0
    for(const hit of intervals) if(hit) {entry=Math.min(entry,hit[0]); exit=Math.max(exit,hit[1])}
    // Unknown GS depth is masked, rather than showing potentially hidden heat.
    if(surface<=0) continue
    exit=Math.min(exit,surface-.012)
    let transmission=1, emission=0
    if(exit>entry) {
      const length=Math.hypot(...ray), steps=Math.min(192,Math.max(1,Math.ceil((exit-entry)*length/.065)))
      const dt=(exit-entry)/steps, ds=dt*length
      for(let s=0;s<steps;s++) {
        const t=entry+(s+.5)*dt
        let absorption=0, radiance=0
        for(let k=0;k<tracks.length;k++) {
          const hit=intervals[k]; if(!hit || t<hit[0] || t>hit[1]) continue
          const track=tracks[k]
          const heat=sampleHeat(track.gas,origin[0]+ray[0]*t,origin[1]+ray[1]*t+track.offset,origin[2]+ray[2]*t)
          const sigma=3*heat
          absorption+=sigma; radiance+=sigma*heat**4
        }
        if(absorption>0) { const a=1-Math.exp(-absorption*ds); emission+=transmission*a*radiance/absorption; transmission*=1-a }
        if(transmission<.005) break
      }
    }
    // Relative radiance proxy, not a calibrated spectral sensor or Celsius.
    values[index]=(emission+transmission*background**4)**.25
  }
  return {width,height,values,valid,sequence:input.sequence,timestampMs:input.timestampMs,renderMs:performance.now()-start}
}

export function thermalColor(value: number, palette: 'iron'|'white'|'black'): Triple {
  const v=Math.max(0,Math.min(1,value))
  if(palette!=='iron') { const c=Math.round(255*(palette==='white'?v:1-v)); return [c,c,c] }
  const stops: Triple[]=[[5,4,18],[45,12,88],[142,23,84],[224,65,31],[255,172,43],[255,255,220]]
  const t=v*5, i=Math.min(4,Math.floor(t)), f=t-i
  return stops[i].map((c,k)=>Math.round(c+(stops[i+1][k]-c)*f)) as Triple
}

import { firePlaybackService } from '../../../services/fire-playback/firePlaybackService'
import type { FirePlaybackMetadata, FirePlaybackSample } from '../../../services/fire-playback/types'
import type { ThermalFrame, ThermalInput, ThermalTrack, Triple } from './thermalMath'

interface SolidMetadata {
  schema: string; dimensions: Triple; lower: Triple; extent: Triple
  frames: Array<{ sourceFrame: number; file: string }>
}
interface TrackSnapshot { metadata: FirePlaybackMetadata; sample: FirePlaybackSample; base: string; offset: number }
const listeners=new Set<() => void>()
const cache=new Map<string,Promise<Uint8Array>>()
const metadataCache=new Map<string,Promise<SolidMetadata>>()
let worker: Worker | null=null, generation=0, busy=false, abort=new AbortController()

export const thermalPreview = {
  enabled: false,
  frame: null as ThermalFrame|null,
  error: null as string|null,
  cameraMode: '当前自由视角',
  tracks: 0,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  publish(frame: ThermalFrame|null, error: string|null=null) {
    this.frame=frame; this.error=error; for(const listener of listeners) listener()
  },
  clear() {
    generation++; busy=false; worker?.terminate(); worker=null
    abort.abort(); abort=new AbortController(); cache.clear(); metadataCache.clear(); this.tracks=0; this.publish(null)
  },
  snapshot(): TrackSnapshot[] | null {
    if(!this.enabled || busy) return null
    const result: TrackSnapshot[]=[]
    for(const service of [firePlaybackService,...firePlaybackService.getCompanions().values()]) {
      const metadata=service.getMetadata(), sample=service.getLatestSample()
      if(!metadata || !sample) { this.publish(null,'等待火焰温度数据'); return null }
      if(metadata.schema!=='fierygs-fire-playback-v1') { this.publish(null,'当前热像需要 V1 温度数据，请切换 V1'); return null }
      result.push({metadata,sample,base:service.assetBaseUrl,offset:metadata.scenarioId==='curtain_high'?Math.max(0,Math.min(.2,firePlaybackService.curtainSurfaceOffset)):0})
    }
    return result
  },
  async render(input: Omit<ThermalInput,'tracks'>, snapshot: TrackSnapshot[]) {
    if(!this.enabled || busy) return
    busy=true; const token=generation
    try {
      const tracks: ThermalTrack[]=await Promise.all(snapshot.map(async ({metadata:m,sample:s,base,offset}) => {
        let promise=metadataCache.get(base)
        if(!promise) { promise=fetch(base+'thermal.json',{signal:abort.signal}).then(async r=> {
          if(!r.ok) throw Error(`固体温度文件缺失：${m.scenarioId}`)
          const data=await r.json() as SolidMetadata
          if(data.schema!=='fierygs-solid-thermal-v1' || data.dimensions.length!==3 || data.dimensions.some(n=>!Number.isInteger(n)||n<=0) || data.lower.length!==3 || data.extent.length!==3 || data.extent.some(n=>!Number.isFinite(n)||n<=0)) throw Error('固体温度元数据无效')
          return data
        }); metadataCache.set(base,promise) }
        const solid=await promise
        const frame=async(source: number) => {
          const record=solid.frames.find(f=>f.sourceFrame===source)
          if(!record || !/^thermal_\d{3}\.bin$/.test(record.file)) throw Error('固体温度帧与火焰不匹配')
          const key=base+record.file
          let pending=cache.get(key)
          if(!pending) {
            pending=fetch(key,{signal:abort.signal}).then(async r=> {
              if(!r.ok) throw Error('固体温度帧加载失败')
              const bytes=new Uint8Array(await r.arrayBuffer())
              if(bytes.length!==solid.dimensions.reduce((a,b)=>a*b,1)) throw Error('固体温度帧长度无效')
              return bytes
            }); cache.set(key,pending)
          }
          cache.delete(key); cache.set(key,pending)
          while(cache.size>12) cache.delete(cache.keys().next().value!)
          return pending
        }
        const [current,next]=await Promise.all([frame(s.current.sourceFrame),frame(s.next.sourceFrame)])
        return {offset,
          gas:{dimensions:m.grid.dimensions,lower:m.grid.worldLower,extent:m.grid.worldUpper.map((v,i)=>v-m.grid.worldLower[i]) as Triple,current:s.current.voxels,next:s.next.voxels,alpha:s.alpha,stride:2,channel:1},
          solid:{dimensions:solid.dimensions,lower:solid.lower,extent:solid.extent,current,next,alpha:s.alpha,stride:1,channel:0}}
      }))
      if(token!==generation || !this.enabled) return
      if(!worker) {
        worker=new Worker(new URL('./thermal.worker.ts',import.meta.url),{type:'module'})
        worker.onmessage=(event: MessageEvent<{frame?: ThermalFrame;error?:string}>)=> {
          busy=false
          if(this.enabled) this.publish(event.data.frame??null,event.data.error??null)
        }
        worker.onerror=()=> {busy=false; this.publish(null,'热像计算线程异常'); worker?.terminate(); worker=null}
      }
      this.tracks=tracks.length
      worker.postMessage({...input,tracks})
    } catch(error) {
      if(token===generation) { busy=false; cache.clear(); metadataCache.clear(); this.publish(null,error instanceof Error?error.message:'THERMAL_LOAD_FAILED') }
    }
  },
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserFireAssetAdapter, validateFirePlaybackMetadata } from './browserFireAssetAdapter'
import { FirePlaybackService } from './firePlaybackService'
import type { FirePlaybackMetadata, FirePlaybackSample } from './types'

function metadata(v2 = true): FirePlaybackMetadata {
  const size = v2 ? 8 : 2
  return {
    schema: v2 ? 'fierygs-fire-playback-v2' : 'fierygs-fire-playback-v1', scenarioId: 'table_high', sourceMode: 'native_reignite',
    rendererProfile: { xyz2rgbClipOutput: true, hdrAces: false, strength: .005, smokeStrength: .2 },
    playback: { fps: 8, frameCount: 4, loopMode: 'ping-pong', stages: ['established'] },
    grid: { dimensions: [1,1,1], sourceDimensions: [1,1,1], cropOrigin: [0,0,0], voxelSize: .05,
      sourceLower: [0,0,0], worldLower: [0,0,0], worldUpper: [.05,.05,.05], sourceToViewer: [1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1] },
    encoding: { layout: v2 ? 'source-c-order-xyz-rgba-rgba' : 'source-c-order-xyz-rg',
      channels: v2 ? ['emissionR','emissionG','emissionB','extinction','smokeR','smokeG','smokeB','smokeDensity'] : ['fuel','temperature'],
      componentType: 'uint8-unorm', bytesPerVoxel: size, frameBytes: size, quantization: {minimum:0,maximum:1},
      ...(v2 ? { emissionScale: [.3,.05,.01] as [number,number,number], emissionZero: 128 as const,
        colorSpace: 'native-cat02-linear-srgb-signed' as const, strengthBaked: true as const } : {}) },
    frames: Array.from({length:4}, (_,i) => ({playbackIndex:i,sourceFrame:28+i*2,stage:'established',chunk:Math.floor(i/2),offset:(i%2)*size})),
    chunks: Array.from({length:2}, (_,i) => ({index:i,file:`frames_00${i}.bin`,firstPlaybackIndex:i*2,frameCount:2,byteLength:size*2,sha256: v2 ? '374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb' : 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119'})),
    source: { simulationDirectory:'test',firstFrame:28,lastFrame:34,frameStep:2,threshold:1e-5,padding:2 },
  }
}
function mockAssets(fail: (url: string) => boolean = () => false) {
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const url = String(input)
    if (fail(url)) return new Response('', {status:404})
    const m = metadata(!['/v1/', '/fire-playback/', '/fire-playback-room/'].some(path => url.includes(path)))
    return url.endsWith('metadata.json') ? new Response(JSON.stringify(m)) : new Response(new Uint8Array(m.encoding.frameBytes*2))
  }))
}
async function settle() { for (let i=0;i<20;i++) await Promise.resolve() }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('fire playback V2', () => {
  it.each([false,true])('accepts version v2=%s', (v2) => expect(validateFirePlaybackMetadata(metadata(v2))).toEqual(metadata(v2)))
  it('rejects incompatible display HDR', () => { const m=metadata(); Object.assign(m.rendererProfile,{hdrAces:true}); expect(()=>validateFirePlaybackMetadata(m)).toThrow('PROFILE') })
  it('rejects mismatched channel layout and missing signed emission range', () => {
    const m=metadata(); m.encoding.channels.reverse(); expect(()=>validateFirePlaybackMetadata(m)).toThrow('V2_ENCODING')
    m.encoding=metadata().encoding; delete m.encoding.emissionScale; expect(()=>validateFirePlaybackMetadata(m)).toThrow('V2_ENCODING')
  })
  it('rejects out-of-chunk offsets', () => { const m=metadata();m.frames[0].offset=16;expect(()=>validateFirePlaybackMetadata(m)).toThrow('MAPPING') })
  it('rejects a truncated chunk', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array(1))))
    await expect(new BrowserFireAssetAdapter('/v2/').loadFrame(metadata(),0)).rejects.toThrow('LENGTH')
  })
  it('retains only an adjacent frame pair and at most two chunks', async () => {
    mockAssets(); const m=metadata(); const a=new BrowserFireAssetAdapter('/v2/')
    for (const pair of [[0,1],[1,2],[2,3],[3,2],[2,1],[1,0]]) {
      a.retainPair(m,pair); await Promise.all(pair.map(i=>a.loadFrame(m,i)))
      expect(a.getCacheStats().frames).toBe(2);expect(a.getCacheStats().chunks).toBeLessThanOrEqual(2)
    }
  })
  it.each(['metadata.json','frames_000.bin'])('falls back on a failed initial %s', async (file) => {
    mockAssets(url=>url.includes('/v2/')&&url.endsWith(file)); const s=new FirePlaybackService()
    await s.load('/v2/','/v1/');expect(s.getState()).toMatchObject({version:'playback-v1',phase:'ready'});expect(s.getState().fallbackReason).toBeTruthy();s.dispose()
  })
  it('falls back on a later corrupt/missing chunk and resumes playing', async () => {
    mockAssets(url=>url.includes('/v2/')&&url.endsWith('frames_001.bin'));const s=new FirePlaybackService()
    await s.load('/v2/','/v1/');s.play();s.update(.125)
    await vi.waitFor(()=>expect(s.getState()).toMatchObject({version:'playback-v1',playing:true}));s.dispose()
  })
  it('interpolates, pauses, resets and reverses at the boundary', async () => {
    mockAssets();const s=new FirePlaybackService();const samples:FirePlaybackSample[]=[];s.onSample(sample=>samples.push(sample))
    await s.load('/v2/');s.play();s.update(.0625);await settle();expect(samples.at(-1)?.alpha).toBeCloseTo(.5)
    s.pause();const count=samples.length;s.update(.2);await settle();expect(samples).toHaveLength(count)
    s.seek(3);await vi.waitFor(()=>expect(samples.at(-1)?.current.index).toBe(3));expect(samples.at(-1)?.next.index).toBe(2)
    s.reset();await vi.waitFor(()=>expect(samples.at(-1)?.current.index).toBe(0));expect(s.getState().playing).toBe(false);s.dispose()
  })
  it('invalidates a late previous load without blocking a replacement load', async () => {
    mockAssets();let resolve!: (value:FirePlaybackMetadata)=>void
    vi.spyOn(BrowserFireAssetAdapter.prototype,'loadMetadata').mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
    const s=new FirePlaybackService();const old=s.load('/v2/');await s.load('/v1/');resolve(metadata());await old
    expect(s.getState().version).toBe('playback-v1');s.dispose()
  })
  it('loads independent V1 room fires and controls all tracks together', async () => {
    mockAssets(); const s = new FirePlaybackService()
    await s.setSceneMode('room')
    const tracks = [s, ...s.getCompanions().values()]
    expect(tracks).toHaveLength(3)
    expect(tracks.every(track => track.getState().version === 'playback-v1')).toBe(true)
    s.play(); expect(tracks.every(track => track.getState().playing)).toBe(true)
    s.update(.125); await vi.waitFor(() => expect(tracks.every(track => track.getState().frameIndex === 1)).toBe(true))
    s.pause(); expect(tracks.every(track => !track.getState().playing)).toBe(true)
    s.reset(); await vi.waitFor(() => expect(tracks.every(track => track.getState().frameIndex === 0)).toBe(true))
    await s.setSceneMode('single'); expect(s.getCompanions().size).toBe(0)
    expect(tracks.slice(1).every(track => track.getState().phase === 'idle')).toBe(true)
    s.dispose()
  })
  it('keeps the table usable when one additional asset is unavailable', async () => {
    mockAssets(url => url.includes('/sofa_high/')); const s = new FirePlaybackService()
    await s.setSceneMode('room'); s.play()
    expect(s.getState()).toMatchObject({version:'playback-v1',playing:true,sceneMode:'room'})
    expect(s.getCompanions().get('sofa_high')?.getState().phase).toBe('error')
    expect(s.getCompanions().get('curtain_high')?.getState().playing).toBe(true)
    s.dispose()
  })
  it('advances display atmosphere only during room playback and clears it on reset or exit', async () => {
    mockAssets(); const s = new FirePlaybackService()
    await s.setSceneMode('room'); s.play(); s.update(.125)
    expect(s.presentationSeconds).toBe(.125)
    s.pause(); s.update(.125); expect(s.presentationSeconds).toBe(.125)
    s.reset(); expect(s.presentationSeconds).toBe(0)
    s.play(); s.update(.125); await s.setSceneMode('single')
    expect(s.presentationSeconds).toBe(0)
    s.update(.125); expect(s.presentationSeconds).toBe(0); s.dispose()
  })
  it('explicit V2 selection leaves the V1 room scenario and releases companions', async () => {
    mockAssets(); const s = new FirePlaybackService()
    await s.setSceneMode('room'); await s.selectVersion('playback-v2')
    expect(s.getState()).toMatchObject({sceneMode:'single',version:'playback-v2'})
    expect(s.getCompanions().size).toBe(0); s.dispose()
  })

})

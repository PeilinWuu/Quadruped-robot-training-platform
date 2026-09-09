import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
import fs from 'node:fs/promises';
const out=process.env.FIRE_QA_OUTPUT ?? 'tmp/gs-gpu-fire-results'; await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11','--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');
await page.waitForFunction(()=>window.ready, undefined, {timeout:120000});
console.log('READY',await page.evaluate(()=>({status:window.statusData,gpu:(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})()})));



await page.evaluate(async()=>{await fire.load('/fire-playback-room/curtain_high/');fire.seek(9);fire.pause();robot.pause();fire.atmosphereEnabled=false;fire.depthOcclusion=true;runtime.setDepthCaptureEnabled(false)});
await page.waitForFunction(()=>runtime.depthCapture.active&&fire.getState().frameIndex===9);await page.waitForTimeout(400);
// Fail immediately if rendering secretly reads back GPU data with the panel disabled.
await page.evaluate(()=>{window.reads=0;const t=runtime.depthCapture.texture;window.originalRead=t.read;t.read=function(...args){window.reads++;return originalRead.apply(this,args)}});
const sequence=await page.evaluate(()=>runtime.depthCapture.gpuSequence);await page.waitForTimeout(700);
const cadence=await page.evaluate(s=>({frames:runtime.depthCapture.gpuSequence-s,reads:window.reads,cpuFrame:runtime.getLatestDepthFrame()}),sequence);
if(cadence.frames<20||cadence.reads!==0||cadence.cpuFrame!==null)throw Error('GPU path not independent '+JSON.stringify(cadence));
const mismatches=await page.evaluate(()=>new Promise(resolve=>{
 let frames=0,wrong=0;const move=()=>{runtime.cameraEntity.setPosition(5.73,1.2,3.39+Math.sin(frames*.15)*.25);runtime.cameraEntity.lookAt(2.92,.612,3.39)};
 const check=()=>{const c=runtime.depthCapture;if(c.gpuCameraWorld.some((v,i)=>Math.abs(v-runtime.cameraEntity.getWorldTransform().data[i])>1e-5))wrong++;if(++frames===30){runtime.app.off('update',move);runtime.app.off('frameend',check);resolve(wrong)}};
 runtime.app.on('update',move);runtime.app.on('frameend',check);
}));if(mismatches)throw Error('Depth lags camera');
await page.evaluate(()=>{runtime.cameraEntity.setPosition(8.609968,2.4,1.200738);runtime.cameraEntity.lookAt(8.609968,3.020080,-1.999262)});await page.waitForTimeout(250);
const on=await page.screenshot({path:out+'/gpu-on.png'});
const mask=await page.evaluate(async()=>{
 const c=runtime.depthCapture;const {decodeGsDepth}=await import('/src/features/gaussian-viewer/depth/gsDepthPreview.ts');const p=c.picker;
 const bytes=await c.texture.read(0,0,c.texture.width,c.texture.height,{immediate:true,renderTarget:p.renderTargetDepth});
 const w=c.texture.width,h=c.texture.height,cam=runtime.cameraEntity.camera;const d=decodeGsDepth(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength),w,h,cam.nearClip,cam.farClip);
 const m=fire.getMetadata(),lo=m.grid.worldLower,hi=m.grid.worldUpper;const lower=[lo[0],lo[2],-hi[1]],upper=[hi[0],hi[2],-lo[1]],origin=runtime.cameraEntity.getPosition(),o=[origin.x,origin.y,origin.z];const forward=runtime.cameraEntity.forward;
 const indices=[];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  if(!d[y*w+x])continue;const r=cam.screenToWorld(x+.5,y+.5,1).sub(origin).normalize();const ray=[r.x,r.y,r.z];let enter=0,exit=1e10;
  for(let j=0;j<3;j++){const a=(lower[j]-o[j])/ray[j],b=(upper[j]-o[j])/ray[j];enter=Math.max(enter,Math.min(a,b));exit=Math.min(exit,Math.max(a,b))}
  if(exit>enter&&d[y*w+x]<1.5)indices.push(y*w+x);
 }
 return indices;
});
await page.evaluate(()=>fire.depthOcclusion=false);await page.waitForTimeout(120);const off=await page.screenshot({path:out+'/gpu-off.png'});
await page.evaluate(()=>fire.setQuality('off'));await page.waitForTimeout(120);const empty=await page.screenshot({path:out+'/no-fire.png'});
const coverage=await page.evaluate(async({on,off,empty,mask})=>{
 async function pixels(b){const i=new Image();i.src='data:image/png;base64,'+b;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,c.width,c.height).data}
 const [a,b,c]=await Promise.all([on,off,empty].map(pixels));let leakedBefore=0,leakedAfter=0;
 for(const index of mask){const i=index*4;const diff=v=>Math.abs(v[i]-c[i])+Math.abs(v[i+1]-c[i+1])+Math.abs(v[i+2]-c[i+2]);if(diff(b)>24)leakedBefore++;if(diff(a)>24)leakedAfter++}
 return {frontPixels:mask.length,leakedBefore,leakedAfter};
},{on:on.toString('base64'),off:off.toString('base64'),empty:empty.toString('base64'),mask});
if(coverage.leakedBefore<50||coverage.leakedAfter>coverage.leakedBefore*.03)throw Error('Real GS foreground clipping failed '+JSON.stringify(coverage));
await page.evaluate(()=>{fire.setQuality('medium');fire.depthOcclusion=true;runtime.resize(960,640,1);runtime.setRobotFirstPerson(true)});await page.waitForTimeout(300);
const resized=await page.evaluate(()=>({width:runtime.depthCapture.texture.width,height:runtime.depthCapture.texture.height,active:runtime.depthCapture.active}));if(resized.width!==960||resized.height!==640||!resized.active)throw Error('GPU depth resize failed');

await page.evaluate(()=>runtime.setDepthCaptureEnabled(true));await page.waitForFunction(()=>runtime.getLatestDepthFrame()!==null);
const preview=await page.evaluate(()=>({width:runtime.getLatestDepthFrame().width,height:runtime.getLatestDepthFrame().height,gpuWidth:runtime.depthCapture.texture.width}));
if(preview.width!==640||preview.gpuWidth!==960)throw Error('Preview changed GPU resolution');
await page.evaluate(async()=>{runtime.setDepthCaptureEnabled(false);await fire.selectVersion('playback-v2');fire.play()});await page.waitForTimeout(400);
if(await page.evaluate(()=>fire.getState().version!=='playback-v2'||!runtime.depthCapture.active))throw Error('V2 GPU depth failed');
await page.evaluate(()=>runtime.unloadScene());await page.waitForTimeout(100);if(await page.evaluate(()=>runtime.depthCapture.active))throw Error('Stale GPU depth');
console.log({cadence,mismatches,coverage,resized,preview,errors});await fs.writeFile(out+'/gpu-verification.json',JSON.stringify({cadence,mismatches,coverage,resized,preview,errors},null,2));await browser.close();if(errors.length)throw Error('Browser errors');

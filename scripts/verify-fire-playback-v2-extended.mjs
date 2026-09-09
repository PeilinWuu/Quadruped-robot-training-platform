import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
import fs from 'node:fs/promises';
const out=process.env.FIRE_QA_OUTPUT ?? 'tmp/fire-v2-results'; await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11','--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');
await page.waitForFunction(()=>window.ready, undefined, {timeout:120000});
console.log('READY',await page.evaluate(()=>({status:window.statusData,gpu:(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})()})));

await page.evaluate(async()=>{await fire.selectVersion('playback-v2');fire.autoQuality=false;fire.depthOcclusion=true;fire.seek(8);fire.play()});
await page.waitForTimeout(1500);
const {spawn}=await import('node:child_process');
const gpu=spawn('nvidia-smi',['--query-gpu=timestamp,memory.used','--format=csv,noheader,nounits','-lms','250'],{windowsHide:true});
let gpuLog='';gpu.stdout.on('data',b=>gpuLog+=b);
let peak=0;const caches=[];
for(let i=0;i<16;i++){
 await page.evaluate(i=>{fire.pause();fire.seek(i)},i);
 await page.waitForFunction(i=>fire.getState().frameIndex===i,i);
 const data=await page.evaluate(()=>({cache:fire.getDiagnostics().cache,vram:runtime.app.graphicsDevice._vram}));
 caches.push(data.cache);peak=Math.max(peak,data.vram.tex+data.vram.vb+data.vram.ib+data.vram.ub+data.vram.sb);
 await page.waitForTimeout(100);
}
await page.evaluate(()=>{window.inputDelays=[];window.inputStart=0;window.addEventListener('keydown',e=>{if(e.key==='w')window.inputStart=performance.now()},{capture:true});robot.onPose(()=>{if(window.inputStart){inputDelays.push(performance.now()-window.inputStart);window.inputStart=0}});document.querySelector('canvas').focus()});
const latency={};
for(const version of ['playback-v1','playback-v2']){
 await page.evaluate(async version=>{await fire.selectVersion(version);fire.play();window.inputDelays=[]},version);
 for(let i=0;i<20;i++){await page.keyboard.down('w');await page.waitForTimeout(60);await page.keyboard.up('w');await page.waitForTimeout(60)}
 latency[version]=await page.evaluate(()=>inputDelays);
}
await page.evaluate(()=>{fire.play();fire.autoQuality=true;fire.setQuality('high');runtime.fireVolume.statsSeconds=0;runtime.fireVolume.statsFrames=0;runtime.fireVolume.slowWindows=0;for(let i=0;i<82;i++)runtime.fireVolume.update(.05)});
const autoMedium=await page.evaluate(()=>fire.quality);
await page.evaluate(()=>{for(let i=0;i<82;i++)runtime.fireVolume.update(.05)});
const autoLow=await page.evaluate(()=>fire.quality);
await page.evaluate(()=>{for(let i=0;i<82;i++)runtime.fireVolume.update(.05)});
await page.waitForFunction(()=>fire.getState().version==='playback-v1'&&fire.getState().playing);
const autoFallback=await page.evaluate(()=>fire.getState());
gpu.kill();await fs.writeFile(out+'/gpu-memory.csv',gpuLog);
const gpuValues=gpuLog.trim().split('\n').map(l=>Number(l.split(',')[1])).filter(Number.isFinite);
await fs.writeFile(out+'/extended.json',JSON.stringify({peakEngineGpuBytes:peak,systemGpuPeakMiB:Math.max(...gpuValues),gpuSampleCount:gpuValues.length,caches,latency,autoMedium,autoLow,autoFallback,errors},null,2));
console.log({peak,systemGpuPeakMiB:Math.max(...gpuValues),autoMedium,autoLow,autoFallback,errors});
await browser.close();

if(autoMedium!=="medium"||autoLow!=="low"||errors.length)throw new Error("Extended validation failed");

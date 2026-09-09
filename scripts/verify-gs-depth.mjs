import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
import fs from 'node:fs/promises';
const out=process.env.FIRE_QA_OUTPUT ?? 'tmp/gs-depth-results'; await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11','--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');
await page.waitForFunction(()=>window.ready, undefined, {timeout:120000});
console.log('READY',await page.evaluate(()=>({status:window.statusData,gpu:(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})()})));



await page.evaluate(()=>{robot.pause();runtime.setDepthCaptureEnabled(true)});
await page.waitForFunction(()=>runtime.getLatestDepthFrame()?.sequence>1,undefined,{timeout:30000});
const results=[];
for(const id of ['table_high','sofa_high','curtain_high']){
 await page.evaluate(async id=>{const {ROOM_FIRE_VIEWS}=await import('/src/services/fire-playback/roomFireScenario.ts');const v=ROOM_FIRE_VIEWS[id];runtime.cameraEntity.setPosition(...v.position);runtime.cameraEntity.lookAt(...v.target)},id);
 await page.waitForTimeout(800);await page.screenshot({path:out+'/'+id+'-rgb.png'});
 const data=await page.evaluate(()=>{
  const f=runtime.getLatestDepthFrame();const c=document.createElement('canvas');c.width=f.width;c.height=f.height;const ctx=c.getContext('2d');const im=ctx.createImageData(f.width,f.height);
  let count=0,min=Infinity,max=0;
  for(let i=0;i<f.values.length;i++){const d=f.values[i];if(d>0){count++;min=Math.min(min,d);max=Math.max(max,d)}const v=d>0?Math.round(255*(1-Math.min(d/12,1))):0;im.data[i*4]=im.data[i*4+1]=im.data[i*4+2]=v;im.data[i*4+3]=255}ctx.putImageData(im,0,0);
  return {png:c.toDataURL(),count,min,max,width:f.width,height:f.height,sequence:f.sequence,center:f.values[Math.floor(f.height/2)*f.width+Math.floor(f.width/2)]}
 });
 await fs.writeFile(out+'/'+id+'-depth.png',Buffer.from(data.png.split(',')[1],'base64'));delete data.png;results.push({id,...data});
}

const extended={};
// Compare whole-frame float decoding with the engine's public point-depth API.
extended.samples=await page.evaluate(async()=>{
 const capture=runtime.depthCapture;const f=capture.frame;const picker=capture.picker;
 runtime.setDepthCaptureEnabled(false); // retain local frame and picker for this check
 const samples=[];
 for(const [x,y] of [[320,180],[180,190],[400,260],[100,80]]){
  const normalized=await picker.getPointDepthAsync(x,y);const camera=runtime.cameraEntity.camera;
  const expected=normalized===null?0:camera.nearClip+normalized*(camera.farClip-camera.nearClip);
  samples.push({x,y,expected,actual:f.values[y*f.width+x]});
 }
 return samples;
});
if(extended.samples.some(s=>Math.abs(s.expected-s.actual)>.001))throw Error('Depth decoding or orientation mismatch');
await page.evaluate(()=>runtime.setDepthCaptureEnabled(true));

await page.waitForFunction(()=>runtime.getLatestDepthFrame()!==null);
const metricStart=await page.evaluate(()=>({time:performance.now(),sequence:runtime.getLatestDepthFrame()?.sequence??0}));
await page.waitForTimeout(1500);
extended.captureHz=await page.evaluate(s=>(runtime.getLatestDepthFrame().sequence-s.sequence)*1000/(performance.now()-s.time),metricStart);
if(extended.captureHz>5.5)throw Error('Capture throttle failed');
const stable=[];for(let i=0;i<4;i++){await page.waitForTimeout(220);stable.push(await page.evaluate(()=>runtime.getLatestDepthFrame().values[180*640+320]))}
extended.stableCenter=stable;if(Math.max(...stable)-Math.min(...stable)>.001)throw Error('Stationary depth unstable');
const threshold=[];
for(const alpha of [.1,.3,.5]){
 await page.evaluate(async a=>{const {gsDepthPreview}=await import('/src/features/gaussian-viewer/depth/gsDepthPreview.ts');gsDepthPreview.alphaClip=a},alpha);
 await page.waitForTimeout(500);
 threshold.push(await page.evaluate(a=>({alpha:a,valid:runtime.getLatestDepthFrame().values.reduce((n,d)=>n+(d>0?1:0),0)}),alpha));
}
extended.threshold=threshold;
if(!(threshold[0].valid>=threshold[1].valid&&threshold[1].valid>=threshold[2].valid))throw Error('Threshold ordering failed');
await page.evaluate(()=>{runtime.resize(960,640,1);runtime.setRobotFirstPerson(true)});await page.waitForTimeout(700);
extended.firstPerson=await page.evaluate(()=>{const f=runtime.getLatestDepthFrame();return {width:f.width,height:f.height,valid:f.values.filter(v=>v>0).length}});
if(extended.firstPerson.width!==640||extended.firstPerson.height!==427)throw Error('Aspect ratio failed');
await page.evaluate(()=>runtime.unloadScene());await page.waitForTimeout(300);
if(await page.evaluate(()=>runtime.getLatestDepthFrame()!==null))throw Error('Stale depth after unload');
console.log(results);await fs.writeFile(out+'/report.json',JSON.stringify({results,extended,errors},null,2));
await browser.close();if(errors.length||results.some(r=>r.count<1000))throw Error('GS depth failed');

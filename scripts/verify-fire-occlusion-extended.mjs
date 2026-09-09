import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
import fs from 'node:fs/promises';
const out=process.env.FIRE_QA_OUTPUT ?? 'tmp/fire-occlusion-results'; await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11','--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');
await page.waitForFunction(()=>window.ready, undefined, {timeout:120000});
console.log('READY',await page.evaluate(()=>({status:window.statusData,gpu:(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})()})));



await page.evaluate(async()=>{await fire.load('/fire-playback/table_high/');fire.seek(38);robot.pause();fire.atmosphereEnabled=false;fire.depthOcclusion=true});
await page.waitForFunction(()=>runtime.fireVolume.proxy.active&&fire.getState().frameIndex===38);
await page.evaluate(async()=>{
 const {Entity}=await import('/node_modules/playcanvas/build/playcanvas/src/index.js');
 const proxy=runtime.fireVolume.proxy;proxy.geometry.enabled=false;
 const box=new Entity('Occlusion QA only',runtime.app);box.addComponent('render',{type:'box',material:proxy.material,layers:[proxy.layer.id]});
 box.setLocalScale(.05,12,12);box.setPosition(4.7,1,3.4);runtime.app.root.addChild(box);window.qaOccluder=box;
});
async function snap(name){await page.waitForTimeout(180);const bytes=await page.screenshot({path:out+'/'+name+'.png'});return bytes.toString('base64')}
const front=await snap('synthetic-front');
await page.evaluate(()=>fire.setQuality('off'));const empty=await snap('synthetic-no-fire');
await page.evaluate(()=>{fire.setQuality('medium');qaOccluder.setPosition(0,1,3.4)});const behind=await snap('synthetic-behind');
await page.evaluate(()=>fire.depthOcclusion=false);const unblocked=await snap('synthetic-unblocked');
const comparisons=await page.evaluate(async({front,empty,behind,unblocked})=>{
 async function pixels(b){const img=new Image();img.src='data:image/png;base64,'+b;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(0,0,c.width,c.height).data}
 const [a,b,c,d]=await Promise.all([front,empty,behind,unblocked].map(pixels));
 function diff(a,b){let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>12)n++;return n}
 return {frontVsNoFire:diff(a,b),behindVsUnblocked:diff(c,d),visibleFirePixels:diff(b,d)};
},{front,empty,behind,unblocked});
if(comparisons.frontVsNoFire>100||comparisons.behindVsUnblocked>100||comparisons.visibleFirePixels<500)throw Error(JSON.stringify(comparisons));
await page.evaluate(()=>{qaOccluder.destroy();runtime.fireVolume.proxy.geometry.enabled=true;fire.depthOcclusion=true});
for(let i=0;i<5;i++){
 await page.evaluate(i=>{const c=runtime.cameraEntity;c.setPosition(5.73-i*.3,1.2+i*.12,3.39+i*.35);c.lookAt(2.92,.8,3.39);c.camera.fov=50+i*5},i);
 await snap('moving-'+i);
}
await page.evaluate(()=>{runtime.resize(960,640,1);runtime.setRobotFirstPerson(true)});await snap('first-person');
const size=await page.evaluate(()=>({w:runtime.fireVolume.proxy.texture.width,h:runtime.fireVolume.proxy.texture.height}));if(size.w!==960||size.h!==640)throw Error('Depth resize failed');
await page.route('**/proxy-smooth.bin',r=>r.fulfill({status:404,body:''}));await page.reload();await page.waitForFunction(()=>window.ready);
await page.evaluate(()=>fire.load('/fire-playback/table_high/'));await page.waitForFunction(()=>fire.depthStatus==='unavailable');
const failure=await page.evaluate(()=>({visible:runtime.fireVolume.entity.enabled,status:fire.depthStatus}));if(!failure.visible)throw Error('Failed depth disabled playback');
await fs.writeFile(out+'/extended.json',JSON.stringify({comparisons,size,failure,errors},null,2));
console.log({comparisons,size,failure,errors});await browser.close();
if(errors.some(e=>!e.includes('404')))throw Error('Browser errors');

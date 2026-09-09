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

const metrics=[];
async function measure(name,seconds=3){
  const value=await page.evaluate(seconds=>new Promise(resolve=>{
    const app=runtime.app;const started=performance.now();const times=[];let previous=started;
    const cb=()=>{const now=performance.now();times.push(now-previous);previous=now;
      if(now-started>=seconds*1000){app.off('frameend',cb);times.sort((a,b)=>a-b);
        resolve({fps:times.length*1000/(now-started),p95FrameMs:times[Math.floor(times.length*.95)],
          diagnostics:fire.getDiagnostics(),gpuResources:app.graphicsDevice._vram,depthActive:runtime.fireVolume.proxy?.active??false})}}
    app.on('frameend',cb)
  }),seconds);metrics.push({name,...value});console.log('METRIC',name,value.fps);
}
for(const quality of ['off','v1','low','medium','high']){
  await page.evaluate(async quality=>{
    nativeCamera();fire.autoQuality=false;fire.depthOcclusion=false;
    await fire.selectVersion(quality==='v1'?'playback-v1':'playback-v2');
    fire.setQuality(['v1','off'].includes(quality)?(quality==='off'?'off':'medium'):quality);
    fire.seek(quality==='v1'?38:8)
  },quality);
  await page.waitForTimeout(1200);
  await page.screenshot({path:out+'/'+quality+'.png'});
  await page.evaluate(()=>fire.play());await measure(quality,4);
}
await page.evaluate(async()=>{await fire.selectVersion('playback-v2');fire.setQuality('medium');fire.depthOcclusion=true;fire.seek(8)});
await page.waitForTimeout(2500);await page.screenshot({path:out+'/medium-depth.png'});
await page.evaluate(()=>fire.play());await measure('medium-depth',4);
const checks={};
await page.evaluate(()=>{fire.pause();window.paused=fire.getState().frameIndex});
await page.waitForTimeout(300);checks.pause=await page.evaluate(()=>paused===fire.getState().frameIndex);
await page.evaluate(()=>fire.reset());await page.waitForFunction(()=>fire.getState().frameIndex===0);checks.reset=true;
await page.evaluate(()=>fire.play());await page.waitForFunction(()=>fire.getState().frameIndex>0);checks.play=true;
const pose=()=>page.evaluate(()=>({position:runtime.cameraEntity.getPosition().toArray(),rotation:runtime.cameraEntity.getRotation().toArray()}));
for(const button of ['left','right']){
 const before=await pose();await page.mouse.move(600,420);await page.mouse.down({button});await page.mouse.move(740,470,{steps:10});await page.mouse.up({button});
 const after=await pose();checks[button==='left'?'orbit':'pan']=JSON.stringify(before)!==JSON.stringify(after);
}
const beforeZoom=await pose();await page.mouse.wheel(0,160);await page.waitForTimeout(100);checks.zoom=JSON.stringify(beforeZoom)!==JSON.stringify(await pose());
await measure('free-view-after-movement',3);
await page.evaluate(()=>{window.lastPose=null;robot.onPose(p=>{window.lastPose=p});document.querySelector('canvas').focus()});
for(const key of ['w','s','a','d','q','e']){
 const before=await page.evaluate(()=>({position:lastPose.rootPosition,rotation:lastPose.rootOrientation}));
 await page.keyboard.down(key);await page.waitForTimeout(250);await page.keyboard.up(key);
 const after=await page.evaluate(()=>({position:lastPose.rootPosition,rotation:lastPose.rootOrientation}));checks['key-'+key]=JSON.stringify(before)!==JSON.stringify(after);
}
await page.evaluate(()=>{robot.x=5.7;robot.y=-3.39;robot.yaw=Math.PI;robot.play()});await page.waitForTimeout(100);
checks.firstPerson=await page.evaluate(()=>runtime.setRobotFirstPerson(true));await page.waitForTimeout(300);
await measure('first-person-medium-depth',4);await page.screenshot({path:out+'/first-person.png'});
const fpBefore=await pose();await page.keyboard.down('w');await page.waitForTimeout(300);await page.keyboard.up('w');checks.headFollow=JSON.stringify(fpBefore)!==JSON.stringify(await pose());
checks.cameraIdentity=await page.evaluate(()=>runtime.fireVolume.camera===runtime.cameraEntity);
checks.switchRepeated=await page.evaluate(()=>{for(let i=0;i<6;i++){if(!runtime.setRobotFirstPerson(false)||!runtime.setRobotFirstPerson(true))return false}return runtime.setRobotFirstPerson(false)});
await page.evaluate(()=>{nativeCamera();fire.depthOcclusion=false;fire.setQuality('medium')});
const movingMeasure=measure('free-orbit-in-motion-medium',4);
for(let i=0;i<3;i++){await page.mouse.move(600,400);await page.mouse.down();await page.mouse.move(670,430,{steps:15});await page.mouse.up();await page.waitForTimeout(150)}
await movingMeasure;
await page.evaluate(()=>{window.inputDelays=[];window.inputStart=0;window.addEventListener('keydown',e=>{if(e.key==='w')window.inputStart=performance.now()},{capture:true});robot.onPose(p=>{if(window.inputStart){inputDelays.push(performance.now()-window.inputStart);window.inputStart=0}})});
for(let i=0;i<10;i++){await page.keyboard.down('w');await page.waitForTimeout(70);await page.keyboard.up('w');await page.waitForTimeout(70)}
checks.inputLatencyMs=await page.evaluate(()=>inputDelays);
await page.route('**/fire-playback-v2/**/metadata.json',route=>route.fulfill({status:404,body:'test failure'}));
await page.evaluate(()=>fire.selectVersion('playback-v2'));checks.fallback=await page.evaluate(()=>fire.getState());
const unexpectedErrors = errors.filter(error => !error.includes('404 (Not Found)'));
const failedChecks = Object.entries(checks).filter(([, value]) => value === false).map(([key]) => key);
if (checks.fallback.version !== 'playback-v1' || !checks.fallback.playing) failedChecks.push('fallback');
if (metrics.find(m => m.name === 'medium').fps < 30) failedChecks.push('medium-fps');
const report={metrics,checks,errors,failedChecks};await fs.writeFile(out+'/benchmark.json',JSON.stringify(report,null,2));console.log('CHECKS',checks,'ERRORS',errors);
await browser.close();
if (failedChecks.length || unexpectedErrors.length) throw new Error(JSON.stringify({failedChecks,unexpectedErrors}));

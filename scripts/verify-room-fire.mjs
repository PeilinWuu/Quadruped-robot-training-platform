import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
import fs from 'node:fs/promises';
const out=process.env.FIRE_QA_OUTPUT ?? 'tmp/room-fire-results'; await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11','--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');
await page.waitForFunction(()=>window.ready, undefined, {timeout:120000});
console.log('READY',await page.evaluate(()=>({status:window.statusData,gpu:(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})()})));


await page.evaluate(async()=>{await fire.setSceneMode('room');fire.reset();fire.play()});
await page.waitForTimeout(5500);
const states=await page.evaluate(()=>({primary:fire.getState(),companions:[...fire.getCompanions()].map(([id,s])=>({id,state:s.getState(),cache:s.getDiagnostics().cache})),volumes:runtime.fireVolume.companionVolumes.size}));
console.log('STATES',states);
const metrics=[];
for(const id of ['table_high','sofa_high','curtain_high']){
 await page.evaluate(id=>fire.focusFire(id),id);await page.waitForTimeout(1200);
 await page.screenshot({path:out+'/'+id+'.png'});
 metrics.push(await page.evaluate(id=>new Promise(resolve=>{const start=performance.now();let n=0;const cb=()=>{n++;if(performance.now()-start>=3000){runtime.app.off('frameend',cb);resolve({id,fps:n*1000/(performance.now()-start)})}};runtime.app.on('frameend',cb)}),id));
}
const paused=await page.evaluate(()=>{fire.pause();return [fire,...fire.getCompanions().values()].map(s=>s.getState().frameIndex)});await page.waitForTimeout(300);
const pauseCheck=await page.evaluate(p=>JSON.stringify(p)===JSON.stringify([fire,...fire.getCompanions().values()].map(s=>s.getState().frameIndex)),paused);
await page.evaluate(()=>fire.reset());await page.waitForFunction(()=>[fire,...fire.getCompanions().values()].every(s=>s.getState().frameIndex===0));
await page.evaluate(()=>fire.play());
await page.mouse.move(620,400);await page.mouse.down();await page.mouse.move(700,440,{steps:10});await page.mouse.up();
await page.evaluate(()=>document.querySelector('canvas').focus());await page.keyboard.down('w');await page.waitForTimeout(300);await page.keyboard.up('w');
const fp=await page.evaluate(()=>runtime.setRobotFirstPerson(true));await page.waitForTimeout(300);await page.evaluate(()=>runtime.setRobotFirstPerson(false));
await page.evaluate(()=>fire.setSceneMode('single'));await page.waitForTimeout(200);
const cleanup=await page.evaluate(()=>({services:fire.getCompanions().size,volumes:runtime.fireVolume.companionVolumes.size,stillPlaying:fire.getState().playing}));
console.log('RESULT',{metrics,pauseCheck,fp,cleanup,errors});await fs.writeFile(out+'/report.json',JSON.stringify({states,metrics,pauseCheck,fp,cleanup,errors},null,2));
await browser.close();if(errors.length||!pauseCheck||!fp||cleanup.services||cleanup.volumes)throw Error('Room fire test failed');

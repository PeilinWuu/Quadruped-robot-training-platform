import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
import fs from 'node:fs/promises';
const out=process.env.FIRE_QA_OUTPUT ?? 'tmp/curtain-surface-results'; await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11','--disable-background-timer-throttling']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');
await page.waitForFunction(()=>window.ready, undefined, {timeout:120000});
console.log('READY',await page.evaluate(()=>({status:window.statusData,gpu:(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})()})));




await page.evaluate(async()=>{await fire.load('/fire-playback-room/curtain_high/');fire.pause();robot.pause();fire.seek(9);fire.atmosphereEnabled=false;runtime.cameraEntity.setPosition(8.609968,2.4,1.200738);runtime.cameraEntity.lookAt(8.609968,3.020080,-1.999262)});
await page.waitForFunction(()=>fire.getState().frameIndex===9&&runtime.depthCapture.active);
for(const offset of [0,.05,.1,.15]){await page.evaluate(o=>fire.curtainSurfaceOffset=o,offset);await page.waitForTimeout(250);await page.screenshot({path:out+'/offset-'+offset+'.png'})}
for(const [name,x] of [['left',7.8],['right',9.2]]){await page.evaluate(x=>{fire.curtainSurfaceOffset=.1;runtime.cameraEntity.setPosition(x,1.8,.8);runtime.cameraEntity.lookAt(8.6,2,-2)},x);await page.waitForTimeout(300);await page.screenshot({path:out+'/'+name+'.png'})}
console.log({errors});await browser.close();if(errors.length)throw Error('Browser errors');

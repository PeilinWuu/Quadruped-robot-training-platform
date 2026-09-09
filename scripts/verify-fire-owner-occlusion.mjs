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



await page.evaluate(async()=>{await fire.setSceneMode('room');fire.pause();robot.pause();fire.atmosphereEnabled=false;fire.focusFire('curtain_high');const c=fire.getCompanions().get('curtain_high');c.seek(9)});
await page.waitForFunction(()=>runtime.fireVolume.companionVolumes.get(fire.getCompanions().get('curtain_high')).emitterDepth.active);
await page.evaluate(()=>{window.curtainDepth=runtime.fireVolume.companionVolumes.get(fire.getCompanions().get('curtain_high')).emitterDepth;curtainDepth.material.setParameter('uExcludeCurtain',0)});
await page.waitForTimeout(250);await page.screenshot({path:out+'/curtain-self-clipped.png'});
await page.evaluate(()=>curtainDepth.material.setParameter('uExcludeCurtain',1));await page.waitForTimeout(250);await page.screenshot({path:out+'/curtain-owner-aware.png'});
await page.evaluate(async()=>{const {Entity}=await import('/node_modules/playcanvas/build/playcanvas/src/index.js');const b=new Entity('External foreground QA',runtime.app);b.addComponent('render',{type:'box',material:curtainDepth.material,layers:[curtainDepth.layer.id]});b.setLocalScale(20,20,.05);b.setPosition(8.6,2,0);runtime.app.root.addChild(b);window.blocker=b});
await page.waitForTimeout(250);const a=(await page.screenshot()).toString('base64');
await page.evaluate(()=>fire.getCompanions().get('curtain_high').pause());
await page.evaluate(()=>{const v=runtime.fireVolume.companionVolumes.get(fire.getCompanions().get('curtain_high'));v.entity.render.enabled=false});
await page.waitForTimeout(250);const b=(await page.screenshot()).toString('base64');
const difference=await page.evaluate(async({a,b})=>{async function pixels(s){const i=new Image();i.src='data:image/png;base64,'+s;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,c.width,c.height).data}const [x,y]=await Promise.all([pixels(a),pixels(b)]);let n=0;for(let i=0;i<x.length;i+=4)if(Math.abs(x[i]-y[i])+Math.abs(x[i+1]-y[i+1])+Math.abs(x[i+2]-y[i+2])>12)n++;return n},{a,b});
if(difference>50)throw Error('External blocker leaked '+difference);
console.log({externalBlockerDifference:difference,errors});await fs.writeFile(out+'/owner-aware.json',JSON.stringify({externalBlockerDifference:difference,errors},null,2));await browser.close();if(errors.length)throw Error('Browser error');

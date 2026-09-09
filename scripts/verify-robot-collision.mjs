import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const out='tmp/robot-collision-results';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:720}}), errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/gs/local/v2-qa.sog',route=>route.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
 await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');await page.waitForFunction(()=>window.ready,undefined,{timeout:120000});
 const report=await page.evaluate(async()=> {
  const collision=(await import(performance.getEntriesByType('resource').find(entry=>entry.name.includes('/src/services/robot-collision/robotCollisionService.ts')).name)).robotCollisionService;
  window.collision=collision;collision.setDebug(true);fire.pause();fire.quality='off';robot.pause();
  runtime.setRobotFirstPerson(false);runtime.cameraEntity.setPosition(5,2.6,.4);runtime.cameraEntity.lookAt(3,.6,-2.5);
  robot.x=3;robot.y=1.7;robot.yaw=0;robot.play();robot.setControlInput(0,1);
  for(let i=0;i<100;i++)robot.update(.1);
  const stopped={x:robot.x,y:robot.y,blocked:collision.blocked,phase:robot.phase};
  robot.setControlInput(1,1);for(let i=0;i<10;i++)robot.update(.1);
  const slid={x:robot.x,y:robot.y};
  robot.setControlInput(0,-1);for(let i=0;i<10;i++)robot.update(.1);
  const retreated={x:robot.x,y:robot.y};
  collision.setEnabled(false);robot.setControlInput(0,1);for(let i=0;i<60;i++)robot.update(.1);
  const disabled={y:robot.y};
  collision.setEnabled(true);robot.pause();robot.x=3;robot.y=stopped.y;robot.emit();
  return {stopped,slid,retreated,disabled,active:collision.sceneAvailable,boxes:collision.boxes.length};
 });
 assert(report.active);assert(report.stopped.blocked);assert(report.stopped.y<2.24 && report.stopped.y>2.2);assert.equal(report.stopped.phase,0);
 assert(report.slid.x>report.stopped.x+.2);assert(Math.abs(report.slid.y-report.stopped.y)<.005);
 assert(report.retreated.y<report.stopped.y-.2);assert(report.disabled.y>2.6);
 await page.waitForTimeout(250);await page.screenshot({path:out+'/wall-debug.png'});
 const turning=await page.evaluate(()=> {
  robot.x=3;robot.y=2.22;robot.yaw=0;robot.play();robot.setControlInput(0,0,1);
  for(let i=0;i<100;i++)robot.update(.1);robot.pause();
  return {yaw:robot.yaw,blocked:collision.blocked};
 });
 assert(turning.blocked);assert(Math.abs(turning.yaw)<.1);
 const table=await page.evaluate(()=> {
  runtime.setRobotCalibration({translation:[0,0,0],rotation:[0,0,0,1],scale:1});
  robot.x=4.6;robot.y=-3.3937656;robot.yaw=Math.PI;robot.play();robot.setControlInput(1,0);
  for(let i=0;i<100;i++)robot.update(.1);
  const result={x:robot.x,blocked:collision.blocked};robot.pause();
  runtime.cameraEntity.setPosition(5.7,1.3,4.7);runtime.cameraEntity.lookAt(3.5,.4,3.4);
  return result;
 });
 assert(table.blocked?.includes('桌'));assert(table.x>3.4);
 await page.waitForTimeout(250);await page.screenshot({path:out+'/table-debug.png'});
 const calibrated=await page.evaluate(()=> {
  runtime.setRobotCalibration({translation:[1,0,0],rotation:[0,0,0,1],scale:1.2});
  robot.x=(3-1)/1.2;robot.y=1.4;robot.yaw=0;robot.play();robot.setControlInput(0,1);for(let i=0;i<100;i++)robot.update(.1);robot.pause();
  return {sceneY:robot.y*1.2,blocked:collision.blocked};
 });
 assert(calibrated.blocked);assert(calibrated.sceneY<report.stopped.y);
 await page.evaluate(()=>runtime.unloadScene());assert(await page.evaluate(()=>!collision.sceneAvailable));
 assert.equal(errors.length,0,errors.join('\n'));
 await fs.writeFile(out+'/report.json',JSON.stringify({...report,turning,table,calibrated,errors},null,2));console.log({...report,turning,table,calibrated,errors});
} finally {await browser.close()}

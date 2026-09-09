import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const out='tmp/step-demo-results';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-gpu','--use-angle=d3d11']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/gs/local/v2-qa.sog',r=>r.fulfill({path:'D:/interiorgs_data/office_01/scene_yup.sog',contentType:'application/octet-stream'}));
 await page.goto('http://localhost:5173/tools/fire-playback-v2/fixture.html');await page.waitForFunction(()=>window.ready&&runtime.robotOverlay.rig.status.phase==='ready',undefined,{timeout:120000});
 await page.evaluate(async()=> {
  robot.pause();fire.pause();fire.quality='off';
  const url=performance.getEntriesByType('resource').find(e=>e.name.includes('/src/services/step-demo/stepDemoService.ts')).name;
  window.demo=(await import(url)).stepDemoService;
  const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  const {StepDemoControls}=await import('/src/components/StepDemoControls.tsx');
  const link=document.createElement('link');link.rel='stylesheet';link.href='/src/App.css';document.head.append(link);
  const container=document.createElement('div');container.style='position:absolute;bottom:5px;left:5px;right:5px;z-index:10;background:#071925;color:white;padding:8px';document.body.append(container);
  createRoot(container).render(React.createElement(StepDemoControls));
  runtime.setRobotCalibration({translation:[1,.02,0],rotation:[0,0,0,1],scale:1.1});
 });
 await page.getByRole('button',{name:'查看台阶样例',exact:true}).click();
 await page.waitForFunction(()=>demo.enabled);
 const report={};
 for(const [mode,label] of [['lower','台阶下'],['straddle','跨台阶'],['upper','台阶上']]) {
  await page.getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(150);
  report[mode]=await page.evaluate(()=> {
   const Vec=runtime.cameraEntity.getPosition().constructor,solution=demo.solve(),rig=runtime.robotOverlay.rig;
   const actual=['FL','FR','RL','RR'].map(name=>{
    const p=rig.primitive.skeleton.bodyNodes.get(name+'_calf').getWorldTransform().transformPoint(new Vec(0,-.213,0));return[p.x,p.y,p.z];
   });
   return {actual,targets:solution.targets,root:solution.root,maxError:Math.max(...actual.map((v,i)=>Math.hypot(...v.map((n,k)=>n-solution.targets[i][k]))))};
  });
  assert(report[mode].maxError<.001,'Rendered skeleton does not match target contacts');
  await page.screenshot({path:out+'/'+mode+'.png'});
 }
 await page.getByRole('button',{name:'跨台阶',exact:true}).click();
 await page.getByLabel('台阶高度厘米').fill('18');await page.getByLabel('台阶高度厘米').blur();
 assert(await page.evaluate(()=>Math.abs(demo.rise-.18)<1e-8));
 const frozen=await page.evaluate(()=>{const before=[robot.x,robot.y,robot.yaw];robot.play();robot.setControlInput(1,1,1);for(let i=0;i<20;i++)robot.update(.1);return{before,after:[robot.x,robot.y,robot.yaw]}});
 assert.deepEqual(frozen.before,frozen.after);
 await page.getByRole('button',{name:'退出站立样例'}).click();
 const restored=await page.evaluate(()=>({scale:runtime.robotOverlay.alignmentRoot.getLocalScale().x,x:runtime.robotOverlay.alignmentRoot.getLocalPosition().x,enabled:demo.enabled,override:robot.poseOverride,playing:robot.getState().playing}));
 assert.equal(restored.scale,1.1);assert.equal(restored.x,1);assert.equal(restored.enabled,false);assert.equal(restored.override,null);assert.equal(restored.playing,false);
 await page.getByRole('button',{name:'查看台阶样例',exact:true}).click();await page.evaluate(()=>runtime.unloadScene());
 assert(await page.evaluate(()=>!demo.enabled&&robot.poseOverride===null));
 assert.equal(errors.length,0,errors.join('\n'));
 await fs.writeFile(out+'/report.json',JSON.stringify({report,frozen,restored,errors},null,2));console.log({report,restored,errors});
} finally {await browser.close()}

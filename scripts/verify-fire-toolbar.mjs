import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:960}});
await page.route('**/api/auth/me',r=>r.fulfill({json:{user:{id:1,username:'layout-test',displayName:'Layout Test',email:'test@example.invalid',role:'user'}}}));
await page.goto('http://localhost:5173/');await page.getByRole('toolbar',{name:'火焰播放'}).waitFor();
const results=[];
for(const width of [1180,1440,1920]){
 await page.setViewportSize({width,height:960});
 for(const scroll of [0,300]){
  await page.evaluate(y=>window.scrollTo(0,y),scroll);await page.waitForTimeout(200);
  const result=await page.evaluate(()=>{
   const bar=document.querySelector('.fire-playback-controls'),tool=document.querySelector('.sim-toolbar'),view=document.querySelector('.sim-viewport');
   const b=bar.getBoundingClientRect(),t=tool.getBoundingClientRect(),v=view.getBoundingClientRect();
   const controls=[...bar.querySelectorAll('select,button,input')].filter(e=>!e.disabled);
   return {scrollY:window.scrollY,barY:b.y,barHeight:b.height,toolbarHeight:t.height,viewY:v.y,insideToolbar:b.top>=t.top&&b.bottom<=t.bottom,
    allClickable:controls.every(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e})};
  });
  results.push({width,scroll,...result});
  if(!result.insideToolbar||!result.allClickable||result.barY<0)throw Error(JSON.stringify(results));
 }
}
await page.setViewportSize({width:1440,height:960});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'tmp/fire-toolbar-fixed.png'});
await page.getByLabel('火焰播放版本').selectOption('playback-v2');await page.getByRole('button',{name:'播放火焰',exact:true}).waitFor();
await page.getByRole('button',{name:'播放火焰',exact:true}).click();await page.getByRole('button',{name:'暂停火焰',exact:true}).waitFor();
console.log(JSON.stringify(results,null,2));console.log('V2 load and play controls passed');await browser.close();

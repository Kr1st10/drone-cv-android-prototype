// Native browser Fullscreen API, including permissions-policy denial. No fullscreen API mocks.
import {createRequire} from 'node:module';
import path from 'node:path';import fs from 'node:fs/promises';import http from 'node:http';import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.env.PLAYWRIGHT_NODE_DIR||process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]), headed=process.env.HEADED==='1';
const server=http.createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://localhost');const file=path.join(root,decodeURIComponent(url.pathname));
 if(url.searchParams.has('deny'))res.setHeader('Permissions-Policy','fullscreen=()');
 res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'image/jpeg');res.end(await fs.readFile(file));}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:!headed,executablePath:process.env.CHROMIUM});
const traces=[];
try{
 const context=await browser.newContext(headed?{viewport:null}:{viewport:{width:1280,height:900},deviceScaleFactor:2});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(simulateWorkArea=>{
  // OS work area can change while the physical display and CSS-pixel scale stay the same.
  const height=screen.availHeight;let exitAnimation=false;
  if(simulateWorkArea){
   Object.defineProperty(screen,'availHeight',{configurable:true,get:()=>document.fullscreenElement||exitAnimation?height+1:height});
   document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement){exitAnimation=true;setTimeout(()=>exitAnimation=false,500);}},true);
  }
  window.nativeEvents=[];for(const name of ['fullscreenchange','fullscreenerror','resize'])addEventListener(name,()=>nativeEvents.push({name,time:performance.now(),fullscreen:!!document.fullscreenElement,availHeight:screen.availHeight}),true);
 },process.env.NATIVE_ENV!=='1');
 const url=`http://127.0.0.1:${server.address().port}/gallery.html`;
 async function setup(p,address){await p.goto(address);await p.click('[data-section=reference]');await p.click('#screenCalibBtn');await p.fill('#screenLineCm','10');await p.click('#applyScreenCalib');await p.keyboard.press('Escape');await p.fill('#distance','400');await p.fill('#referenceScaleNumber','10');await p.waitForFunction(()=>referenceTab.snapshot().load_state==='ready');}
 await setup(page,url);
 if(headed){await page.bringToFront();const {execFileSync}=await import('node:child_process');execFileSync('osascript',['-e','tell application "Google Chrome" to activate']);await page.waitForTimeout(300);}
 const snap=()=>page.evaluate(()=>referenceTab.snapshot());const initialCal=(await snap()).calibration_id;
 for(const scale of ['1','10','20','1','10']){
  await page.fill('#referenceScaleNumber',scale);const before=await snap();assert.ok(before.equivalent_distance_m>0);
  await page.click('#referenceTrial');
  // On the original PR code, changed work area irreversibly invalidates cal and exits here.
  await page.waitForTimeout(100);assert.equal((await snap()).calibration_id,initialCal,'OS work-area change must not invalidate physical calibration');
  await page.waitForFunction(()=>document.fullscreenElement?.id==='referenceViewport'&&referenceTab.snapshot().trial_phase==='active');
  assert.equal((await snap()).equivalent_distance_m,before.equivalent_distance_m);assert.equal((await snap()).image_width_css_px,before.image_width_css_px);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement&&referenceTab.snapshot().trial_phase==='idle');
  const after=await snap();assert.equal(after.calibration_id,initialCal);assert.equal(after.equivalent_distance_m,before.equivalent_distance_m);assert.equal(after.screen_distance_cm,400);assert.equal(after.scale_percent,Number(scale));
 }
 // Native fullscreenchange can precede stable layout; a brief clipped rect must not stop entry.
 await page.addStyleTag({content:'#referenceViewport:fullscreen.pending-layout #referenceDisplay{width:10000px!important}'});
 await page.evaluate(()=>{const v=document.getElementById('referenceViewport');v.addEventListener('fullscreenchange',()=>{if(document.fullscreenElement===v){v.classList.add('pending-layout');window.transientFullscreenWidth=document.getElementById('referenceDisplay').getBoundingClientRect().width;setTimeout(()=>v.classList.remove('pending-layout'),120);}}, {once:true});});
 await page.click('#referenceTrial');await page.waitForFunction(()=>referenceTab.snapshot().trial_phase==='active');assert.equal((await snap()).calibration_id,initialCal);assert.ok(await page.evaluate(()=>transientFullscreenWidth>=9999));
 await page.keyboard.press('Escape');await page.waitForFunction(()=>referenceTab.snapshot().trial_phase==='idle');
 // Stable clipping still stops the experiment after transition settling; numbers/calibration survive.
 await page.addStyleTag({content:'#referenceViewport:fullscreen.stable-clipping #referenceDisplay{width:10000px!important}'});
 await page.locator('#referenceViewport').evaluate(e=>e.classList.add('stable-clipping'));
 await page.click('#referenceTrial');await page.waitForFunction(()=>!document.fullscreenElement&&referenceTab.snapshot().trial_phase==='idle'&&document.getElementById('referenceTargetStatus').textContent.includes('обрезан фактической'));
 assert.equal((await snap()).calibration_id,initialCal);assert.ok((await snap()).equivalent_distance_m>0);
 await page.locator('#referenceViewport').evaluate(e=>e.classList.remove('stable-clipping'));
 // Real browser refusal: policy denies the real requestFullscreen(), no mock rejection.
 const denied=await context.newPage();await setup(denied,url+'?deny=1');const saved=await denied.evaluate(()=>referenceTab.snapshot());
 if(headed){await denied.bringToFront();}
 await denied.click('#referenceTrial');await denied.waitForFunction(()=>referenceTab.snapshot().trial_phase==='idle');
 assert.equal(await denied.evaluate(()=>!!document.fullscreenElement),false);assert.match(await denied.textContent('#referenceTargetStatus'),/Браузер не разрешил/);
 const afterDenied=await denied.evaluate(()=>referenceTab.snapshot());assert.equal(afterDenied.calibration_id,saved.calibration_id);assert.equal(afterDenied.equivalent_distance_m,saved.equivalent_distance_m);
 // A genuine pixel-scale change is still rejected; the saved calibration and inputs survive.
 await page.bringToFront();
 if(headed){const {execFileSync}=await import('node:child_process');execFileSync('osascript',['-e','tell application "Google Chrome" to activate']);}
 const stored=await page.evaluate(()=>localStorage.getItem('dronecv66v2.screen_calibration'));assert.ok(JSON.parse(stored).mm_per_css_px>0);
 await page.click('#referenceTrial');await page.waitForFunction(()=>referenceTab.snapshot().trial_phase==='active');
 await page.evaluate(()=>{const old=devicePixelRatio;Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>old+1});dispatchEvent(new Event('resize'));});
 await page.waitForFunction(()=>!document.fullscreenElement&&referenceTab.snapshot().trial_phase==='idle');
 assert.equal((await snap()).calibration_id,null);assert.equal((await snap()).screen_distance_cm,400);assert.match(await page.textContent('#referenceTargetStatus'),/повторная калибровка/);
 assert.equal(await page.evaluate(()=>localStorage.getItem('dronecv66v2.screen_calibration')),stored);
 traces.push({headed,unmodifiedWorkArea:process.env.NATIVE_ENV==='1',browser:browser.version(),events:await page.evaluate(()=>nativeEvents),cycles:5,denialPreserved:true});assert.deepEqual(errors,[]);
 if(process.env.TRACE_FILE)await fs.writeFile(process.env.TRACE_FILE,JSON.stringify(traces,null,2));
 console.log(JSON.stringify(traces));await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r));}

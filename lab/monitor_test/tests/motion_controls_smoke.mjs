// Browser controls/geometry tests use synthetic timing, not camera measurements.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2,acceptDownloads:true}),errors=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{let now=0,next=1;const callbacks=new Map();window.requestAnimationFrame=fn=>{const key=next++;callbacks.set(key,fn);return key;};window.cancelAnimationFrame=id=>callbacks.delete(id);window.advanceControls=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};});
const tick=ms=>page.evaluate(ms=>advanceControls(ms),ms);
const clean=()=>page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled&&document.getElementById('motionCanvas').width===0,null,{polling:50});
async function start(button='#motionStart'){await page.click(button);await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});}
async function finish(){for(let i=0;i<1200;i++){if(!(await page.evaluate(()=>!!document.fullscreenElement)))break;await tick(100);}await clean();}
async function download(button){const [d]=await Promise.all([page.waitForEvent('download'),page.click(button)]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));}
const overlap=(a,b)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
const rect=([x,y,w,h])=>[x,y,x+w,y+h];
function checkGeometry(run,button){
  const a=run.scenario.workspace,tags=run.calibration_markers.map(t=>rect([t.x,t.y,t.size,t.size])),sync=rect(run.sync_backing),inside=b=>b[0]>=a.x&&b[1]>=a.y&&b[2]<=a.x+a.width&&b[3]<=a.y+a.height;
  assert.ok(inside(button));assert.ok(inside(sync));assert.ok(tags.every(inside));
  for(const b of [...tags,sync])assert.equal(overlap(button,b),false,'Stop covers a marker');
  for(const s of run.samples)if(s.image_rect_px){assert.ok(inside(s.image_rect_px));for(const b of [...tags,sync,button])assert.equal(overlap(s.image_rect_px,b),false,'photo covers a reserved object');}
}
async function focus(id){await page.locator('#'+id).focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');return page.evaluate(id=>{const e=document.getElementById(id),s=getComputedStyle(e);return {focused:document.activeElement===e,visible:e.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth};},id);}
try{
  await page.goto('file://'+path.join(root,'gallery.html'));await page.waitForFunction(()=>/Изображений: 90/.test(document.getElementById('status').textContent),null,{polling:100});await page.click('[data-section=motion]');
  await page.selectOption('#motionPhoto','civ01');const m=await page.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ01'));
  await page.click('#motionBounds');for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await page.fill('#'+id,String(m.object_bbox[i]));await page.click('#saveBounds');
  const detail=page.locator('#motionWorkspace');await detail.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await detail.getAttribute('open'),'');
  const changed={motionAreaX:'12',motionAreaY:'10',motionAreaWidth:'76',motionAreaHeight:'80',motionTagSize:'72',motionSyncSize:'8'};
  for(const [id,value] of Object.entries(changed))await page.fill('#'+id,value);
  await page.reload();await page.click('[data-section=motion]');await page.waitForFunction(()=>!document.getElementById('motionStart').disabled,null,{polling:50});
  for(const [id,value] of Object.entries(changed))assert.equal(await page.inputValue('#'+id),value);
  const focusStart=await focus('motionStart');assert.equal(focusStart.focused,true);assert.equal(focusStart.visible,true);assert.equal(focusStart.outline,'solid');assert.equal(focusStart.width,'3px');
  const colors=await page.evaluate(()=>{const s=getComputedStyle(document.getElementById('motionStart'));return {fg:s.color,bg:s.backgroundColor};});assert.equal(colors.bg,'rgb(23, 107, 55)');assert.equal(colors.fg,'rgb(255, 255, 255)');
  const linear=c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;},luminance=rgb=>rgb.reduce((v,c,i)=>v+linear(c)*[.2126,.7152,.0722][i],0),contrast=1.05/(luminance([23,107,55])+.05);assert.ok(contrast>=4.5);
  // Start is activated with the keyboard, preserving a real fullscreen user gesture.
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});await tick(0);
  const button=await page.evaluate(()=>{const r=document.getElementById('motionStop').getBoundingClientRect(),d=devicePixelRatio;return [r.left*d,r.top*d,r.right*d,r.bottom*d];});
  for(const id of Object.keys(changed))assert.equal(await page.isDisabled('#'+id),true);
  // Programmatic field mutation must not move geometry of an already running scene.
  await page.evaluate(()=>{const e=document.getElementById('motionAreaX');e.value='99';e.dispatchEvent(new Event('input'));});
  const before=await page.evaluate(()=>{const c=document.getElementById('motionCanvas'),x=c.getContext('2d');return Array.from(x.getImageData(320,176,24,24).data);});await tick(100);
  assert.deepEqual(await page.evaluate(()=>{const c=document.getElementById('motionCanvas'),x=c.getContext('2d');return Array.from(x.getImageData(320,176,24,24).data);}),before);
  await finish();const first=await download('#motionExportLast');assert.equal(first.conditions.viewport.dpr,2);assert.equal(first.scenario.workspace.x,2560*.12);assert.equal(first.scenario.calibration_size_px,72);assert.equal(first.marker.module_px,8);assert.equal(first.complete,true);checkGeometry(first,button);
  const focusRepeat=await focus('motionRepeat');assert.equal(focusRepeat.focused,true);assert.equal(focusRepeat.visible,true);assert.equal(focusRepeat.width,'3px');
  // Test the complete screen workspace at DPR2, including the actual Stop box.
  await page.locator('#motionWorkspace summary').click();
  for(const [id,value] of Object.entries({motionAreaX:'0',motionAreaY:'0',motionAreaWidth:'100',motionAreaHeight:'100',motionTagSize:'48',motionSyncSize:'6'}))await page.fill('#'+id,value);
  await start();await tick(0);const fullButton=await page.evaluate(()=>{const r=document.getElementById('motionStop').getBoundingClientRect(),d=devicePixelRatio;return [r.left*d,r.top*d,r.right*d,r.bottom*d];});
  await page.screenshot({path:'/private/tmp/dronecv-motion-dpr2-controls.png'});await finish();const full=await download('#motionExportLast');assert.deepEqual(full.scenario.workspace,{x:0,y:0,width:2560,height:1600});checkGeometry(full,fullButton);
  const series=await download('#motionExport');assert.equal(series.runs.length,2);assert.equal((await page.evaluate(()=>MotionStore.list())).length,2);
  await page.click('#motionNewSeries');assert.match(await page.textContent('#motionStatus'),/остаются в IndexedDB/);assert.equal((await page.evaluate(()=>MotionStore.list())).length,2);
  await page.reload();await page.click('[data-section=motion]');await page.waitForFunction(()=>!document.getElementById('motionExport').disabled,null,{polling:50});const restored=await download('#motionExport');assert.deepEqual(new Set(restored.runs.map(r=>r.run_id)),new Set(series.runs.map(r=>r.run_id)));
  assert.deepEqual(errors,[]);console.log(`motion controls: workspace/tag/sync reload; keyboard Start/Repeat focus; fixed active geometry; full route and Stop isolation at DPR2/100%; series archive exports; white/accent contrast ${contrast.toFixed(2)}:1 passed`);
}finally{await browser.close();}

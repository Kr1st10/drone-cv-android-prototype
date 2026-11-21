// Canvas/IndexedDB/fullscreen integration. Synthetic RAF times are not display or phone measurements.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true}),errors=[];
page.setDefaultTimeout(15000);
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{
  let now=0,next=1;const callbacks=new Map();
  Object.defineProperty(performance,'now',{value:()=>now});
  window.requestAnimationFrame=fn=>{const id=next++;callbacks.set(id,fn);return id;};
  window.cancelAnimationFrame=id=>callbacks.delete(id);
  window.advanceSync=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};
  window.delayPersistence=ms=>{const original=MotionStore.end;MotionStore.end=async(...args)=>{now+=ms;return original(...args);};};
});
const tick=ms=>page.evaluate(ms=>advanceSync(ms),ms);
const clean=()=>page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled,null,{polling:50});
async function start(){await page.click('#motionStart');await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});}
async function exported(){const [d]=await Promise.all([page.waitForEvent('download'),page.click('#motionExportLast')]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));}
const code=()=>page.evaluate(()=>{
  const c=document.getElementById('motionCanvas'),ctx=c.getContext('2d'),m=18,x=c.width/2-5*m,y=c.height*.05+16+2*m;
  return Array.from({length:80},(_,i)=>ctx.getImageData(x+i%10*m+m/2,y+Math.floor(i/10)*m+m/2,1,1).data[0]<128?1:0);
});
try{
  await page.goto('file://'+path.join(root,'gallery.html'));await page.waitForFunction(()=>/Изображений: 90/.test(document.getElementById('status').textContent),null,{polling:50});
  await page.click('[data-section=motion]');await page.selectOption('#motionPhoto','civ01');
  const photo=await page.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ01'));
  await page.click('#motionBounds');for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await page.fill('#'+id,String(photo.object_bbox[i]));await page.click('#saveBounds');
  await start();await tick(0);const initialCode=await code();await tick(3500);await tick(500);const held=await code();
  assert.notDeepEqual(initialCode,held);
  for(let i=0;i<4;i++){await tick(20);assert.deepEqual(await code(),held,'canvas code remains unchanged between swaps');}
  await page.screenshot({path:'/private/tmp/dronecv-independent-sync.png'});
  await tick(20);assert.notDeepEqual(await code(),held);await tick(500);await tick(17);
  await page.evaluate(()=>delayPersistence(500));await page.click('#motionStop');await clean();
  const stopped=await exported();
  assert.equal(stopped.schema,'dronecv-motion-run-3');assert.equal(stopped.sync_period_ms,100);assert.equal(stopped.end_ms,4617);
  assert.equal(stopped.sync_intervals.at(-1).end_ms,4617);assert.equal(stopped.sync_intervals.length,5,'stalled RAF advances once');
  const moving=stopped.samples.filter(s=>s.elapsed_ms>=4000&&s.elapsed_ms<4100);
  assert.equal(moving.length,5);assert.notDeepEqual(moving[0].bbox_screen_px,moving.at(-1).bbox_screen_px);
  assert.equal(stopped.samples.length,10);assert.equal(stopped.complete,false);
  assert.ok(stopped.samples.every(s=>!('step_id' in s)));
  const stored=await page.evaluate(()=>MotionStore.history());assert.deepEqual(stored.last_local_run,stopped);
  // A cancelled launch has no invented first display or finite display boundary.
  await start();await page.click('#motionStop');await clean();const cancelled=await exported();
  assert.deepEqual(cancelled.samples,[]);assert.deepEqual(cancelled.sync_intervals,[]);assert.equal(cancelled.end_ms,null);
  await start();await tick(0);let completeAt=0;
  for(let i=0;i<1200;i++){
    if(!(await page.evaluate(()=>!!document.fullscreenElement)))break;
    await tick(100);completeAt+=100;
  }
  await clean();const completed=await exported();
  assert.equal(completed.complete,true);assert.equal(completed.sync_intervals.at(-1).end_ms,completed.end_ms);
  assert.ok(completeAt>=completed.end_ms,'fullscreen blank hold does not extend the code interval');
  assert.equal(completed.end_ms-completed.samples.at(-1).elapsed_ms,100,'completion records removal, not planned duration');
  assert.ok(completed.sync_intervals.slice(0,-1).every(s=>s.end_ms-s.start_ms>=100));
  await page.reload();await page.click('[data-section=motion]');await page.waitForFunction(()=>!document.getElementById('motionExportLast').disabled,null,{polling:50});
  assert.deepEqual(await exported(),completed,'new format survives IndexedDB/reload');
  // Abrupt reload leaves an explicitly open final interval, never a guessed end.
  await start();for(let i=0;i<120;i++)await tick(i===0?0:14);
  await page.waitForFunction(()=>MotionStore.history().then(h=>h.last_local_run?.samples.length===120),null,{polling:50});
  await page.reload();await page.click('[data-section=motion]');await page.waitForFunction(()=>!document.getElementById('motionExportLast').disabled,null,{polling:50});
  const partial=await exported();assert.equal(partial.complete,false);assert.equal(partial.end_ms,null);assert.equal(partial.sync_intervals.at(-1).end_ms,null);
  assert.ok(partial.sync_intervals.length>1);await page.evaluate(r=>MotionTimeline.validate(r),partial);
  // Import rejects future versions with an explicit reason.
  await page.setInputFiles('#reportReference',{name:'future.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...stopped,schema:'dronecv-motion-run-99'}))});
  await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Неподдерживаемая версия'),null,{polling:50});
  assert.deepEqual(errors,[]);
  console.log('Chrome: held canvas code, independent motion, late RAF, Stop/storage delay, cancellation, completion, reload and open recovery passed');
  // Also run the actual browser RAF, without a synthetic scheduler or clock.
  const live=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true});
  live.on('pageerror',e=>errors.push(String(e)));live.on('dialog',d=>d.accept());
  await live.goto('file://'+path.join(root,'gallery.html'));await live.click('[data-section=motion]');await live.selectOption('#motionPhoto','civ01');
  await live.click('#motionBounds');for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await live.fill('#'+id,String(photo.object_bbox[i]));await live.click('#saveBounds');
  await live.click('#motionStart');await live.waitForFunction(()=>document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
  await live.waitForTimeout(4700);await live.click('#motionStop');await live.waitForFunction(()=>!document.getElementById('motionStart').disabled,null,{polling:50});
  const measured=await live.evaluate(async()=>{const h=await MotionStore.history();return h.last_local_run;});
  const periods=measured.sync_intervals.slice(0,-1).map(s=>s.end_ms-s.start_ms);
  assert.ok(periods.length>30);assert.ok(periods.every(p=>p>=100));
  assert.ok(measured.samples.length>measured.sync_intervals.length*2);
  assert.ok(measured.samples.some((s,i)=>i&&s.visible&&s.elapsed_ms>4000&&JSON.stringify(s.bbox_screen_px)!==JSON.stringify(measured.samples[i-1].bbox_screen_px)));
  console.log(JSON.stringify({native_raf_browser_model:{trajectory_updates:measured.samples.length,code_intervals:measured.sync_intervals.length,min_period_ms:Math.min(...periods),mean_period_ms:periods.reduce((a,b)=>a+b,0)/periods.length}}));
  assert.deepEqual(errors,[]);await live.close();
}catch(e){console.error(await page.locator('#motionStatus').textContent(),errors);throw e;}finally{await browser.close();}

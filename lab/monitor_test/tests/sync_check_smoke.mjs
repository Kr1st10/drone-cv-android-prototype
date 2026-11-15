// Synthetic camera files verify browser behavior; they do not establish physical readability.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true}),errors=[];
page.on('pageerror',e=>{errors.push(String(e));console.error(e);});page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{let now=0,next=1;const callbacks=new Map();window.requestAnimationFrame=fn=>{const k=next++;callbacks.set(k,fn);return k;};window.cancelAnimationFrame=k=>callbacks.delete(k);window.advanceSync=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};});
const tick=ms=>page.evaluate(ms=>advanceSync(ms),ms);
async function start(){await page.click('#syncCheckStart');await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});}
async function clean(){await page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('syncCheckStart').disabled&&document.getElementById('motionCanvas').width===0,null,{polling:50});}
async function exported(){const [d]=await Promise.all([page.waitForEvent('download'),page.click('#syncCheckExport')]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));}
async function upload(j){await page.setInputFiles('#reportJournals',{name:'check.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(j))});try{await page.waitForFunction(()=>!document.getElementById('reportSelect').disabled,null,{polling:50,timeout:10000});}catch(e){console.error(await page.locator('#reportStatus').textContent());throw e;}}
try{
  await page.goto('file://'+path.join(root,'gallery.html'));await page.click('[data-section=motion]');
  assert.equal(await page.inputValue('#motionSyncSize'),'18');
  // No photo selection/annotation is required, even if the photo is unavailable.
  await page.evaluate(()=>{window.syncOriginalImages=MotionGallery.images;MotionGallery.images=()=>[];});
  let jpeg,run;
  for(const size of [12,18,24,32]){
    await page.click(`[data-sync-size="${size}"]`);await start();await tick(0);
    const png=await page.evaluate(()=>document.getElementById('motionCanvas').toDataURL('image/png'));
    fs.writeFileSync(`/private/tmp/dronecv-sync-${size}.png`,Buffer.from(png.split(',')[1],'base64'));
    if(size===18){jpeg=await page.evaluate(()=>document.getElementById('motionCanvas').toDataURL('image/jpeg',.95));await tick(9999);await tick(1);for(let i=0;i<5;i++)await tick(1000);}
    else await page.click('#motionStop');
    await clean();const current=await exported();
    assert.equal(current.marker.module_px,size);
    fs.writeFileSync(`/private/tmp/dronecv-sync-${size}.json`,JSON.stringify(current));
    if(size===18){run=current;assert.equal(run.complete,true);assert.deepEqual(run.steps.map(s=>[s.step_id,s.elapsed_ms]),[[0,0],[1,10000],[2,11000],[3,12000],[4,13000],[5,14000]]);}
    else {assert.equal(current.complete,false);assert.equal(current.steps.length,1);}
    assert.equal((await page.evaluate(()=>MotionStore.list())).length,0,'reading checks must never enter movement references');
  }
  await page.selectOption('#syncCheckSelect',run.run_id);
  assert.match(await page.textContent('#syncCheckStatus'),/Камерой не проверено/);
  const frames=run.steps.flatMap(s=>[s.elapsed_ms,s.elapsed_ms+(s.step_id===0?9999:999)].map((t)=>({frame_id:t,capture_ns:(t+100)*1e6,analyzer_ns:(t+101)*1e6,marker:{run_id:run.run_id,step_id:s.step_id}})));
  const journal={schema:'dronecv-motion-android-1',recording_complete:true,complete:true,truncated:false,stop_ns:16e9,frames,detections:[],publications:[],geometry:{width:1280,height:800},calibration_image:{data_url:jpeg,width:1280,height:800}};
  await upload(journal);assert.match(await page.textContent('#syncCheckStatus'),/Проверено камерой: прочитано 6 из 6/);assert.match(await page.textContent('#syncCheckStatus'),/4 из 4 найдены/);assert.match(await page.textContent('#reportTimingStatus'),/эталон траектории не требуется/);assert.equal(await page.isEnabled('#reportExport'),false);
  await page.screenshot({path:'/private/tmp/dronecv-sync-results.png',fullPage:true});
  await upload({...journal,calibration_image:null});assert.match(await page.textContent('#syncCheckStatus'),/настоящий JPEG не подтверждён/);assert.match(await page.textContent('#syncCheckStatus'),/Угловые метки: недостаточно данных/);
  await upload({...journal,frames:frames.map(f=>({...f,marker:null})),calibration_image:null});assert.match(await page.textContent('#syncCheckStatus'),/Код не прочитан ни в одном кадре. Причина по журналу не установлена/);assert.match(await page.textContent('#syncCheckStatus'),/Неизменный код: недостаточно данных/);
  await upload({...journal,frames:frames.map(f=>({...f,marker:{...f.marker,run_id:'deadbeef'}}))});assert.match(await page.textContent('#syncCheckStatus'),/посторонний run_id: 12/);assert.doesNotMatch(await page.textContent('#syncCheckStatus'),/Проверено камерой/);
  await upload({...journal,frames:frames.map(f=>({...f,capture_ns:null})),truncated:true,recording_complete:false});assert.match(await page.textContent('#syncCheckStatus'),/неполная \/ с пропусками/);assert.match(await page.textContent('#syncCheckStatus'),/При переключениях: недостаточно данных/);
  const base=1000000000n,rows=[
    {event_id:'1',type:'header',data:{start_ns:String(base),mode:'yolo_lk'}},
    {event_id:'3',type:'frame',data:{frame_id:'0',capture_ns:String(base),analyzer_entry_ns:String(base),timebase:'elapsed_realtime',marker:null}},
    {event_id:'4',type:'session_end',data:{stop_ns:String(base+1000n),recording_complete:true,dropped_count:'1',accepted_count:'2',written_count:'2',interrupted:false}}
  ].map(r=>({schema:'dronecv-session-timeline-1',session_id:'gap',event_ns:String(base),...r}));
  await page.setInputFiles('#reportJournals',{name:'gaps.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n')});
  await page.waitForFunction(()=>!document.getElementById('reportSelect').disabled,null,{polling:50});
  assert.match(await page.textContent('#syncCheckStatus'),/Пропуски событий: 1; dropped_count: 1/);
  assert.match(await page.textContent('#syncCheckStatus'),/Кадров: 1; прочитанных кодов: 0/);
  // Both operator cancellation and leaving fullscreen discard the scene.
  await page.click('[data-sync-size="18"]');await start();await tick(0);
  await page.keyboard.press('Escape');await clean();
  await start();await tick(0);await page.evaluate(()=>document.exitFullscreen());await clean();
  await page.setViewportSize({width:375,height:812});await page.click('#syncCheckStart');await clean();assert.match(await page.textContent('#motionStatus'),/не помещаются по ширине/);assert.equal(await page.inputValue('#motionSyncSize'),'18');
  const mobile=await page.evaluate(()=>{const p=document.getElementById('settings');return p.scrollWidth<=p.clientWidth+1;});assert.ok(mobile);
  await page.screenshot({path:'/private/tmp/dronecv-sync-mobile.png'});
  await page.reload();await page.click('[data-section=motion]');assert.ok((await page.locator('#syncCheckSelect option').count())>=6);assert.equal((await page.evaluate(()=>MotionStore.list())).length,0);
  await page.setViewportSize({width:1280,height:800});
  await page.click('[data-sync-size="18"]');
  await page.selectOption('#motionPhoto','civ01');
  const bounds=await page.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ01').object_bbox);
  await page.click('#motionBounds');
  for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await page.fill('#'+id,String(bounds[i]));
  await page.click('#saveBounds');
  // The original photo has large margins: 40 px target does not fit with 18 px cells.
  await page.click('#motionStart');await clean();assert.match(await page.textContent('#motionStatus'),/Маршрут не помещается/);
  assert.equal(await page.inputValue('#motionSyncSize'),'18');
  await page.fill('#motionWidth','20');await page.click('#motionStart');
  await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
  for(let i=0;i<1000;i++){if(!await page.evaluate(()=>!!document.fullscreenElement))break;await tick(100);}
  await clean();const motion=(await page.evaluate(()=>MotionStore.list())).at(-1);
  assert.equal(motion.complete,true);assert.equal(motion.marker.module_px,18);assert.ok(motion.samples.some(s=>s.visible));
  assert.deepEqual(errors,[]);
  console.log('sync browser: presets, no-photo start, 10s + five actual steps, separate persistence, cancel/complete/cleanup, journals/JPEG/tags, mobile fit failure passed');
}finally{await browser.close();}

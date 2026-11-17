// Synthetic camera files verify browser behavior; they do not establish physical readability.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true}),errors=[];
page.on('pageerror',e=>{errors.push(String(e));console.error(e);});page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{let now=0,next=1;const callbacks=new Map(),wallNow=performance.now.bind(performance);performance.now=()=>now;window.delaySync=ms=>{const start=wallNow();while(wallNow()-start<ms){}now+=ms;};window.requestAnimationFrame=fn=>{const k=next++;callbacks.set(k,fn);return k;};window.cancelAnimationFrame=k=>callbacks.delete(k);window.advanceSync=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};});
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
  await upload({...journal,calibration_image:null});
  for(const stall of ['storage','analysis'])for(const mode of ['natural','stop']){
    await page.evaluate(stall=>{
      window.endEvents=[];window.endSave=MotionGallery.save;window.endAnalyze=SyncCheck.analyze;
      MotionGallery.save=(key,value)=>{if(key==='sync_reading_checks_v1'){endEvents.push({kind:'storage',width:document.getElementById('motionCanvas').width,end:value.at(-1).end_ms});if(stall==='storage')delaySync(500);}return endSave(key,value);};
      SyncCheck.analyze=(...args)=>{endEvents.push({kind:'analysis',width:document.getElementById('motionCanvas').width});if(stall==='analysis')delaySync(500);return endAnalyze(...args);};
    },stall);
    await start();await tick(0);await tick(10000);for(let i=0;i<4;i++)await tick(1000);
    if(mode==='natural')await tick(1000);else {await tick(250);await page.click('#motionStop');}
    await clean();const current=await exported();
    assert.equal(current.end_ms,mode==='natural'?15000:14250);assert.equal(current.complete,mode==='natural');
    const events=await page.evaluate(()=>{MotionGallery.save=endSave;SyncCheck.analyze=endAnalyze;return endEvents;});
    assert.deepEqual(events.map(e=>e.kind),['storage','analysis']);assert.ok(events.every(e=>e.width===0),'slow work begins only after code removal');
    assert.equal(events[0].end,current.end_ms);
    const timing=await page.evaluate(r=>{
      const frames=r.steps.flatMap((s,i)=>[s.elapsed_ms+.25,(r.steps[i+1]?.elapsed_ms??r.end_ms)-.25].map(t=>({frame_id:t,capture_ns:(t+100)*1e6,marker:{run_id:r.run_id,step_id:s.step_id}})));
      return SyncCheck.analyze(r,{frames}).timing;
    },current);
    assert.equal(timing,'compatible');
    await start();await tick(0);await page.click('#motionStop');await clean();
  }
  await start();await page.click('#motionStop');await clean();const early=await exported();
  assert.deepEqual(early.steps,[]);assert.equal(early.end_ms,null);
  await page.evaluate(()=>{window.endSettings=MotionGallery.settings;MotionGallery.settings=()=>{throw Error('synthetic cleanup failure');};});
  await start();await tick(0);await tick(250);await page.click('#motionStop');await clean();
  assert.match(await page.textContent('#motionStatus'),/Ошибка очистки.*synthetic cleanup failure/);
  const cleanup=await exported();assert.equal(cleanup.end_ms,250);assert.equal(cleanup.steps.length,1);
  await page.evaluate(()=>{MotionGallery.settings=endSettings;});
  await start();await tick(0);await page.click('#motionStop');await clean();
  console.log('PASS 500ms synchronous storage/report delays after removal, compatible timing, natural/Stop, early cancel and cleanup recovery');
  // Invalid input must not become an active journal or poison later finalization.
  await upload({schema:'dronecv-motion-android-1',frames:[null]});
  assert.match(await page.textContent('#reportStatus'),/frames\[0\].*null/);
  await start();await tick(0);await page.click('#motionStop');await clean();
  assert.ok(await page.isEnabled('#motionStart'));
  await upload({schema:'dronecv-motion-android-1',frames:[null]});
  await start();await tick(0);await tick(10000);for(let i=0;i<5;i++)await tick(1000);await clean();
  assert.equal((await exported()).complete,true);
  await start();await tick(0);await page.click('#motionStop');await clean();
  console.log('PASS malformed import -> stop/natural completion -> next sync and movement controls enabled');

  await upload({...journal,calibration_image:null});
  await page.evaluate(()=>{window.originalAnalyze=SyncCheck.analyze;SyncCheck.analyze=()=>{throw Error('synthetic render failure');};});
  await start();await tick(0);await page.click('#motionStop');await clean();
  assert.match(await page.textContent('#motionStatus'),/сохранена.*Ошибка отображения.*synthetic render failure/);
  let retained=await exported();
  assert.ok(await page.evaluate(id=>MotionGallery.load('sync_reading_checks_v1',[]).some(r=>r.run_id===id),retained.run_id));
  assert.ok(await page.isEnabled('#motionStart'));
  await page.evaluate(()=>{SyncCheck.analyze=originalAnalyze;});
  await start();await tick(0);await page.click('#motionStop');await clean();
  console.log('PASS render failure preserves successful save/export, clears scene and allows next launch');

  for(const throws of [false,true]){
    await page.evaluate(throws=>{window.originalSave=MotionGallery.save;MotionGallery.save=(key,value)=>{if(key==='sync_reading_checks_v1'){if(throws)throw Error('synthetic storage failure');return false;}return originalSave(key,value);};},throws);
    await start();await tick(0);await page.click('#motionStop');await clean();
    assert.match(await page.textContent('#motionStatus'),/Не удалось сохранить в браузере.*Экспортируйте/);
    retained=await exported();assert.equal(retained.steps.length,1);
    assert.ok(await page.isEnabled('#motionStart'));
    await page.evaluate(()=>{MotionGallery.save=originalSave;});
    await start();await tick(0);await page.click('#motionStop');await clean();
  }
  // Exercise the outer finalization boundary as well as the normal render guard.
  await page.evaluate(()=>{window.originalCheckSave=SyncCheckUI.save;SyncCheckUI.save=r=>{originalCheckSave(r);throw Error('synthetic refresh boundary failure');};});
  await start();await tick(0);await page.click('#motionStop');await clean();
  assert.match(await page.textContent('#motionStatus'),/Ошибка завершения.*synthetic refresh boundary failure/);
  assert.ok(await page.isEnabled('#motionStart'));await exported();
  await page.evaluate(()=>{SyncCheckUI.save=originalCheckSave;});
  await start();await tick(0);await page.click('#motionStop');await clean();
  console.log('PASS storage false/throw keeps memory export; finalization finally restores both modes');
  await page.selectOption('#syncCheckSelect',run.run_id);
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
  // First motion uses the documented 40/18 settings, including the whole civ01 photo.
  await upload({schema:'dronecv-motion-android-1',frames:[null]});
  assert.equal(await page.inputValue('#motionWidth'),'40');
  assert.equal(await page.inputValue('#motionSyncSize'),'18');
  await page.click('#motionStart');
  await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
  for(let i=0;i<1000;i++){if(!await page.evaluate(()=>!!document.fullscreenElement))break;await tick(100);}
  await clean();const motion=(await page.evaluate(()=>MotionStore.list())).at(-1);
  assert.equal(motion.complete,true);assert.equal(motion.marker.module_px,18);assert.equal(motion.scenario.target_width_px,40);assert.ok(motion.samples.some(s=>s.visible));
  // Repeat uses the saved experiment, even after fields are edited.
  await page.locator('#motionWorkspace summary').click();
  await page.fill('#motionWidth','20');await page.fill('#motionSyncSize','6');
  await page.click('#motionRepeat');await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
  await tick(0);await page.click('#motionStop');await clean();
  const repeated=await page.evaluate(()=>MotionStore.history());
  assert.equal(repeated.last_local_run.scenario.target_width_px,40);assert.equal(repeated.last_local_run.marker.module_px,18);
  await page.fill('#motionWidth','40');await page.fill('#motionSyncSize','18');
  for(const [width,height] of [[1024,768],[1366,768],[1920,1080]]){
    await page.setViewportSize({width,height});await page.click('#motionStart');
    await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
    for(let i=0;i<1000;i++){if(!await page.evaluate(()=>!!document.fullscreenElement))break;await tick(100);}
    await clean();const current=(await page.evaluate(()=>MotionStore.history())).last_local_run;
    assert.equal(current.complete,true);assert.equal(current.scenario.target_width_px,40);assert.equal(current.marker.module_px,18);
  }
  await page.setViewportSize({width:1280,height:800});await page.fill('#motionAreaHeight','50');
  await page.click('#motionStart');await clean();assert.match(await page.textContent('#motionStatus'),/Маршрут не помещается/);
  assert.equal(await page.inputValue('#motionWidth'),'40');assert.equal(await page.inputValue('#motionSyncSize'),'18');assert.equal(await page.inputValue('#motionAreaHeight'),'50');
  await page.fill('#motionAreaHeight','90');await page.click('#motionStart');
  await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});await tick(0);await page.click('#motionStop');await clean();
  await page.fill('#motionSyncSize','6');await page.reload();
  await page.waitForFunction(()=>!document.getElementById('motionStart').disabled,null,{polling:50});
  await page.locator('[data-section=motion]').focus();await page.keyboard.press('Enter');assert.equal(await page.inputValue('#motionSyncSize'),'6');
  assert.deepEqual(errors,[]);
  console.log('sync browser: imports/recovery, save/render faults, 40/18 on four resolutions, repeat, old 6px profile, presets, timeline/JPEG/tags and impossible geometry passed');
}finally{await browser.close();}

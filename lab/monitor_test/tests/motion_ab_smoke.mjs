// Synthetic clocks, photographs and phone observations exercise browser data
// handling. They do not establish hardware repeatability or detector quality.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const errors=[];
async function pageIn(context){
  await context.addInitScript(()=>{
    let now=0,next=0;const callbacks=new Map();Object.defineProperty(performance,'now',{value:()=>now});
    requestAnimationFrame=fn=>{callbacks.set(++next,fn);return next;};cancelAnimationFrame=id=>callbacks.delete(id);
    window.abTick=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};
  });
  const p=await context.newPage();p.on('pageerror',e=>errors.push(String(e)));p.on('dialog',d=>d.accept());
  await p.goto('file://'+path.join(root,'gallery.html'));await p.click('[data-section=motion]');
  await p.waitForFunction(()=>!document.querySelector('#motionStart').disabled&&window.MotionABUI,null,{polling:50});return p;
}
const state=p=>p.evaluate(()=>MotionStore.ab());
async function until(test){const end=Date.now()+15000;while(Date.now()<end){if(await test())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out waiting for committed A/B state');}
async function idle(p){await p.waitForFunction(()=>!document.fullscreenElement&&!MotionUI.busy()&&!document.querySelector('#abNext').disabled,null,{polling:50});}
async function start(p,button='#abNext'){
  await p.click(button);await p.waitForFunction(()=>document.fullscreenElement&&document.querySelector('#settings').classList.contains('hidden'),null,{polling:50});
  await p.evaluate(()=>abTick(0));
  return p.evaluate(()=>document.querySelector('#motionCanvas').toDataURL('image/jpeg',.9));
}
async function complete(p){
  for(let i=0;i<1300;i++){if(!await p.evaluate(()=>!!document.fullscreenElement))break;await p.evaluate(()=>abTick(100));}
  await p.waitForFunction(()=>!document.fullscreenElement&&!MotionUI.busy(),null,{polling:50});
  await until(async()=>(await state(p)).series[0].attempts.at(-1).complete);
}
async function download(p,button){const [d]=await Promise.all([p.waitForEvent('download'),p.click(button)]);return fs.readFileSync(await d.path(),'utf8');}
function journal(run,jpeg,mode){
  const offset=100e6,frames=run.samples.map((s,i)=>({frame_id:i,capture_ns:s.elapsed_ms*1e6+offset,analyzer_ns:s.elapsed_ms*1e6+offset+1e6,marker:{run_id:run.run_id,step_id:run.sync_intervals.find(c=>c.start_ms<=s.elapsed_ms&&s.elapsed_ms<c.end_ms)?.step_id??run.sync_intervals.at(-1).step_id}}));
  return {schema:'dronecv-motion-android-1',mode,complete:true,recording_complete:true,truncated:false,stop_ns:run.end_ms*1e6+offset+100e6,
    geometry:{width:run.conditions.viewport.width,height:run.conditions.viewport.height},calibration_image:{width:run.conditions.viewport.width,height:run.conditions.viewport.height,data_url:jpeg},
    frames,detections:[],publications:run.samples.map((s,i)=>({frame_id:s.visible?i:null,published_ns:frames[i].capture_ns+(s.visible?20e6:0),source:s.visible?'yolo':'clear',bbox:s.visible?s.bbox_screen_px.map((n,j)=>n/(j%2?run.conditions.viewport.height:run.conditions.viewport.width)):null})),
    metadata:{git_sha:'synthetic',device:'synthetic',model_sha256:'synthetic',model_input_size:640,confidence:.25,nms_iou:.45,backend:'cpu',camera_context:{logical_id:'0',confirmed_zoom:1,latest_capture_zoom:1}}};
}
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});let p=await pageIn(context);
  await p.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=c.height=100;c.getContext('2d').fillRect(0,0,100,100);
    const photo={id:'synthetic-ab',sha256:'synthetic',file:c.toDataURL(),width:100,height:100};MotionGallery.images=()=>[photo];MotionGallery.bounds=()=>[0,0,100,100];await MotionUI.refresh(photo.id);
    document.querySelector('#motionSyncSize').value='6';
    for(const [id,v] of Object.entries({motionSetup:'desk',motionZoom:'1',motionOrientation:'landscape',motionCamera:'rear',motionDistance:'30'}))document.getElementById(id).value=v;
  });
  await p.selectOption('#motionTestMode','ab');await p.fill('#abPairs','2');await p.click('#abCreate');await p.waitForFunction(()=>!document.querySelector('#abNext').disabled,null,{polling:50});
  assert.match(await p.textContent('#abInstruction'),/Пара 1 из 2. Вариант A/);
  const jpeg=await start(p);await p.click('#motionStop');await idle(p);
  let w=await state(p),s=w.series[0];assert.equal(s.attempts.length,1);assert.equal(s.attempts[0].complete,false);assert.equal(s.selections['1:A'],undefined);
  await p.fill('#motionSpeed','999');await start(p);await complete(p);
  const first=await p.evaluate(()=>MotionStore.list().then(r=>r.at(-1)));assert.equal(first.scenario.max_speed_px_s,300);
  assert.equal(first.attempt,2);assert.notEqual(first.run_id,s.attempts[0].run_id);assert.equal(first.samples[0].elapsed_ms,0);
  await start(p);await complete(p);const second=await p.evaluate(()=>MotionStore.list().then(r=>r.at(-1)));
  assert.equal(second.variant,'B');assert.equal(second.slot,2);assert.equal(second.order,'AB');assert.notEqual(second.run_id,first.run_id);assert.deepEqual(second.settings_snapshot.plan,first.settings_snapshot.plan);
  assert.notDeepEqual(second.samples,first.samples);assert.equal(second.samples[0].elapsed_ms,0);
  assert.match(await p.textContent('#abInstruction'),/Пара 2 из 2. Вариант B/);
  // Explicit selection, never automatic best-attempt selection.
  await p.locator('#abResults select').nth(0).selectOption(first.run_id);await p.locator('#abResults select').nth(1).selectOption(second.run_id);
  const ja=journal(first,jpeg,'yolo'),jb=journal(second,jpeg,'yolo_lk');
  await p.setInputFiles('#reportJournals',[{name:'arbitrary-A.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(ja))},{name:'arbitrary-B.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(jb))}]);
  await until(async()=>{const w=await state(p);return w.series[0].journals.length===2&&new Set(w.series[0].analyses.map(a=>a.run_id)).size===2;});
  w=await state(p);assert.equal(w.series[0].journals.length,2);
  const summary=await p.evaluate(()=>MotionStore.ab().then(async w=>MotionAB.summarize(w.series[0],await MotionStore.list())));
  assert.ok(['complete','unconfirmed'].includes(summary.pairs[0].state),JSON.stringify(summary.pairs[0].reasons));assert.ok(summary.pairs[0].rows.length>15);
  await p.setInputFiles('#reportJournals',{name:'renamed-A.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(ja))});
  await p.waitForFunction(()=>!document.querySelector('#reportExport').disabled,null,{polling:50});
  const bundle=JSON.parse(await download(p,'#abExport'));assert.equal(bundle.series.journals.length,2);assert.equal(bundle.runs.length,3);assert.ok(bundle.manifest.length>=5);
  assert.match(await download(p,'#abCSV'),/delta/);
  // Re-run the production analyzer from exported originals and parameters.
  const replay=await p.evaluate(async bundle=>{
    const restored=await MotionAB.importBundle(bundle);return restored.series.analyses.map(a=>{
      const source=restored.series.journals.find(j=>j.hash===a.source_hash),run=restored.runs.find(r=>r.run_id===a.run_id);
      return MotionAB.canonical(MotionReportV4.analyze(run,JSON.parse(source.raw),a.parameters.calibration_points))===MotionAB.canonical(a.result);
    });
  },bundle);assert.ok(replay.length>=2&&replay.every(Boolean));
  // An older calibration calculation must not replace the newer result or its parameters.
  await p.evaluate(async()=>{
    const s=(await MotionStore.ab()).series[0],a=s.analyses[0],source=s.journals.find(j=>j.hash===a.source_hash),run=(await MotionStore.list()).find(r=>r.run_id===a.run_id);
    const j={name:source.name,raw:source.raw,data:source.data,points:[[0,0],[1,0],[1,1],[0,1]],manual:true};
    const realHash=MotionAB.sha256;let release,first=true;
    MotionAB.sha256=async raw=>{if(first){first=false;await new Promise(resolve=>release=resolve);}return realHash(raw);};
    const old=MotionABUI.capture(j,run,{...a.result,good_ms:1},()=>true);
    j.points=[[.1,.1],[.9,.1],[.9,.9],[.1,.9]];
    await MotionABUI.capture(j,run,{...a.result,good_ms:2},()=>true);release();await old;MotionAB.sha256=realHash;
  });
  const latest=(await state(p)).series[0].analyses.at(-1);assert.equal(latest.result.good_ms,2);assert.deepEqual(latest.parameters.calibration_points[0],[.1,.1]);
  await p.reload();await p.click('[data-section=motion]');await p.selectOption('#motionTestMode','ab');await p.waitForFunction(()=>!document.querySelector('#abNext').disabled,null,{polling:50});
  assert.equal((await state(p)).series[0].selections['1:A'],first.run_id);assert.match(await p.textContent('#abInstruction'),/Пара 2 из 2. Вариант B/);
  await p.setViewportSize({width:375,height:812});await p.screenshot({path:'/private/tmp/drone-ab-mobile.png'});
  assert.equal(await p.evaluate(()=>document.querySelector('#settings').scrollWidth<=document.querySelector('#settings').clientWidth+1),true);
  await p.setViewportSize({width:1280,height:800});
  // A refused fullscreen is retained as an interrupted attempt, not a complete pair.
  await p.evaluate(()=>{window.realFS=document.querySelector('#motionStage').requestFullscreen;document.querySelector('#motionStage').requestFullscreen=()=>Promise.reject(Error('synthetic fullscreen denied'));});
  await p.click('#abNext');await until(async()=>(await state(p)).series[0].attempts.at(-1).state==='preflight_failed');
  const failed=JSON.parse(await download(p,'#abExport'));assert.equal(failed.series.attempts.at(-1).complete,false);
  await p.evaluate(()=>document.querySelector('#motionStage').requestFullscreen=window.realFS);
  // A failed chunk write still exports the complete available in-memory reference.
  await p.evaluate(()=>{window.realAppend=MotionStore.append;MotionStore.append=()=>Promise.reject(Error('synthetic chunk quota'));});
  await start(p);for(let i=0;i<120;i++)await p.evaluate(()=>abTick(10));
  await p.waitForFunction(()=>!MotionUI.busy(),null,{polling:50});
  const memoryRun=await p.evaluate(()=>MotionUI.runs().at(-1));assert.ok(memoryRun.samples.length>=120);assert.equal(memoryRun.complete,false);
  const memoryExport=JSON.parse(await download(p,'#abExport'));assert.deepEqual(memoryExport.runs.find(r=>r.run_id===memoryRun.run_id).samples,memoryRun.samples);
  await p.evaluate(()=>MotionStore.append=window.realAppend);
  // Even a naturally finished display cannot become a completed pair if end commit fails.
  await p.evaluate(()=>{window.realEnd=MotionStore.end;MotionStore.end=()=>Promise.reject(Error('synthetic end quota'));});
  await start(p);for(let i=0;i<1300;i++){if(!await p.evaluate(()=>!!document.fullscreenElement))break;await p.evaluate(()=>abTick(100));}
  await p.waitForFunction(()=>!MotionUI.busy(),null,{polling:50});
  const endFailure=JSON.parse(await download(p,'#abExport'));assert.equal(endFailure.series.attempts.at(-1).complete,false);assert.match(endFailure.series.attempts.at(-1).abort_reason,/synthetic end quota/);
  assert.equal(endFailure.runs.find(r=>r.run_id===endFailure.series.attempts.at(-1).run_id).complete,false);
  await p.evaluate(()=>MotionStore.end=window.realEnd);
  // Storage failure before launch leaves the old persisted history intact and exportable.
  const stored=(await state(p)).series[0].attempts.length;
  await p.evaluate(()=>{window.realAB=MotionStore.ab;MotionStore.ab=function(...args){return args.length?Promise.reject(Error('synthetic quota')):realAB();};});
  await p.click('#abNext');await p.waitForFunction(()=>document.querySelector('#abStatus').textContent.includes('synthetic quota'),null,{polling:50});assert.equal((await state(p)).series[0].attempts.length,stored);
  assert.equal(JSON.parse(await download(p,'#abExport')).series.attempts.length,stored);
  assert.equal(await p.evaluate(()=>document.fullscreenElement),null);
  // Full bundle import in a clean browser profile restores sources and selected attempts.
  const other=await browser.newContext({viewport:{width:1280,height:800}}),q=await pageIn(other);await q.selectOption('#motionTestMode','ab');
  await q.setInputFiles('#abImport',{name:'ab.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
  await q.waitForFunction(()=>document.querySelector('#abStatus').textContent.includes('Серия восстановлена'),null,{polling:50});
  await until(async()=>(await state(q))?.series.length===1);
  const restored=(await state(q)).series[0];assert.deepEqual(restored.selections,bundle.series.selections);assert.equal(restored.journals.length,2);
  // Retrospective pairing needs saved references, not a currently selected photo.
  await q.click('[data-section=motion]');await q.selectOption('#motionTestMode','ab');await q.getByText('Ретроспективная пара из прежних прогонов', { exact: true }).click();
  await q.fill('#abRetroA',first.run_id);await q.fill('#abRetroB',second.run_id);await q.click('#abRetro');
  await until(async()=>(await state(q)).series.length===2);
  const noJpeg={...ja,calibration_image:null};
  const noJpegRaw='\ufeff'+JSON.stringify(noJpeg);await q.setInputFiles('#reportJournals',{name:'no-camera-image.json',mimeType:'application/json',buffer:Buffer.from(noJpegRaw)});
  await until(async()=>{const s=(await state(q)).series.at(-1);return s.journals.length===1&&/Калибровочный кадр/.test(s.analysis_errors?.[first.run_id]);});
  const invalidExport=JSON.parse(await download(q,'#abExport'));assert.equal(invalidExport.series.journals[0].raw,noJpegRaw);assert.match(invalidExport.summary.pairs[0].reasons.join(' '),/Калибровочный кадр/);
  // An imported conflicting reference remains a conflict in A/B, including export.
  const conflict={...first,photo:{...first.photo,sha256:'conflicting-photo'}};
  await q.setInputFiles('#reportReference',{name:'conflict.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(conflict))});
  await until(async()=>{const runs=await q.evaluate(()=>MotionStore.list());return runs.filter(r=>r.run_id===first.run_id).length===2;});
  const conflicts=JSON.parse(await download(q,'#abExport'));assert.equal(conflicts.runs.filter(r=>r.run_id===first.run_id).length,2);assert.equal(conflicts.summary.pairs[0].state,'awaiting_attempt');
  await context.close();await other.close();assert.deepEqual(errors,[]);
  console.log('PASS A/B browser: frozen plans, fresh references, abort/retry, AB/BA, explicit selections, real importer/calibration, duplicate source, JSON/CSV, reload, mobile, fullscreen failure, quota export, clean-profile restore');
}finally{await browser.close();}

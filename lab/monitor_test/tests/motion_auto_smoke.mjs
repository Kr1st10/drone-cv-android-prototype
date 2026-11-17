// Preserve the pre-enlargement movement fixture at an explicit 6 px cell.
// Synthetic journals/camera JPEGs validate the offline workflow, not Xiaomi CV.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,acceptDownloads:true});
const page=await context.newPage(),errors=[],requests=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});page.on('dialog',d=>d.accept());
await page.addInitScript(()=>{let now=0,next=1;const callbacks=new Map();window.requestAnimationFrame=fn=>{const key=next++;callbacks.set(key,fn);return key;};window.cancelAnimationFrame=id=>callbacks.delete(id);window.advanceMotion=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};});
const tick=ms=>page.evaluate(ms=>advanceMotion(ms),ms);
async function waitSettings(){await page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled&&document.getElementById('motionStage').classList.contains('hidden'),null,{polling:50});assert.equal(await page.evaluate(()=>document.getElementById('motionCanvas').width),0);}
async function start(button='#motionStart'){await page.click(button);await page.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});}
async function complete(){for(let i=0;i<1200;i++){if(!(await page.evaluate(()=>!!document.fullscreenElement)))break;await tick(100);}await waitSettings();}
async function exportRun(){const [d]=await Promise.all([page.waitForEvent('download'),page.click('#motionExportLast')]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));}
async function uploadJournal(data,name='journal.json'){await page.setInputFiles('#reportJournals',{name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});}
try{
  await page.goto('file://'+path.join(root,'gallery.html'));await page.waitForFunction(()=>/Изображений: 90/.test(document.getElementById('status').textContent),null,{polling:100});
  await page.click('[data-section=gallery]');await page.click('#presetPilot');await page.click('#start');await page.keyboard.press('s');await page.click('[data-section=motion]');await page.evaluate(()=>{const e=document.getElementById('motionSyncSize');e.value='6';e.dispatchEvent(new Event('input'));});
  const original=await page.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ01'));
  await page.setInputFiles('#motionUpload',path.join(root,original.file));await page.waitForFunction(()=>document.getElementById('motionPhoto').value.startsWith('ref-'),null,{polling:50});
  const photo=await page.inputValue('#motionPhoto'),local=await page.evaluate(id=>M.find(m=>m.id===id),photo);
  await page.click('#motionBounds');const bbox=original.object_bbox.map((v,i)=>v*(i%2?local.height/original.height:local.width/original.width));
  for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await page.fill('#'+id,String(bbox[i]));await page.click('#saveBounds');
  assert.match(await page.textContent('#motionPhotoStatus'),/Границы подтверждены/);assert.equal(await page.inputValue('#motionWidth'),'40');
  await start();await tick(0);
  const jpeg=await page.evaluate(()=>document.getElementById('motionCanvas').toDataURL('image/jpeg',.8));
  const png=await page.evaluate(()=>document.getElementById('motionCanvas').toDataURL('image/png'));
  fs.writeFileSync('/private/tmp/dronecv-motion-render.png',Buffer.from(png.split(',')[1],'base64'));
  await tick(100);
  const pixels=await page.evaluate(()=>{const c=document.getElementById('motionCanvas'),x=c.getContext('2d');return {width:c.width,height:c.height,data:null};});
  await complete();const first=await exportRun();
  fs.writeFileSync('/private/tmp/dronecv-motion-render.json',JSON.stringify({run_id:first.run_id,step_id:0,width:pixels.width,height:pixels.height}));
  assert.equal(first.schema,'dronecv-motion-run-2');assert.equal(first.complete,true);assert.equal(first.mode,null);
  assert.ok(first.samples.filter(s=>s.phase==='calibration').length>10);assert.deepEqual(first.samples.slice(0,3).map(s=>s.step_id),[0,1,2]);assert.ok(first.samples[1].elapsed_ms>0);
  assert.ok(first.samples.some(s=>s.phase==='stationary'&&s.visible));assert.ok(first.samples.some(s=>s.phase==='disappearance'&&!s.visible));assert.ok(first.samples.at(-1).phase==='blank_after');
  assert.match(await page.textContent('#motionStatus'),/сохранён в браузере/);
  const saved=await page.evaluate(()=>MotionStore.list());assert.equal(saved.length,1);assert.equal(saved[0].run_id,first.run_id);assert.equal(saved[0].samples.length,first.samples.length);
  const c=first.scenario.workspace;
  assert.ok(first.samples.filter(s=>s.image_rect_px).every(s=>s.image_rect_px[0]>=c.x&&s.image_rect_px[1]>=c.y&&s.image_rect_px[2]<=c.x+c.width&&s.image_rect_px[3]<=c.y+c.height));
  await page.reload();await page.click('[data-section=motion]');await page.waitForFunction(()=>!document.getElementById('motionRepeat').disabled,null,{polling:50});
  assert.equal(await page.inputValue('#motionPhoto'),photo);assert.match(await page.textContent('#motionPhotoStatus'),/Границы подтверждены/);
  await start('#motionRepeat');await tick(0);await complete();const second=await exportRun();assert.notEqual(second.run_id,first.run_id);assert.deepEqual(second.scenario,first.scenario);assert.deepEqual(second.calibration_markers,first.calibration_markers);assert.deepEqual(second.photo,first.photo);
  const journal={schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,truncated:false,stop_ns:(first.samples.at(-1).elapsed_ms+100)*1e6,geometry:{width:pixels.width,height:pixels.height},calibration_image:{width:pixels.width,height:pixels.height,data_url:jpeg},frames:first.samples.map((s,i)=>({frame_id:i,capture_ns:(s.elapsed_ms+40)*1e6,analyzer_ns:(s.elapsed_ms+45)*1e6,marker:{run_id:first.run_id,step_id:s.step_id}})),detections:[],publications:first.samples.map((s,i)=>({frame_id:i,published_ns:(s.elapsed_ms+50)*1e6,bbox:s.bbox_screen_px?.map((v,k)=>v/(k%2?pixels.height:pixels.width))??null,source:s.visible?'yolo':'clear'}))};
  journal.detections=journal.publications.filter(p=>p.bbox).map(p=>({...p,confidence:.99}));
  const buildMetadata={git_sha:'a'.repeat(40),git_dirty:true,app_version:'0.5.2',version_code:7,build_type:'debug',
    mode:'yolo_lk',confidence:.5,nms_iou:.7,nms_max_detections:300,intra_op_threads:2,model_input_size:640,
    model_asset:'synthetic.onnx',model_sha256:'b'.repeat(64),camera_context:{scope:'latest_context_not_frame_bound',requested_zoom:5,confirmed_zoom:null}};
  journal.metadata_records=[{type:'metadata',data:buildMetadata}];
  await uploadJournal(journal);await page.waitForFunction(()=>!document.getElementById('reportExport').disabled,null,{polling:50});assert.match(await page.textContent('#reportStatus'),/4 из 4 найдены/);assert.match(await page.textContent('#reportOutput'),/режим телефона: yolo_lk/);assert.equal(await page.evaluate(()=>document.getElementById('reportCanvas').width),pixels.width);
  const [reportDownload]=await Promise.all([page.waitForEvent('download'),page.click('#reportExport')]);const report=JSON.parse(fs.readFileSync(await reportDownload.path(),'utf8'));assert.equal(report.runs[0].run_id,first.run_id);assert.equal(report.runs[0].calibration.markers.length,4);
  assert.equal(report.schema,'dronecv-motion-scenario-report-1');
  for(const [key,value] of Object.entries(buildMetadata))assert.deepEqual(report.runs[0].provenance.android.fields[key],value);
  assert.match(await page.textContent('#reportOutput'),/Сборка Android: 0\.5\.2 \(7\); тип debug; commit a{40}; локальные изменения: да/);
  assert.match(await page.textContent('#reportOutput'),/NMS IoU 0\.7, максимум 300; потоки 2; вход модели 640/);
  assert.match(await page.textContent('#reportOutput'),/camera_context: снимок контекста, не покадровые параметры/);
  await uploadJournal({...journal,metadata_records:[...journal.metadata_records,{type:'metadata',data:{git_sha:'c'.repeat(40),git_dirty:false}}]},'conflicting-build.json');
  await page.waitForFunction(()=>!document.getElementById('reportExport').disabled,null,{polling:50});
  assert.match(await page.textContent('#reportOutput'),/commit противоречие; локальные изменения: противоречие/);
  assert.match(await page.textContent('#reportOutput'),/Противоречивые метаданные: git_sha, git_dirty/);
  const [conflictDownload]=await Promise.all([page.waitForEvent('download'),page.click('#reportExport')]);
  const conflict=JSON.parse(fs.readFileSync(await conflictDownload.path(),'utf8')).runs[0].provenance.android;
  assert.equal(conflict.fields.git_sha,null);assert.equal(conflict.fields.git_dirty,null);
  assert.deepEqual(conflict.conflicts.git_sha.map(v=>v.value),['a'.repeat(40),'c'.repeat(40)]);
  assert.deepEqual(conflict.conflicts.git_dirty.map(v=>v.value),[true,false]);
  await uploadJournal(journal);await page.waitForFunction(()=>!document.getElementById('reportExport').disabled,null,{polling:50});
  await page.screenshot({path:'/private/tmp/dronecv-motion-settings.png',fullPage:true});
  // The manual fallback uses the actual decoded image and automatically recalculates.
  await page.click('#reportReset');
  for(const [x,y] of report.runs[0].calibration_points){
    await page.locator('#reportCanvas').scrollIntoViewIfNeeded();
    const r=await page.locator('#reportCanvas').boundingBox();await page.mouse.click(r.x+x*r.width,r.y+y*r.height);
  }
  await page.waitForFunction(()=>!document.getElementById('reportExport').disabled,null,{polling:50});
  const missingJpeg=await page.evaluate(async ({jpeg,tag})=>{
    const img=new Image();img.src=jpeg;await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);ctx.fillStyle='#fff';ctx.fillRect(tag.x-3,tag.y-3,tag.size+6,tag.size+6);return c.toDataURL('image/jpeg',.8);
  },{jpeg,tag:first.calibration_markers.find(t=>t.id===2)});
  await uploadJournal({...journal,calibration_image:{...journal.calibration_image,data_url:missingJpeg}},'missing-br.json');
  await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Не найдена нижняя правая метка'),null,{polling:50});assert.equal(await page.isEnabled('#reportExport'),false);
  // A missing JPEG never gains a synthetic replacement; manual mode requires it.
  await uploadJournal({...journal,calibration_image:null},'no-jpeg.json');await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Калибровочный кадр отсутствует'),null,{polling:50});assert.equal(await page.evaluate(()=>document.getElementById('reportCanvas').width),0);await page.click('#reportReset');assert.match(await page.textContent('#reportStatus'),/только при наличии настоящего кадра/);
  const foreign={...journal,frames:journal.frames.map(f=>({...f,marker:{...f.marker,run_id:'deadbeef'}}))};
  await uploadJournal(foreign);await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Эталон deadbeef отсутствует'),null,{polling:50});assert.equal(await page.isEnabled('#reportExport'),false);
  const multi=structuredClone(journal);multi.frames.at(-1).marker.run_id='deadbeef';await uploadJournal(multi);await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('несколько разных запусков'),null,{polling:50});
  const unreadable={...journal,frames:journal.frames.map(f=>({...f,marker:null}))};await uploadJournal(unreadable);await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Sync-код не считан'),null,{polling:50});
  // Delay an old file read while a newer import completes.
  await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){if(this.name==='slow.json')return new Promise(resolve=>setTimeout(()=>original.call(this).then(resolve),300));return original.call(this);};});
  await uploadJournal(journal,'slow.json');await uploadJournal(foreign,'newer.json');await page.waitForTimeout(500);assert.match(await page.textContent('#reportStatus'),/Эталон deadbeef отсутствует/);assert.equal(await page.isEnabled('#reportExport'),false);
  // Conflicting persistent references are rejected rather than chosen arbitrarily.
  await page.evaluate(async run=>{const copy=structuredClone(run);copy.photo.id='conflicting-photo';await MotionStore.save(copy);},first);
  await uploadJournal(journal);await page.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Конфликтующие эталоны'),null,{polling:50});
  // Stop while fullscreen/image startup is still pending, then cleanly restart.
  await page.evaluate(()=>{const original=MotionGallery.imageLoaded;MotionGallery.imageLoaded=(...args)=>new Promise(resolve=>setTimeout(()=>original(...args).then(resolve),300));});
  await page.click('#motionStart');await page.keyboard.press('Escape');await waitSettings();await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>document.getElementById('motionCanvas').width),0);
  await start();await tick(0);await page.click('#motionStop');await waitSettings();assert.match(await page.textContent('#motionStatus'),/неполный/);
  // Failure injection checks the common finish path and honest persistence status.
  await page.evaluate(()=>{window.savedAppend=MotionStore.append;MotionStore.append=()=>Promise.reject(new DOMException('synthetic quota exhausted','QuotaExceededError'));});
  await start();for(let i=0;i<120;i++)await tick(10);await waitSettings();
  assert.match(await page.textContent('#motionStatus'),/Ошибка сохранения/);
  const quotaRun=await exportRun();assert.equal(quotaRun.complete,false);assert.match(quotaRun.abort_reason,/сохранения/);
  const quotaStored=await page.evaluate(id=>MotionStore.list().then(r=>r.find(v=>v.run_id===id)),quotaRun.run_id);assert.equal(quotaStored.complete,false);
  await page.evaluate(()=>{MotionStore.append=window.savedAppend;delete window.savedAppend;window.savedSample=MotionScenario.sample;MotionScenario.sample=()=>{throw Error('synthetic renderer failure');};});
  await start();await tick(0);await waitSettings();assert.match(await page.textContent('#motionStatus'),/ошибка отрисовки/);
  assert.equal((await exportRun()).complete,false);await page.evaluate(()=>{MotionScenario.sample=window.savedSample;delete window.savedSample;});
  await start();await tick(0);await page.evaluate(()=>document.exitFullscreen());await waitSettings();assert.match(await page.textContent('#motionStatus'),/выход из полного экрана/);
  // Visibility is an injected browser event; this does not model a phone camera.
  await start();await tick(0);await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await waitSettings();assert.match(await page.textContent('#motionStatus'),/страница скрыта/);await page.evaluate(()=>delete document.hidden);
  await start();await tick(0);await page.setViewportSize({width:1200,height:800});await waitSettings();assert.match(await page.textContent('#motionStatus'),/измен/);
  await page.click('#motionRepeat');await waitSettings();assert.match(await page.textContent('#motionStatus'),/Размер области движения изменился/);
  await page.setViewportSize({width:1280,height:800});
  // A second image must not inherit the first image's confirmed bounds.
  const replacement=await page.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ02'));
  await page.setInputFiles('#motionUpload',path.join(root,replacement.file));await page.waitForFunction(id=>document.getElementById('motionPhoto').value!==id,photo,{polling:50});
  assert.match(await page.textContent('#motionPhotoStatus'),/подтвердите границы/);const replacementId=await page.inputValue('#motionPhoto');assert.notEqual(replacementId,photo);
  assert.equal(await page.evaluate(id=>MotionGallery.bounds(MotionGallery.images().find(m=>m.id===id)),replacementId),null);
  await page.click('#motionStart');await waitSettings();assert.match(await page.textContent('#motionStatus'),/Подтвердите границы/);
  await page.selectOption('#motionPhoto',photo);
  await page.waitForFunction(()=>document.getElementById('motionPhotoPreview').complete&&document.getElementById('motionPhotoPreview').naturalWidth>0,null,{polling:50});
  await page.evaluate(()=>document.getElementById('settings').scrollTop=0);await page.screenshot({path:'/private/tmp/dronecv-motion-settings-top.png'});
  await page.setViewportSize({width:375,height:812});
  const mobile=await page.evaluate(()=>{const panel=document.getElementById('settings'),r=panel.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:panel.scrollWidth,client:panel.clientWidth};});
  assert.ok(mobile.left>=0&&mobile.right<=mobile.width,JSON.stringify(mobile));assert.ok(mobile.scroll<=mobile.client+1,JSON.stringify(mobile));
  await page.waitForTimeout(100);
  await page.screenshot({path:'/private/tmp/dronecv-motion-mobile.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('motion auto browser: persistence/repeat; calibration timeline/JPEG/manual/missing tag; reference conflicts/missing/multiple IDs; rapid import/start cancellation; quota/render failures; fullscreen/visibility/resize finish; repeat geometry rejection; new photo bounds; mobile/offline passed');
}finally{await browser.close();}

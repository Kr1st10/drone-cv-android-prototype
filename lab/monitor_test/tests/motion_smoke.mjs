// Preserve the pre-enlargement movement fixture at an explicit 6 px cell.
// Offline browser integration; simulated timing and operator inputs are not device measurements.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const dir = path.resolve(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage(), errors = [], network = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('request', r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
page.on('dialog', d => d.accept());
await page.addInitScript(() => {
  let time = 0, next = 1; const callbacks = new Map();
  Object.defineProperty(performance, 'now', { value: () => time });
  window.requestAnimationFrame = cb => { const id = next++; callbacks.set(id, cb); return id; };
  window.cancelAnimationFrame = id => callbacks.delete(id);
  window.advanceMotion = ms => { time += ms; const work = [...callbacks.values()]; callbacks.clear(); work.forEach(cb => cb(time)); };
});
await page.goto('file://' + path.join(dir, 'gallery.html'));
await page.waitForFunction(() => /Изображений: 90/.test(document.getElementById('status').textContent), null, { polling: 100 });
await page.click('[data-section=gallery]'); await page.click('#presetPilot'); await page.click('#start');
const previous = await page.evaluate(() => JSON.parse(sessionJson()));
await page.keyboard.press('s'); await page.click('[data-section=motion]');await page.evaluate(()=>{const e=document.getElementById('motionSyncSize');e.value='6';e.dispatchEvent(new Event('input'));});
for (const [key,value] of Object.entries({motionWidth:'40',motionSpeed:'300',motionAcceleration:'500',motionLaps:'1'})) assert.equal(await page.inputValue('#'+key),value);
await page.click('#motionStart'); assert.match(await page.textContent('#motionStatus'), /Не удалось начать/);
const original = await page.evaluate(() => MANIFEST.images.find(m => m.id === 'civ01'));
await page.setInputFiles('#motionUpload', path.join(dir, original.file));
await page.waitForFunction(() => document.querySelector('#motionPhoto').value.startsWith('ref-'), null, { polling: 100 });
const selected = await page.inputValue('#motionPhoto');
const local = await page.evaluate(id => M.find(m => m.id === id), selected);
await page.click('#motionBounds');
const bbox = original.object_bbox.map((v, i) => v * (i % 2 ? local.height / original.height : local.width / original.width));
for (const [i, id] of ['boundX1', 'boundY1', 'boundX2', 'boundY2'].entries()) await page.fill('#' + id, String(bbox[i]));
await page.click('#saveBounds'); assert.match(await page.textContent('#motionPhotoStatus'), /Границы подтверждены/);
for (const [id, value] of Object.entries({ motionWidth: '60', motionSpeed: '500', motionAcceleration: '1000', motionLaps: '2' })) await page.fill('#' + id, value);

async function start(button = '#motionStart') { await page.click(button); await page.waitForFunction(() => document.fullscreenElement === document.getElementById('motionStage') && document.getElementById('settings').classList.contains('hidden'), null, { polling: 100 }); }
async function cleanSettings() {
  await page.waitForFunction(() => !document.fullscreenElement && !document.getElementById('settings').classList.contains('hidden') && document.getElementById('motionStage').classList.contains('hidden') && !document.getElementById('motionStart').disabled, null, { polling: 100 });
  assert.deepEqual(await page.evaluate(() => ['stage','hud','geometry','stageControls','answer','record'].map(id => getComputedStyle(document.getElementById(id)).display)), Array(6).fill('none'));
  assert.equal(await page.evaluate(() => document.getElementById('motionCanvas').width), 0);
  assert.equal(await page.isEnabled('#motionStart'), true);
  assert.equal(await page.isEnabled('#motionWidth'), true);
}
// Motion settings survive reload without altering the gallery's settings or shared bounds.
const storageBefore = await page.evaluate(() => ({settings: localStorage.getItem(LS+'settings'), bounds: localStorage.getItem(LS+'object_bounds')}));
await page.reload(); await page.click('[data-section=motion]');
assert.equal(await page.inputValue('#motionPhoto'), selected);
for (const [key, value] of Object.entries({motionWidth:'60',motionSpeed:'500',motionAcceleration:'1000',motionLaps:'2'})) assert.equal(await page.inputValue('#'+key),value);
await page.fill('#motionLaps','1');
assert.match(await page.textContent('#motionPhotoStatus'), /Границы подтверждены/);
assert.deepEqual(await page.evaluate(() => ({settings: localStorage.getItem(LS+'settings'), bounds: localStorage.getItem(LS+'object_bounds')})), storageBefore);
async function tick(ms) { await page.evaluate(ms => advanceMotion(ms), ms); }
async function finish() { for (let i = 0; i < 100; i++) { if (!(await page.evaluate(() => !!document.fullscreenElement))) break; await tick(500); } await page.waitForFunction(() => !document.fullscreenElement, null, { polling: 100 }); }
async function fullRun(button) { await start(button); await tick(0); await tick(1000); await tick(250); await finish(); }
async function exportJson(id) { const [download] = await Promise.all([page.waitForEvent('download'), page.click(id)]); return JSON.parse(fs.readFileSync(await download.path(), 'utf8')); }
await start(); await tick(0); await tick(1000); await tick(250);
assert.equal(await page.evaluate(() => document.fullscreenElement.id), 'motionStage');
assert.ok(await page.evaluate(() => { const c = document.getElementById('motionCanvas'); return c.width > 0 && c.height > 0 && c.getContext('2d').getImageData(16, 16, 1, 1).data[3] === 255; }));
const markerPixels = await page.evaluate(() => { const c = document.getElementById('motionCanvas'), ctx = c.getContext('2d'), m = 6, x = c.width/2-5*m, y = c.height*.05+16+2*m; return Array.from({ length: 80 }, (_, i) => ctx.getImageData(x + (i % 10) * m + Math.floor(m / 2), y + Math.floor(i / 10) * m + Math.floor(m / 2), 1, 1).data[0] < 128 ? 1 : 0); });
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await finish(); const first = await exportJson('#motionExportLast');
assert.equal(first.schema, 'dronecv-motion-run-3'); assert.equal(first.complete, true); assert.equal(first.mode, null); assert.equal(first.order, undefined);
assert.ok(first.samples.some(s => s.visible)); assert.ok(first.samples.some(s => !s.visible));
assert.deepEqual(markerPixels, await page.evaluate(({ run, step }) => Motion.markerBits(run, step), { run: first.run_id, step: 2 })); assert.equal(first.conditions.distance_cm, null);
assert.equal(first.marker.module_px > 0, true); assert.equal(first.calibration_points.length, 4);
await cleanSettings();
if (process.env.CLEAN_SHOT) await page.screenshot({path:process.env.CLEAN_SHOT});
// Repeat uses the last snapshot even after controls and shared object bounds change.
await page.fill('#motionWidth','50'); await page.fill('#motionSpeed','600');
await page.evaluate(id => { BOUNDS[id].bbox[0] += 1; save('object_bounds',BOUNDS); }, selected);
await fullRun('#motionRepeat'); let bundle = await exportJson('#motionExport');
assert.deepEqual(bundle.runs[0].scenario, bundle.runs[1].scenario);
assert.deepEqual(bundle.runs[0].photo, bundle.runs[1].photo);
assert.deepEqual(bundle.runs[0].samples.map(({run_id,...s})=>s),bundle.runs[1].samples.map(({run_id,...s})=>s));
await cleanSettings();
await fullRun(); await cleanSettings();
bundle = await exportJson('#motionExport');
assert.equal(bundle.runs.length,3); assert.equal(bundle.runs[2].scenario.target_width_px,50);
assert.equal(bundle.runs[2].scenario.max_speed_px_s,600);
assert.equal(new Set(bundle.runs.map(r=>r.run_id)).size,3);
assert.ok(bundle.runs.every(r=>r.mode===null && !('pair_index' in r)));
await start(); await tick(0); await page.click('#motionStop'); await cleanSettings();
let aborted = await exportJson('#motionExportLast'); assert.equal(aborted.complete,false); assert.match(aborted.abort_reason,/оператором/);
await start(); await tick(0); await page.keyboard.press('Escape'); await cleanSettings();
aborted = await exportJson('#motionExportLast'); assert.equal(aborted.complete,false);
await start(); await tick(0); await page.evaluate(()=>document.exitFullscreen()); await cleanSettings();
aborted = await exportJson('#motionExportLast'); assert.equal(aborted.complete,false);
// Invalid motion must return to clean settings and permit the next run.
await page.fill('#motionWidth','99999'); await page.click('#motionStart');
await page.waitForFunction(()=>/Не удалось начать/.test(document.getElementById('motionStatus').textContent),null,{polling:100});
await cleanSettings(); await page.fill('#motionWidth','60'); await fullRun(); await cleanSettings();
// Synthetic Android journal exercises the local import, image calibration and report UI.
const jpeg = await page.evaluate(() => { const c=document.createElement('canvas'); c.width=c.height=100; return c.toDataURL('image/jpeg'); });
const syntheticSamples=Array.from({length:31},(_,i)=>({run_id:'12345678',step_id:i,elapsed_ms:i*100,visible:i>=5&&i<25,phase:i<5?'blank_before':i<25?'cruise':'blank_after',bbox_screen_px:i>=5&&i<25?[20,20,40,40]:null}));
const syntheticRun={schema:'dronecv-motion-run-1',run_id:'12345678',mode:'yolo',complete:true,samples:syntheticSamples,duration_ms:3000,calibration_points:[[0,0],[100,0],[100,100],[0,100]],photo:{id:'synthetic'},conditions:{setup_id:'synthetic'},scenario:{target_width_px:20,acceleration_px_s2:100}};
const syntheticJournal={schema:'dronecv-motion-android-1',mode:'yolo',complete:true,truncated:false,stop_ns:3000e6,geometry:{width:100,height:100},calibration_image:{width:100,height:100,data_url:jpeg},frames:syntheticSamples.map((s,i)=>({frame_id:i,analyzer_ns:i*1e8,capture_ns:i*1e8,marker:{run_id:s.run_id,step_id:i}})),detections:[{frame_id:5,published_ns:600e6,bbox:[.26,.26,.42,.42]}],publications:[{frame_id:5,published_ns:600e6,bbox:[.26,.26,.42,.42],source:'yolo'},{frame_id:null,published_ns:2500e6,bbox:null,source:'clear'}]};
const jsonFile=(name,value)=>({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
await page.setInputFiles('#reportReference',jsonFile('synthetic-reference.json',syntheticRun));
await page.setInputFiles('#reportJournals',jsonFile('synthetic-journal.json',syntheticJournal));
await page.waitForFunction(()=>document.getElementById('reportCanvas').width===100, null, {polling:100});
await page.click('#reportReset');
for(const [x,y] of [[10,10],[90,10],[90,90],[10,90]]) await page.locator('#reportCanvas').click({position:{x,y}});
await page.click('#reportCalculate');
assert.match(await page.textContent('#reportOutput'),/Результаты по прогонам/);
assert.match(await page.textContent('#reportOutput'),/критерий: пройден/);
const report=await exportJson('#reportExport');assert.equal(report.runs[0].capture_latency_ms,100);assert.equal(report.runs[0].pass,true);
// Exercise the streamed NDJSON file input with exact Long values beyond 2^53.
const origin=90071992547409930n, frameOrigin=90071992547419930n, timeline=[];
function timelineRow(type,data,time) {timeline.push({schema:'dronecv-session-timeline-1',session_id:'synthetic',event_id:String(timeline.length+1),event_ns:String(origin+BigInt(time)),type,data});}
timelineRow('header',{start_ns:String(origin),clock:'elapsed_realtime_ns',mode:'yolo'},0);
timelineRow('metadata',{geometry:syntheticJournal.geometry,calibration_image:syntheticJournal.calibration_image},0);
for(const f of syntheticJournal.frames) timelineRow('frame',{frame_id:String(frameOrigin+BigInt(f.frame_id)),analyzer_entry_ns:String(origin+BigInt(f.analyzer_ns)),capture_ns:String(origin+BigInt(f.capture_ns)),timebase:'elapsed_realtime',marker:f.marker},f.analyzer_ns);
for(const d of syntheticJournal.detections) timelineRow('detection',{frame_id:String(frameOrigin+BigInt(d.frame_id)),published_ns:String(origin+BigInt(d.published_ns)),bbox:d.bbox},d.published_ns);
for(const p of syntheticJournal.publications) timelineRow('publication',{frame_id:p.frame_id===null?null:String(frameOrigin+BigInt(p.frame_id)),published_ns:String(origin+BigInt(p.published_ns)),bbox:p.bbox,source:p.source},p.published_ns);
const accepted=String(timeline.length);
timelineRow('session_end',{stop_ns:String(origin+3000000000n),recording_complete:true,experiment_status:'not_observed',interrupted:false,accepted_count:accepted,written_count:accepted,dropped_count:'0',missing_first_event_id:null,missing_last_event_id:null},3000000000);
await page.setInputFiles('#reportJournals',{name:'synthetic-timeline.ndjson',mimeType:'application/x-ndjson',buffer:Buffer.from(timeline.map(r=>JSON.stringify(r)).join('\n')+'\n')});
await page.waitForFunction(()=>document.getElementById('reportCanvas').width===100 && /Калибровка не выполнена/.test(document.getElementById('reportStatus').textContent), null, {polling:100});
await page.click('#reportReset');
for(const [x,y] of [[10,10],[90,10],[90,90],[10,90]]) await page.locator('#reportCanvas').click({position:{x,y}});
await page.click('#reportCalculate');
assert.match(await page.textContent('#reportOutput'),/критерий: пройден/);
const timelineReport=await exportJson('#reportExport');
assert.equal(timelineReport.runs[0].criterion_version,'motion-retention-v3');
assert.equal(timelineReport.runs[0].capture_latency_ms,100);
assert.equal(timelineReport.runs[0].capture_frame_id,String(frameOrigin+5n));
assert.equal(timelineReport.runs[0].pass,true);
assert.equal(timelineReport.runs[0].good_fraction_lower,report.runs[0].good_fraction_lower);
// Synthetic multiple conditions and uncertain observation must agree in UI and export.
const runs=[]; const journals=[];
for (const [id,speed,accel,missing] of [['a1',100,200,false],['a2',100,200,false],['b1',300,600,false],['b2',300,600,false],['u1',100,300,true]]) {
 const samples=syntheticSamples.map(x=>({...x,run_id:id}));
 runs.push({...syntheticRun,run_id:id,samples,scenario:{target_width_px:20,width:100,height:100,laps:2,max_speed_px_s:speed,acceleration_px_s2:accel}});
 const frames=syntheticJournal.frames.map((f,i)=>({...f,marker:missing&&i===10?null:{run_id:id,step_id:i}}));
 journals.push({...syntheticJournal,frames});
}
await page.setInputFiles('#reportReference',jsonFile('series.json',{schema:'dronecv-motion-series-1',runs}));
await page.setInputFiles('#reportJournals',journals.map((j,i)=>jsonFile(`journal-${i}.json`,j)));
for(let i=0;i<journals.length;i++) {
 await page.selectOption('#reportSelect',String(i));
 await page.waitForFunction(()=>document.getElementById('reportCanvas').width===100, null, {polling:100});
 await page.click('#reportReset');
 for(const [x,y] of [[10,10],[90,10],[90,90],[10,90]]) await page.locator('#reportCanvas').click({position:{x,y}});
}
await page.click('#reportCalculate');
const outputText=await page.textContent('#reportOutput');
assert.match(outputText,/критерий: не определён/); assert.match(outputText,/[Нн]еизвестно: 400\.0 мс/);
assert.match(outputText,/ограничение скорости 100 px\/с: 200 px\/с²/);
assert.match(outputText,/ограничение скорости 300 px\/с: 600 px\/с²/);
const multiReport=await exportJson('#reportExport');
assert.equal(multiReport.schema,'dronecv-motion-report-4');
assert.equal(multiReport.runs[0].center_error.version,'motion-center-error-v1');
assert.equal(multiReport.runs[0].center_error.units,'camera_px');
assert.equal(multiReport.runs[0].provenance.android.fields.git_sha,null);
assert.match(await page.textContent('#reportOutput'), /Ошибка центра.*условно/);
assert.match(await page.textContent('#reportOutput'), /p50.*p95/);
assert.equal(multiReport.runs.find(r=>r.run_id==='u1').pass,null);
assert.equal(multiReport.runs[0].criterion_version,'motion-retention-v3');
assert.equal(multiReport.runs[0].timing_status,'compatible');
assert.equal(multiReport.runs[0].offset_lower_ms,-100); assert.equal(multiReport.runs[0].offset_upper_ms,0);
assert.equal(multiReport.runs.find(r=>r.run_id==='u1').unknown_ms,400);
assert.deepEqual(multiReport.maxima.map(m=>[m.max_speed_px_s,m.max_acceleration_px_s2]),[[100,200],[300,600]]);
const after = await page.evaluate(() => JSON.parse(sessionJson()));
assert.deepEqual(after.sample, previous.sample); assert.deepEqual(after.results, previous.results); assert.equal(after.trial.run_id, previous.trial.run_id);
await page.evaluate(() => { const s=load('motion_settings',{}); s.photo_id='missing-saved-photo'; save('motion_settings',s); });
await page.reload(); await page.click('[data-section=motion]');
assert.equal(await page.inputValue('#motionPhoto'),'missing-saved-photo');
assert.match(await page.textContent('#motionPhotoStatus'),/фотография недоступна/);
await page.click('#motionStart');
assert.match(await page.textContent('#motionStatus'),/фотография недоступна/);
await cleanSettings();
// Missing file with surviving metadata is reported too, without a fallback photo.
await page.selectOption('#motionPhoto',selected);
await page.evaluate(id => { M.find(m=>m.id===id).file='images/missing-motion-test.jpg'; MotionUI.refresh(); },selected);
await page.waitForFunction(()=>/фотография недоступна/.test(document.getElementById('motionPhotoStatus').textContent),null,{polling:100});
await page.click('#motionStart');
await page.waitForFunction(()=>/Не удалось начать/.test(document.getElementById('motionStatus').textContent),null,{polling:100});
await cleanSettings();
// Real animation clock and native fullscreen: let one complete lap end by itself.
const realtime = await context.newPage();
realtime.on('pageerror',e=>errors.push(String(e)));
await realtime.goto('file://' + path.join(dir,'gallery.html'));
await realtime.click('[data-section=motion]'); await realtime.selectOption('#motionPhoto',selected);
for (const [key,value] of Object.entries({motionWidth:'60',motionSpeed:'50000',motionAcceleration:'10000000',motionLaps:'1'})) await realtime.fill('#'+key,value);
await realtime.click('#motionStart');
await realtime.waitForFunction(()=>document.fullscreenElement?.id==='motionStage' && document.getElementById('settings').classList.contains('hidden'),null,{polling:100});
await realtime.waitForFunction(()=>!document.fullscreenElement && /Запуск завершён/.test(document.getElementById('motionStatus').textContent),null,{polling:100});
const [realDownload] = await Promise.all([realtime.waitForEvent('download'),realtime.click('#motionExportLast')]);
const realRun=JSON.parse(fs.readFileSync(await realDownload.path(),'utf8'));
assert.equal(realRun.complete,true); assert.equal(realRun.scenario.laps,1);
assert.equal(realRun.samples.at(-1).phase,'blank_after');
assert.ok(realRun.samples.at(-1).elapsed_ms>=realRun.duration_ms);
assert.equal(await realtime.locator('#stage').isVisible(),false);
assert.equal(await realtime.locator('#hud').isVisible(),false);
assert.equal(await realtime.locator('#motionStage').isVisible(),false);
assert.equal(await realtime.locator('#settings').isVisible(),true);
assert.equal(await realtime.evaluate(()=>document.getElementById('motionCanvas').width),0);
if (process.env.CLEAN_SHOT) await realtime.screenshot({path:process.env.CLEAN_SHOT});
await realtime.close();
assert.deepEqual(errors, []); assert.deepEqual(network, []);
await context.close(); await browser.close();
console.log('motion persistence, independent runs, repeat snapshot, natural finish, stop, Esc, error cleanup, legacy imports and gallery preservation: OK');

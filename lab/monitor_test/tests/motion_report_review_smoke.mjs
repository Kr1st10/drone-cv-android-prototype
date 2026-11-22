// Real Chrome/IndexedDB; synthetic journals/JPEGs, not phone measurements.
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],failures=[];
page.on('pageerror',e=>errors.push(String(e)));
const root=path.resolve(process.argv[2]);
const file=(name,data)=>({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
async function imported(items){await page.setInputFiles('#reportJournals',items.map(([name,data])=>file(name,data)));await page.waitForFunction(n=>document.querySelector('#reportSelect').options.length===n&&!document.querySelector('#reportSelect').disabled,items.length,{polling:50});}
async function check(name,work){try{await work();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}}
const text=id=>page.locator('#'+id).count().then(n=>n?page.locator('#'+id).textContent():'<missing>');
try{
 await page.goto('file://'+path.join(root,'gallery.html'));await page.click('[data-section=motion]');
 await page.locator('#motionJournalReport > summary').click();
 const {run,journal,missing}=await page.evaluate(async()=>{
  const run_id='12345678',width=640,height=480,c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
  const tags=[[0,20,20],[1,560,20],[2,560,400],[3,20,400]].map(([id,x,y])=>({id,x,y,size:48}));tags.forEach(t=>MotionCalibration.draw(ctx,t));const jpeg=c.toDataURL('image/jpeg',.85);ctx.fillStyle='#fff';ctx.fillRect(558,398,52,52);const missing=c.toDataURL('image/jpeg',.85);
  const samples=Array.from({length:61},(_,i)=>({run_id,step_id:i,elapsed_ms:i*100,phase:i<5?'calibration':i<15?'stationary':i<30?'cruise':i<40?'disappearance':i<55?'cruise':'blank_after',visible:i>=5&&i<30||i>=40&&i<55,bbox_screen_px:i>=5&&i<30||i>=40&&i<55?[200,150,300,250]:null}));
  const run={schema:'dronecv-motion-run-2',run_id,mode:null,complete:true,scenario:{version:'simple-motion-v1'},photo:{id:'synthetic'},samples,duration_ms:6000,calibration_points:tags.map(t=>[t.x+24,t.y+24])};
  const journal={schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,truncated:false,stop_ns:6100e6,geometry:{width,height},calibration_image:{width,height,data_url:jpeg},frames:samples.map((s,i)=>({frame_id:i,capture_ns:(i*100+40)*1e6,analyzer_ns:(i*100+45)*1e6,marker:{run_id,step_id:i}})),detections:[],publications:samples.map((s,i)=>({frame_id:i,published_ns:(i*100+50)*1e6,bbox:s.bbox_screen_px?.map((v,k)=>v/(k%2?height:width))??null,source:s.visible?'yolo':'clear'}))};
  await MotionStore.save(run);return {run,journal,missing};
 });
 const sparse={...journal,frames:[journal.frames[0],{...journal.frames[1],marker:null},journal.frames[2]],publications:[],complete:false,truncated:true,calibration_image:{...journal.calibration_image,data_url:missing}};
 await check('readability/timing with three corners and incomplete journal',async()=>{await imported([['three.json',sparse]]);assert.match(await text('reportSyncStatus'),/2 из 3/);assert.match(await text('reportTimingStatus'),/сопоставлено 2/);assert.match(await text('reportTimingStatus'),/неполный/i);assert.match(await text('reportCalibrationStatus'),/нижняя правая/);assert.equal(await page.isEnabled('#reportExport'),false);});
 await check('readability without JPEG',async()=>{await imported([['none.json',{...journal,calibration_image:null}]]);assert.match(await text('reportSyncStatus'),/61 из 61/);assert.match(await text('reportTimingStatus'),/сопоставлено 61/);assert.match(await text('motionCameraStatus'),/кадр отсутствует/i);assert.doesNotMatch(await text('motionCameraStatus'),/4 из 4/);assert.equal(await page.evaluate(()=>document.querySelector('#reportCanvas').width),0);});
 await check('readability without reference',async()=>{const j={...journal,calibration_image:null,frames:journal.frames.map(f=>({...f,marker:{...f.marker,run_id:'deadbeef'}}))};await imported([['foreign.json',j]]);assert.match(await text('reportSyncStatus'),/61 из 61/);assert.match(await text('reportSyncStatus'),/deadbeef/);assert.match(await text('reportTimingStatus'),/Эталон deadbeef отсутствует/);});
 await check('multiple IDs remain readable but cannot align arbitrarily',async()=>{const j=structuredClone(journal);j.frames[0].marker.run_id='deadbeef';await imported([['multiple.json',j]]);assert.match(await text('reportSyncStatus'),/12345678.*deadbeef|deadbeef.*12345678/);assert.match(await text('reportTimingStatus'),/несколько разных запусков/);});
 const second=structuredClone(run);second.run_id='87654321';second.samples.forEach(s=>s.run_id=second.run_id);await page.evaluate(r=>MotionStore.save(r),second);
 const secondJournal=structuredClone(journal);secondJournal.frames.forEach(f=>f.marker.run_id=second.run_id);
 await check('two JPEGs prepare report without selecting second',async()=>{await imported([['good-a.json',journal],['good-b.json',secondJournal]]);assert.equal(await page.isEnabled('#reportExport'),true);assert.match(await text('reportOutput'),/12345678/);assert.match(await text('reportOutput'),/87654321/);assert.equal(await page.inputValue('#reportSelect'),'0');});
 await check('one error does not invalidate another calibration',async()=>{await imported([['good-a.json',journal],['bad-b.json',{...secondJournal,calibration_image:null}]]);assert.match(await text('reportCalibrationStatus'),/Калибровка выполнена/);assert.match(await text('reportStatus'),/bad-b.json/);assert.doesNotMatch(await text('reportCalibrationStatus'),/Калибровка не выполнена/);assert.equal(await page.isEnabled('#reportExport'),false);await page.selectOption('#reportSelect','1');assert.match(await text('motionCameraStatus'),/кадр отсутствует/i);});
 await check('switch/new import supersede delayed image decode',async()=>{
  await page.evaluate(()=>{window.NativeImage=Image;const setter=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src').set;window.Image=function(){const im=new NativeImage();Object.defineProperty(im,'src',{set(v){window.startedDecodes=(window.startedDecodes||0)+1;setTimeout(()=>setter.call(im,v),250);}});return im;};});
  await page.selectOption('#reportSelect','0');await page.selectOption('#reportSelect','1');await page.waitForTimeout(350);assert.match(await text('motionCameraStatus'),/кадр отсутствует/i);assert.equal(await page.evaluate(()=>document.querySelector('#reportCanvas').width),0);
  await page.setInputFiles('#reportJournals',[file('slow-image.json',journal)]);await page.waitForFunction(()=>window.startedDecodes>1,null,{polling:50});await imported([['new-no-jpeg.json',{...journal,calibration_image:null}]]);await page.waitForTimeout(350);assert.match(await text('motionCameraStatus'),/кадр отсутствует/i);assert.equal(await page.evaluate(()=>document.querySelector('#reportCanvas').width),0);await page.evaluate(()=>{window.Image=NativeImage;});
 });
 await check('manual state distinct and current',async()=>{await imported([['manual.json',journal]]);await page.click('#reportReset');assert.match(await text('motionCameraStatus'),/Ручная калибровка/);assert.match(await text('reportCalibrationStatus'),/0 из 4/);assert.equal(await page.isEnabled('#reportExport'),false);});
 await check('readability does not depend on reference storage availability',async()=>{
  await page.evaluate(()=>{window.originalList=MotionStore.list;MotionStore.list=()=>Promise.reject(Error('synthetic storage read failure'));});
  await page.setInputFiles('#reportJournals',[file('storage-error.json',sparse)]);await page.waitForFunction(()=>document.querySelector('#reportStatus').textContent.includes('synthetic storage read failure'),null,{polling:50});
  assert.match(await text('reportSyncStatus'),/2 из 3/);assert.match(await text('reportSyncStatus'),/storage-error.json/);assert.match(await text('reportTimingStatus'),/недоступно/);
  await page.evaluate(()=>{MotionStore.list=originalList;});
 });
 await check('named statuses fit mobile panel',async()=>{
  const name='motion-journal-2026-11-15-0123456789abcdef-0123456789abcdef.json';await imported([[name,journal]]);await page.setViewportSize({width:375,height:812});
  await page.locator('#reportSyncStatus').scrollIntoViewIfNeeded();const size=await page.evaluate(()=>{const p=document.querySelector('#settings');return {scroll:p.scrollWidth,client:p.clientWidth};});assert.ok(size.scroll<=size.client+1,JSON.stringify(size));
  await page.screenshot({path:'/private/tmp/pr43-review-status-mobile.png'});await page.setViewportSize({width:1280,height:800});await page.waitForTimeout(100);await page.screenshot({path:'/private/tmp/pr43-review-status-desktop.png'});
 });
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);console.log('report review browser regressions passed');
}finally{await browser.close();}

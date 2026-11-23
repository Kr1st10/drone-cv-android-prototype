import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:2});
const errors=[],remote=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('request',r=>{if(/^https?:/.test(r.url()))remote.push(r.url());});
await page.goto('file://'+path.join(path.resolve(process.argv[2]),'gallery.html'));
await page.click('[data-section=reference]');
assert.equal(await page.inputValue('#referenceDrone'),'cabinet_reference');
assert.equal(await page.locator('#referenceDrone option').count(),4);
await page.click('#screenCalibBtn'); await page.fill('#screenLineCm','10'); await page.click('#applyScreenCalib'); await page.keyboard.press('Escape');
await page.fill('#distance','434');
const snap=()=>page.evaluate(()=>referenceTab.snapshot());
const newPhotos = {
 cabinet_img_2751_v2: [930, 175, 14.105],
 cabinet_img_2704_v2: [3739, 3473, 18.5752],
 cabinet_img_2711_v2: [3708, 2587, 18.5431461366],
 cabinet_img_2755_v2: [860, 250, 18.5153418386]
};
assert.equal(await page.inputValue('#referencePhotoSelect'),'cabinet_img_2751_v2');
for(const id of ['cabinet_front','cabinet_oblique_candidate','cabinet_top',...Object.keys(newPhotos)]){
 await page.selectOption('#referencePhotoSelect',id);
 await page.waitForFunction(()=>referenceTab.snapshot().load_state==='ready');
 await page.fill('#referenceScaleNumber','20'); await page.locator('#referenceViewport').scrollIntoViewIfNeeded();
 const a=await snap(); assert.ok(a.equivalent_distance_m>0,JSON.stringify(a));
 assert.ok(await page.isHidden('#referenceRangeMode'));
 if (newPhotos[id]) {
  const dimensions=await page.locator('#referenceDisplay').evaluate(img=>[img.naturalWidth,img.naturalHeight]);
  assert.deepEqual(dimensions,newPhotos[id].slice(0,2));
  assert.equal(a.geometry_revision,'cabinet_motor_geometry_v2');
  assert.equal(a.geometry_status,'modelled_approximate');
  assert.equal(a.projection_confirmed,false);
 }
 assert.match(await page.getAttribute('#referencePhotoSource a','href'),/cabinet\/IMG_27\d{2}\.jpg$/);
 await page.locator('#referenceSegmentReview').evaluate(e=>e.open=true);
 await page.check('#referenceSegmentToggle');
 // The preview can replace this line when it redraws after scrolling.
 const drawnCssPx=await page.evaluate(()=>{
  const line=document.querySelector('#referenceSegmentOverlay line');
  const transform=line.getScreenCTM();
  const start=new DOMPoint(line.x1.baseVal.value,line.y1.baseVal.value).matrixTransform(transform);
  const end=new DOMPoint(line.x2.baseVal.value,line.y2.baseVal.value).matrixTransform(transform);
  return Math.hypot(end.x-start.x,end.y-start.y);
 });
 assert.ok(Math.abs(drawnCssPx*0.25-a.display_axis_cm*10)<0.005);
 await page.uncheck('#referenceSegmentToggle');
 await page.locator('#referenceSegmentReview').evaluate(e=>e.open=false);
 await page.click('#referenceHalf'); await page.locator('#referenceViewport').scrollIntoViewIfNeeded();
 assert.ok(Math.abs((await snap()).equivalent_distance_m/a.equivalent_distance_m-2)<0.001);
 assert.match(await page.textContent('#referenceAssumption'),newPhotos[id]?/Модельная оценка.*Физическая длина.*расчётная проекция/:
  id==='cabinet_oblique_candidate'?/Предварительная оценка/:/Измеренный отрезок/);
 assert.match(await page.textContent('#referenceReadout'),/≈ [\d\s]+,\d{2} м/);
 await page.fill('#referenceTarget','100,00'); await page.click('#referenceApplyTarget');
 const target=await snap();
 assert.ok(Math.abs(target.equivalent_distance_m-100)<0.2);
 if (newPhotos[id]) {
  assert.ok(Math.abs(target.review_segment_display_mm-newPhotos[id][2])<0.01);
  assert.ok(target.fullscreen_fits);
 }

}
await page.selectOption('#referencePhotoSelect','cabinet_img_2704_v2');
await page.waitForFunction(()=>referenceTab.snapshot().load_state==='ready');
// Top-view diagonal: 428 mm at 50 cm gives 100 m at 2.14 mm on screen.
await page.fill('#distance','50');
await page.fill('#referenceTarget','100,00'); await page.click('#referenceApplyTarget');
assert.ok(Math.abs((await snap()).equivalent_distance_m-100)<0.2);
assert.ok(Math.abs((await snap()).display_axis_cm-0.214)<0.001);
const before=await snap();
await page.selectOption('#referenceCamera','1'); await page.locator('#referenceViewport').scrollIntoViewIfNeeded();
assert.equal((await snap()).equivalent_distance_m,before.equivalent_distance_m);
await page.selectOption('#referenceCamera','5'); await page.selectOption('#referenceBackground','sky');
assert.match(await page.textContent('#referenceBackgroundNote'),/непрозрачное/);
await page.locator('#referenceViewport').scrollIntoViewIfNeeded();
const width=await page.locator('#referenceDisplay').evaluate(e=>e.getBoundingClientRect().width),cal=(await snap()).calibration_id;
await page.click('#referenceTrial'); await page.waitForFunction(()=>document.fullscreenElement?.id==='referenceViewport');
assert.equal(await page.locator('#referenceDisplay').evaluate(e=>e.getBoundingClientRect().width),width);
assert.equal((await snap()).calibration_id,cal);
assert.equal((await snap()).equivalent_distance_m,before.equivalent_distance_m);
assert.equal(await page.locator('#referenceViewport').evaluate(e=>[...e.children].filter(c=>getComputedStyle(c).display!=='none').map(c=>c.id).join(',')),'referenceDisplay');
await page.keyboard.press('r'); assert.equal(await page.locator('#record').isVisible(),false);
await page.screenshot({path:'/tmp/reference5x-trial.png'});
await page.evaluate(()=>document.exitFullscreen()); await page.waitForFunction(()=>!document.fullscreenElement); await page.waitForFunction(()=>referenceTab.snapshot().trial_phase==='idle');
await page.locator('#referenceViewport').scrollIntoViewIfNeeded();
assert.equal((await snap()).calibration_id,cal);
assert.equal(await page.locator('#referenceDisplay').evaluate(e=>e.getBoundingClientRect().width),width);
for(const [value,message] of [['0.001',/вне диапазона/],['0.5',/не помещается.*полноэкран/ ],['abc',/положительную/]]){
 await page.fill('#referenceTarget',value);await page.click('#referenceApplyTarget');assert.match(await page.textContent('#referenceTargetStatus'),message);
}
await page.selectOption('#referenceBackground','neutral');
await page.click('#referenceTrial'); await page.waitForFunction(()=>document.fullscreenElement?.id==='referenceViewport');
assert.equal(await page.locator('#referenceViewport').evaluate(e=>getComputedStyle(e).backgroundImage),'none');
await page.evaluate(()=>document.getElementById('invalidateScreen').click());
await page.waitForFunction(()=>!document.fullscreenElement);
assert.match(await page.textContent('#referenceTargetStatus'),/Испытание остановлено/);
await page.setViewportSize({width:1100,height:900});assert.equal((await snap()).equivalent_distance_m,null);
await page.fill('#referenceTarget','100');await page.click('#referenceApplyTarget');assert.match(await page.textContent('#referenceTargetStatus'),/калибровка/);
assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
await browser.close();console.log('Cabinet views, inverse 100m, 434cm, 1×/5×, fullscreen CSS/calibration, unreachable targets: OK');

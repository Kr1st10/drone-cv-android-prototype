// State/DOM regressions: preview clipping, repeated/racing loads and calibration lifecycle.
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.env.PLAYWRIGHT_NODE_DIR||process.cwd(),'x.js'))('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
try {
 const page=await browser.newPage({viewport:{width:1000,height:700},screen:{width:1280,height:1000},deviceScaleFactor:2}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const snap=()=>page.evaluate(()=>referenceTab.snapshot());
 const settle=()=>page.waitForFunction(()=>referenceTab.snapshot().load_state==='ready');
 await page.goto('file://'+path.join(path.resolve(process.argv[2]),'gallery.html'));
 await page.click('[data-section=reference]');
 await page.click('#screenCalibBtn');await page.fill('#screenLineCm','10');await page.click('#applyScreenCalib');await page.keyboard.press('Escape');
 await page.addStyleTag({content:'#referenceViewport:not(:fullscreen){height:80px}'});
 await page.fill('#distance','400');await page.fill('#referenceScaleNumber','57');
 await settle();
 assert.ok((await snap()).equivalent_distance_m>0,'400cm / 57% must calculate despite clipped preview');
 const calibration=(await snap()).calibration_id;
 assert.ok(await page.evaluate(()=>{
  const env=screenEnvironment(), match=referenceTab.calibrationEnvironmentMatches;
  return match(env,{...env,viewport_width:env.viewport_width-100},true)&&
   ['dpr','width','height','available_width','available_height','visual_scale','x','y'].every(k=>!match(env,{...env,[k]:env[k]+1},true))&&
   !match(env,{...env,viewport_width:env.viewport_width-100},false);
 }));
 await page.evaluate(()=>{
  window.framesSeen=[];window.sampleReference=true;
  const sample=()=>{if(!window.sampleReference)return;window.framesSeen.push({...referenceTab.snapshot(),readout:document.getElementById('referenceReadout').textContent,natural:document.getElementById('referenceDisplay').naturalWidth});requestAnimationFrame(sample);};sample();
 });
 for(let cycle=0;cycle<5;cycle++)for(const photo of ['cabinet_oblique_candidate','cabinet_top','cabinet_front','cabinet_oblique_candidate','cabinet_top']){
  await page.selectOption('#referencePhotoSelect',photo);if(cycle>0)assert.equal((await snap()).load_state,'ready','warm switches commit synchronously without a blank frame');await settle();
  const s=await snap();assert.equal(s.photo_id,photo);assert.equal(s.calibration_id,calibration);assert.equal(s.screen_distance_cm,400);assert.equal(s.scale_percent,57);
  const p=await page.evaluate(id=>DroneReferences.profiles[0].photos.find(p=>p.id===id),photo);
  const { from, to, real_mm }=p.review_segment;
  const expected=4*real_mm/(Math.hypot(to[0]-from[0],to[1]-from[1])*.57*.25);
  assert.ok(Math.abs(s.equivalent_distance_m-expected)<0.005,JSON.stringify({s,expected,cal:await page.evaluate(()=>activeScreenCalibration())}));
  await page.locator('#settings').evaluate(e=>e.scrollTop=e.scrollHeight);assert.equal((await snap()).equivalent_distance_m,s.equivalent_distance_m);
 }
 // Force delayed, out-of-order load events, for all three cabinet photographs.
 await page.evaluate(()=>{
  DroneReferences.profiles[0].photos.forEach((p,i)=>p.file+='?race='+i);
  const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(url){const img=this;const handler=img.onload;img.onload=e=>setTimeout(()=>handler?.call(img,e),url.includes('2707')?180:20);descriptor.set.call(img,url);}});
  for(const id of ['cabinet_front','cabinet_top','cabinet_front','cabinet_oblique_candidate']){const e=document.getElementById('referencePhotoSelect');e.value=id;e.dispatchEvent(new Event('change'));}
 });
 await settle();await page.waitForTimeout(250);assert.equal((await snap()).photo_id,'cabinet_oblique_candidate');assert.equal((await snap()).calibration_id,calibration);
 const frames=await page.evaluate(()=>{window.sampleReference=false;return window.framesSeen;});assert.ok(frames.length>25);
 for(const s of frames){
  assert.equal(s.calibration_id,calibration);
  if(s.load_state==='ready'){assert.ok(s.equivalent_distance_m>0);assert.doesNotMatch(s.readout,/нет данных|Загрузка/);assert.equal(s.natural,s.photo_id==='cabinet_front'?1010:s.photo_id==='cabinet_top'?920:905);}
  else {assert.equal(s.equivalent_distance_m,null);assert.match(s.readout,/Загрузка/);}
 }
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:2,mobile:false,screenWidth:1280,screenHeight:1000});assert.equal((await snap()).calibration_id,calibration);
 await page.reload();await page.click('[data-section=reference]');await settle();assert.equal(await page.inputValue('#distance'),'400');assert.equal(await page.inputValue('#referenceScaleNumber'),'57');
 assert.equal((await snap()).equivalent_distance_m,null);await page.click('#confirmSavedScreen');assert.equal((await snap()).calibration_id,calibration);assert.ok((await snap()).equivalent_distance_m>0);
 await page.addStyleTag({content:'#referenceViewport:not(:fullscreen){height:80px}'});
 await page.fill('#referenceTarget','15,00');await page.click('#referenceApplyTarget');assert.match(await page.textContent('#referenceTargetStatus'),/рассчитан/);const before=await snap();
 const width=await page.locator('#referenceDisplay').evaluate(e=>e.getBoundingClientRect().width);
 await page.click('#referenceTrial');await page.waitForFunction(()=>document.fullscreenElement?.id==='referenceViewport');assert.equal((await snap()).equivalent_distance_m,before.equivalent_distance_m);assert.equal(await page.locator('#referenceDisplay').evaluate(e=>e.getBoundingClientRect().width),width);
 await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>!document.fullscreenElement);await page.waitForFunction(()=>referenceTab.snapshot().trial_phase==='idle');
 await page.fill('#referenceScaleNumber','1000');assert.ok((await snap()).equivalent_distance_m>0);assert.equal((await snap()).fullscreen_fits,false);
 await page.click('#referenceTrial');assert.equal(await page.evaluate(()=>document.fullscreenElement),null);assert.match(await page.textContent('#referenceTargetStatus'),/полноэкран/);
 await page.selectOption('#referenceDrone','skydroid_mx330t');await page.selectOption('#referencePhotoSelect','skydroid_front');await settle();assert.equal((await snap()).equivalent_distance_m,null);assert.match(await page.textContent('#referenceAssumption'),/не приравнивается/);
 await page.selectOption('#referenceDrone','unik_sd_10ufp');assert.equal((await snap()).load_state,'missing');assert.equal((await snap()).equivalent_distance_m,null);
 // Changing models must use the current model's geometry.
 await page.selectOption('#referenceDrone','cabinet_reference');await settle();assert.ok((await snap()).equivalent_distance_m>0);
 await page.selectOption('#referenceDrone','skydroid_mx330t');await page.selectOption('#referencePhotoSelect','skydroid_front');await settle();assert.equal((await snap()).equivalent_distance_m,null);
 // Recover after missing source; an incompatible decoded size must never inherit old metres.
 await page.selectOption('#referenceDrone','cabinet_reference');await settle();assert.ok((await snap()).equivalent_distance_m>0);assert.equal((await snap()).calibration_id,calibration);
 await page.evaluate(()=>{DroneReferences.profiles[0].photos[0].width+=1;document.getElementById('referencePhotoSelect').dispatchEvent(new Event('change'));});
 await page.waitForFunction(()=>referenceTab.snapshot().load_state==='error');assert.equal((await snap()).equivalent_distance_m,null);assert.equal((await snap()).calibration_id,calibration);
 await page.evaluate(()=>{DroneReferences.profiles[0].photos[0].width-=1;document.getElementById('referencePhotoSelect').dispatchEvent(new Event('change'));});await settle();assert.ok((await snap()).equivalent_distance_m>0);
 // Unlike panel/viewport layout, a real CSS-pixel scale change must invalidate calibration.
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:3,mobile:false,screenWidth:1280,screenHeight:1000});
 assert.equal((await snap()).calibration_id,null);assert.equal((await snap()).equivalent_distance_m,null);
 assert.deepEqual(errors,[]);console.log('Five switch cycles, delayed races, preview-independent math, 400cm/57%, reload, fullscreen limits: OK');
} finally {await browser.close();}

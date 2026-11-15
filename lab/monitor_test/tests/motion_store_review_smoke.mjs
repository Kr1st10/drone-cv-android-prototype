// Actual Chrome IndexedDB/reloads, with synthetic transaction failures.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const page=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true});
try {
  await page.goto('file://'+path.join(root,'gallery.html'));await page.waitForFunction(()=>!!window.MotionStore);
  const result=await page.evaluate(async()=>{
    const run=(id,tag)=>({schema:'dronecv-motion-run-2',run_id:id,mode:null,complete:true,abort_reason:null,photo:{id:tag},scenario:{version:'simple-motion-v1'},samples:[{step_id:0,elapsed_ms:0,run_id:id,visible:false}]});
    await MotionStore.save(run('11223344','prior'));const outcomes=[];
    for(const [index,phase] of ['after_metadata','data','finalization'].entries()) {
      const candidate=run('aabbccd'+index,phase),original=IDBObjectStore.prototype.put;let injected=false;
      IDBObjectStore.prototype.put=function(value,...args){
        const fail=this.name==='chunks'&&phase!=='finalization'||this.name==='runs'&&phase==='finalization';
        if(!injected&&fail){injected=true;if(phase==='after_metadata')throw new DOMException('injected write failure','QuotaExceededError');const request=original.call(this,value,...args),transaction=this.transaction;request.addEventListener('success',()=>transaction.abort(),{once:true});return request;}
        return original.call(this,value,...args);
      };
      let rejected=false;try{await MotionStore.save(candidate);}catch{rejected=true;}finally{IDBObjectStore.prototype.put=original;}
      outcomes.push({phase,injected,rejected,remaining:(await MotionStore.list()).filter(r=>r.run_id===candidate.run_id).length});
      if(outcomes.at(-1).remaining)break;
      await MotionStore.save(candidate);await MotionStore.save(Object.fromEntries(Object.entries(candidate).reverse()));
      outcomes.at(-1).retry_count=(await MotionStore.list()).filter(r=>r.run_id===candidate.run_id).length;
    }
    return {outcomes,prior:(await MotionStore.list()).filter(r=>r.run_id==='11223344').length};
  });
  assert.deepEqual(result.outcomes.map(o=>({phase:o.phase,injected:o.injected,rejected:o.rejected,remaining:o.remaining})),['after_metadata','data','finalization'].map(phase=>({phase,injected:true,rejected:true,remaining:0})));
  assert.ok(result.outcomes.every(o=>o.retry_count===1));assert.equal(result.prior,1);
  await page.evaluate(async()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='chunks')throw new DOMException('interrupted import','QuotaExceededError');return original.apply(this,args);};try{await MotionStore.save({schema:'dronecv-motion-run-2',run_id:'ddcc0001',complete:true,samples:[{step_id:0}]});}catch{}finally{IDBObjectStore.prototype.put=original;}});
  await page.reload();await page.waitForFunction(()=>!!window.MotionStore);
  assert.equal(await page.evaluate(()=>MotionStore.list().then(r=>r.some(v=>v.run_id==='ddcc0001'))),false);
  await page.evaluate(()=>MotionStore.save({schema:'dronecv-motion-run-2',run_id:'ddcc0001',complete:true,samples:[{step_id:0}]}));
  assert.equal(await page.evaluate(()=>MotionStore.list().then(r=>r.filter(v=>v.run_id==='ddcc0001').length)),1);
  const history=await page.evaluate(async()=>{
    const make=(id,complete)=>({schema:'dronecv-motion-run-2',run_id:id,complete,abort_reason:complete?null:'остановлено оператором',samples:[{run_id:id,step_id:0,elapsed_ms:0}]});
    const a=make('ffffffff',true),b=make('00000001',false),ka=await MotionStore.begin(a);await MotionStore.append(ka,0,a.samples);await MotionStore.end(ka,a);
    const kb=await MotionStore.begin(b);await MotionStore.append(kb,0,b.samples);await MotionStore.end(kb,b);
    await MotionStore.settings({repeat:'B'});await MotionStore.save(make('eeeeeeee',true));
    const h=await MotionStore.history();return {last:h.last_local_run,unknown:h.chronology_unknown,sequence:h.runs.filter(r=>['ffffffff','00000001'].includes(r.run_id)).map(r=>r.run_id),repeat:await MotionStore.settings()};
  });
  assert.equal(history.last.run_id,'00000001');assert.equal(history.last.complete,false);assert.equal(history.unknown,false);assert.deepEqual(history.sequence,['ffffffff','00000001']);assert.deepEqual(history.repeat,{repeat:'B'});
  await page.reload();await page.waitForFunction(()=>!!window.MotionStore);assert.equal(await page.evaluate(()=>MotionStore.history().then(h=>h.last_local_run.run_id)),'00000001');
  const localDuplicate=await page.evaluate(async()=>{const r=(await MotionStore.list()).find(r=>r.run_id==='00000001');await MotionStore.save(r);return (await MotionStore.list()).filter(r=>r.run_id==='00000001').length;});assert.equal(localDuplicate,1);
  const conflict=await page.evaluate(async()=>{const r=(await MotionStore.list()).find(r=>r.run_id==='00000001');await MotionStore.save({...r,photo:{id:'true-conflict'}});return (await MotionStore.list()).filter(r=>r.run_id==='00000001');});
  assert.equal(conflict.length,2);assert.ok(!Object.keys(conflict[0]).some(k=>['local_sequence','source','key','created_at'].includes(k)));
  await page.evaluate(async()=>{const d=await new Promise((resolve,reject)=>{const r=indexedDB.open('dronecv-motion',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const t=d.transaction(['runs','chunks'],'readwrite');t.objectStore('runs').put({key:'legacy-key',run:{schema:'dronecv-motion-run-1',run_id:'c0ffee00',complete:false,samples:[]}});t.objectStore('chunks').put({key:'legacy-key:0',owner:'legacy-key',index:0,samples:[{run_id:'c0ffee00',step_id:0,elapsed_ms:0}]});t.oncomplete=resolve;t.onerror=()=>reject(t.error);});d.close();});
  const legacy=await page.evaluate(()=>MotionStore.history());assert.equal(legacy.chronology_unknown,true);assert.ok(legacy.runs.some(r=>r.run_id==='c0ffee00'&&r.samples.length===1));assert.equal(legacy.last_local_run.run_id,'00000001');
  // Exercise the actual last-export button, including real Stop/Esc handling.
  for(const ending of ['complete','Stop','Esc','pending','pending_end_failure']) {
    const p=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true});
    p.on('dialog',dialog=>dialog.accept());
    await p.addInitScript(()=>{let now=0,next=1;const callbacks=new Map();window.requestAnimationFrame=fn=>{const key=next++;callbacks.set(key,fn);return key;};window.cancelAnimationFrame=id=>callbacks.delete(id);window.advanceStoreReview=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};});
    await p.goto('file://'+path.join(root,'gallery.html'));await p.waitForFunction(()=>!!window.MotionStore);
    const old=await p.evaluate(async()=>{const run={schema:'dronecv-motion-run-2',run_id:'ffffffff',mode:null,complete:true,abort_reason:null,photo:{id:'A'},scenario:{version:'simple-motion-v1'},samples:[]};const key=await MotionStore.begin(run);await MotionStore.end(key,run);return run;});
    if(ending.startsWith('pending')){await p.reload();await p.waitForFunction(()=>!!window.MotionStore);}
    await p.click('[data-section=motion]');await p.selectOption('#motionPhoto','civ01');const bounds=await p.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ01').object_bbox);
    await p.click('#motionBounds');for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await p.fill('#'+id,String(bounds[i]));await p.click('#saveBounds');
    await p.evaluate(()=>{crypto.getRandomValues=array=>{array[0]=1;return array;};});
    if(ending.startsWith('pending'))await p.evaluate(failEnd=>{const begin=MotionStore.begin;MotionStore.begin=async run=>{const key=await begin(run);window.reviewBeginStored=true;await new Promise(resolve=>{window.releaseReviewBegin=resolve;});return key;};if(failEnd)MotionStore.end=()=>Promise.reject(new DOMException('injected finalization failure','QuotaExceededError'));},ending==='pending_end_failure');
    await p.click('#motionStart');
    if(ending.startsWith('pending')){
      await p.waitForFunction(()=>window.reviewBeginStored,null,{polling:50});await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.fullscreenElement,null,{polling:50});await p.evaluate(()=>releaseReviewBegin());
    }else{
      await p.waitForFunction(()=>document.fullscreenElement&&document.getElementById('settings').classList.contains('hidden'),null,{polling:50});await p.evaluate(()=>advanceStoreReview(0));await p.evaluate(()=>advanceStoreReview(100));
      if(ending==='Stop')await p.click('#motionStop');else if(ending==='Esc')await p.keyboard.press('Escape');else for(let i=0;i<1200;i++){if(!(await p.evaluate(()=>!!document.fullscreenElement)))break;await p.evaluate(()=>advanceStoreReview(100));}
    }
    await p.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled,null,{polling:50});
    const repeat=await p.evaluate(()=>MotionStore.settings());
    async function exported(){const [d]=await Promise.all([p.waitForEvent('download'),p.click('#motionExportLast')]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));}
    if(ending.startsWith('pending')){const immediate=await exported();assert.equal(immediate.run_id,'00000001','cancelled persisted begin must publish the same last run before reload');assert.equal(immediate.complete,false);}
    if(ending==='pending_end_failure'){assert.match(await p.textContent('#motionStatus'),/Ошибка сохранения/);const persisted=await p.evaluate(()=>MotionStore.history().then(h=>h.last_local_run));assert.equal(persisted.run_id,'00000001');assert.equal(persisted.complete,false);}
    await p.reload();await p.click('[data-section=motion]');await p.waitForFunction(()=>!document.getElementById('motionExportLast').disabled,null,{polling:50});let last=await exported();assert.equal(last.run_id,'00000001');assert.equal(last.complete,ending==='complete');
    await p.setInputFiles('#reportReference',{name:'old-A.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(old))});await p.waitForFunction(()=>document.getElementById('reportStatus').textContent.includes('Загружено эталонов'),null,{polling:50});
    await p.reload();await p.click('[data-section=motion]');await p.waitForFunction(()=>!document.getElementById('motionExportLast').disabled,null,{polling:50});last=await exported();assert.equal(last.run_id,'00000001');assert.equal(last.complete,ending==='complete');assert.deepEqual(await p.evaluate(()=>MotionStore.settings()),repeat);
    await p.close();
  }
  const legacyPage=await browser.newPage();await legacyPage.goto('file://'+path.join(root,'gallery.html'));await legacyPage.waitForFunction(()=>!!window.MotionStore);
  await legacyPage.evaluate(async()=>{const d=await new Promise(resolve=>{const r=indexedDB.open('dronecv-motion',1);r.onsuccess=()=>resolve(r.result);});await new Promise(resolve=>{const t=d.transaction('runs','readwrite');t.objectStore('runs').put({key:'old-only',run:{schema:'dronecv-motion-run-1',run_id:'old-only',complete:false,samples:[]}});t.oncomplete=resolve;});d.close();});
  assert.deepEqual(await legacyPage.evaluate(()=>MotionStore.history().then(h=>({last:h.last_local_run,unknown:h.chronology_unknown}))),{last:null,unknown:true});
  await legacyPage.reload();await legacyPage.click('[data-section=motion]');await legacyPage.waitForFunction(()=>document.getElementById('motionHistoryStatus').textContent.includes('Порядок прежних записей неизвестен'),null,{polling:50});assert.equal(await legacyPage.isEnabled('#motionExportLast'),false);assert.equal(await legacyPage.isEnabled('#motionExport'),true);await legacyPage.close();
  console.log('motion store review: atomic rollback/retry/idempotence; true conflict; local chronology/abort; old import preserves last/repeat; legacy records passed');
}finally{await browser.close();}

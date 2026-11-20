// Real Chrome, production controllers and IndexedDB. RAF, photos, import delays,
// final-chunk delays and transaction aborts below are controlled test inputs.
import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const failures=[],observations=[];let seed;
async function check(name,work){try{await work();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.stack);console.log('FAIL '+name+': '+e.stack);}}
async function open(){
  const context=await browser.newContext({viewport:{width:1280,height:800},acceptDownloads:true});
  const page=await context.newPage(),errors=[];
  const wait=page.waitForFunction.bind(page);page.waitForFunction=(fn,arg,options={})=>wait(fn,arg,{polling:25,timeout:15000,...options});page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>{
    let now=0,next=0;const callbacks=new Map();Object.defineProperty(performance,'now',{value:()=>now});
    requestAnimationFrame=fn=>{callbacks.set(++next,fn);return next;};cancelAnimationFrame=id=>callbacks.delete(id);
    window.lifecycleTick=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};
  });
  await page.goto('file://'+path.join(root,'gallery.html'));await page.click('[data-section=motion]');
  await page.waitForFunction(()=>!document.querySelector('#motionStart').disabled&&window.MotionABUI);
  await page.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=c.height=100;c.getContext('2d').fillRect(0,0,100,100);
    const photo={id:'synthetic-lifecycle',sha256:'synthetic',file:c.toDataURL(),width:100,height:100};
    MotionGallery.images=()=>[photo];MotionGallery.bounds=()=>[0,0,100,100];await MotionUI.refresh(photo.id);
    document.querySelector('#motionSyncSize').value='6';
  });
  await page.selectOption('#motionTestMode','ab');await page.fill('#abPairs','1');await page.click('#abCreate');
  await page.waitForFunction(()=>!document.querySelector('#abNext').disabled);
  return {context,page,errors};
}
async function start(p,button='#abNext'){await p.click(button);await p.waitForFunction(()=>document.fullscreenElement&&document.querySelector('#settings').classList.contains('hidden'));await p.evaluate(()=>lifecycleTick(0));}
async function finishDisplay(p){await p.evaluate(()=>{for(let i=0;i<200&&!MotionUI.runs().some(r=>r.variant==='B');i++)lifecycleTick(1000);});}
async function idle(p){await p.waitForFunction(()=>!MotionUI.busy()&&!document.fullscreenElement);}
async function downloaded(p){const [d]=await Promise.all([p.waitForEvent('download'),p.click('#abExport')]);return JSON.parse(fs.readFileSync(await d.path(),'utf8'));}
async function importFixture(p,{id,count,size,manual}){
  const payload=await p.evaluate(async({seed,id,count,size,manual})=>{
    const series=MotionAB.create({id,factor:'mode',pair_count:1,variants:{A:{value:'yolo'},B:{value:'yolo_lk'}}});
    const runs=Array.from({length:count},(_,index)=>{
      const run_id=(0xabcdef00+index).toString(16);
      const attempt=MotionAB.begin(series,{run_id,pair_index:1,slot:'A'});
      attempt.complete=true;
      return {...seed,run_id,series_id:series.id,attempt:attempt.attempt,actual_order:attempt.actual_order,
        samples:Array.from({length:size},(_,step)=>({elapsed_ms:step}))};
    });
    return JSON.stringify(await (manual?MotionManualTransfer:MotionAB).exportBundle(series,runs));
  },{seed,id,count,size,manual});
  await p.evaluate(()=>{window.liveImportSentinel=true;});
  await p.setInputFiles('#abImport',{name:id+'.json',mimeType:'application/json',buffer:Buffer.from(payload)});
  await p.waitForFunction(()=>document.querySelector('#abStatus').textContent.includes('Серия восстановлена.'));
  assert.equal(await p.evaluate(()=>window.liveImportSentinel),true);
  return await p.evaluate(id=>MotionStore.list().then(runs=>runs.filter(run=>run.series_id===id).map(run=>run.run_id)),id);
}
async function storedSeries(p,id){
  return p.evaluate(id=>MotionStore.ab().then(state=>state.series.find(series=>series.id===id)),id);
}
async function downloadMotion(p,button='#motionExport'){
  const [file]=await Promise.all([p.waitForEvent('download'),p.click(button)]);
  return JSON.parse(fs.readFileSync(await file.path(),'utf8'));
}
// Read raw stores independently of the production convenience readers.
async function disk(p){return p.evaluate(()=>new Promise((resolve,reject)=>{
  const request=indexedDB.open('dronecv-motion',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
    const d=request.result,t=d.transaction(['settings','runs','chunks'],'readonly');
    const workspace=t.objectStore('settings').get('abSeries'),runs=t.objectStore('runs').getAll(),chunks=t.objectStore('chunks').getAll();
    t.oncomplete=()=>{resolve({workspace:workspace.result,runs:runs.result,chunks:chunks.result});d.close();};t.onerror=()=>reject(t.error);
  };
}));}
try{
  for(const abort of [true,false])await check(abort?'failed end cannot leak completion through delayed import':'successful end survives a queued workspace save',async()=>{
    const {context,page:p,errors}=await open();
    try{
      await start(p);const jpeg=await p.evaluate(()=>document.querySelector('#motionCanvas').toDataURL('image/jpeg',.9));
      await p.evaluate(()=>{for(let i=0;i<200&&!MotionUI.runs().length;i++)lifecycleTick(1000);});await idle(p);
      const a=await p.evaluate(()=>MotionStore.list().then(r=>r.at(-1)));seed=a;
      assert.equal(a.complete,true);assert.equal((await disk(p)).workspace.series[0].attempts[0].complete,true);
      // Delay only the first import image callback. The deliberate width mismatch
      // makes the real importer call analysisError() when this callback resumes.
      await p.evaluate(()=>{
        const Native=Image;window.Image=function(...args){window.Image=Native;const img=new Native(...args);
          Object.defineProperty(img,'onload',{set(fn){img.addEventListener('load',()=>{window.importWaiting=true;window.releaseImport=fn;},{once:true});}});return img;};
      });
      const journal={schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,recording_complete:true,truncated:false,stop_ns:1e9,
        geometry:{width:a.conditions.viewport.width,height:a.conditions.viewport.height},calibration_image:{width:1,height:1,data_url:jpeg},
        frames:[{frame_id:1,capture_ns:1e8,analyzer_ns:1.1e8,marker:{run_id:a.run_id,step_id:0}}],publications:[],detections:[]};
      await p.setInputFiles('#reportJournals',{name:'synthetic-delayed-import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(journal))});
      await p.waitForFunction(()=>window.importWaiting);
      await p.evaluate(abort=>{
        const append=MotionStore.append,end=MotionStore.end,put=IDBObjectStore.prototype.put;
        MotionStore.append=async(...args)=>{window.appendWaiting=true;await new Promise(resolve=>window.releaseAppend=resolve);return append(...args);};
        MotionStore.end=async(...args)=>{window.endWaiting=true;await new Promise(resolve=>window.releaseEnd=resolve);window.inFinalEnd=true;try{return await end(...args);}finally{window.inFinalEnd=false;}};
        IDBObjectStore.prototype.put=function(value,key){
          const request=arguments.length>1?put.call(this,value,key):put.call(this,value);
          if(abort&&window.inFinalEnd&&this.name==='settings'&&key==='abSeries'){
            window.finalEndPayload=structuredClone(value);this.transaction.addEventListener('abort',()=>window.finalAborted=true);
            // Reject repair saves before aborting: request error events may
            // reject end() before the transaction's abort event is delivered.
            const ab=MotionStore.ab;MotionStore.ab=function(...args){if(args.length){window.deniedWorkspaceWrites=(window.deniedWorkspaceWrites||0)+1;return Promise.reject(Error('test storage unavailable after abort'));}return ab();};
            this.transaction.abort();
          }return request;
        };
      },abort);
      await start(p);await finishDisplay(p);
      await p.waitForFunction(()=>window.appendWaiting&&!document.fullscreenElement);
      const pendingExport=await downloaded(p),pendingAttempt=pendingExport.series.attempts.at(-1);
      await p.evaluate(()=>releaseImport());
      await p.waitForFunction(()=>MotionStore.ab().then(w=>/Размер кадра/.test(w.series[0].analysis_errors?.[w.series[0].attempts[0].run_id]||'')));
      const during=await disk(p); // background save really committed before the final chunk
      await p.evaluate(()=>releaseAppend());await p.waitForFunction(()=>window.endWaiting);
      // A second background save is queued behind end. It must not overwrite
      // confirmed completion with a snapshot taken while end was still pending.
      await p.evaluate(()=>{const select=document.querySelector('#abResults select');select.value=select.options[1].value;select.onchange();});
      await p.evaluate(()=>releaseEnd());await idle(p);
      // Drain the same production writer queue, without adding any write.
      await p.evaluate(()=>MotionABUI.write(()=>Promise.resolve()));
      const memory=await p.evaluate(()=>MotionUI.runs().at(-1)),bundle=await downloaded(p),after=await disk(p);
      const b=bundle.series.attempts.at(-1),storedB=after.runs.find(r=>r.run.run_id===b.run_id);
      const savedSamples=after.chunks.filter(c=>c.owner===storedB.key).sort((a,b)=>a.index-b.index).flatMap(c=>c.samples);
      observations.push({abort,pending:pendingAttempt.complete,during:during.workspace.series[0].attempts.at(-1).complete,
        memory:memory.complete,exported:b.complete,disk:after.workspace.series[0].attempts.at(-1).complete,run:storedB.run.complete,samples:savedSamples.length});
      assert.equal(memory.complete,!abort);assert.equal(b.complete,!abort);assert.equal(storedB.run.complete,!abort);
      assert.equal(after.workspace.series[0].attempts.at(-1).complete,!abort);
      assert.equal(JSON.stringify(bundle.runs.find(r=>r.run_id===b.run_id).samples),JSON.stringify(memory.samples));assert.deepEqual(savedSamples,memory.samples);
      assert.equal(bundle.series.journals.length,1);assert.equal(await p.evaluate(()=>!!window.finalAborted),abort);
      if(abort){assert.ok(bundle.series.attempts.at(-1).abort_reason);assert.ok(await p.evaluate(()=>deniedWorkspaceWrites>0));}
      else assert.equal(after.workspace.series[0].selections['1:A'],a.run_id);
      await p.reload();await p.click('[data-section=motion]');await p.waitForFunction(()=>MotionStore.ab().then(w=>w?.series.length===1));
      const reloaded=await disk(p);assert.equal(reloaded.workspace.series[0].attempts.at(-1).complete,!abort);
      if(abort){
        assert.match(await p.textContent('#abInstruction'),/Вариант B/);assert.equal(await p.isDisabled('#abNext'),false);assert.equal(await p.isDisabled('#abRetry'),false);
        await start(p);await p.click('#motionStop');await idle(p);
        const retry=(await disk(p)).workspace.series[0];assert.equal(retry.attempts.at(-1).slot,'B');assert.equal(retry.attempts.at(-1).attempt,2);
        assert.notEqual(retry.attempts.at(-1).run_id,b.run_id);assert.equal(retry.attempts[1].complete,false);assert.deepEqual(retry.journals,bundle.series.journals);
      }
      else assert.equal(await p.isDisabled('#abNext'),true);
      assert.deepEqual(errors,[]);
      assert.equal(pendingAttempt.complete,false,'uncommitted completion must not appear in the shared workspace/export');
      assert.equal(during.workspace.series[0].attempts.at(-1).complete,false,'background import saved an uncommitted completion');
    }finally{await context.close();}
  });
  for(const limit of ['runs','samples'])await check('restored '+(limit==='runs'?'20 runs':'120000 samples')+' rejects attempts before fullscreen',async()=>{
    assert.ok(seed);const {context,page:p,errors}=await open();
    try{
      await p.evaluate(async({seed,limit})=>{
        const w=await MotionStore.ab(),s=w.series[0];
        const count=limit==='runs'?20:3,size=limit==='runs'?1:40000;
        for(let i=0;i<count;i++)await MotionStore.save({...seed,series_id:s.id,run_id:i?'limit-'+i:seed.run_id,samples:Array.from({length:size},(_,j)=>({...seed.samples[0],sample_id:j,elapsed_ms:j}))});
        const attempt=MotionAB.begin(s,{run_id:seed.run_id,pair_index:1,slot:'A'});attempt.complete=true;MotionAB.select(s,1,'A',seed.run_id);
        const data={frames:[{frame_id:1,capture_ns:1e8,marker:{run_id:seed.run_id,step_id:0}}]};
        const source=await MotionAB.registerSource(s,{name:'synthetic-retained-source.json',raw:JSON.stringify(data),data});MotionAB.bind(s,seed.run_id,source.source.hash);await MotionStore.ab(w);
      },{seed,limit});
      await p.reload();await p.click('[data-section=motion]');await p.waitForFunction(()=>!document.querySelector('#abCreate').disabled);
      await p.waitForFunction(limit=>{const runs=MotionUI.runs();return limit==='runs'?runs.length===20:runs.reduce((n,r)=>n+r.samples.length,0)===120000;},limit);
      const before=await disk(p),buttons={next:await p.isDisabled('#abNext'),retry:await p.isDisabled('#abRetry')};
      // Invoke real handlers repeatedly even if disabled; DOM disabled state alone
      // must not serve as the handler's admission check.
      await p.evaluate(async()=>{
        let calls=0;document.querySelector('#motionStage').requestFullscreen=()=>{calls++;return Promise.reject(Error('test unexpected fullscreen'));};
        for(let i=0;i<3;i++){await document.querySelector('#abNext').onclick();await document.querySelector('#abRetry').onclick();await MotionUI.startAB({});}
        window.fullscreenCalls=calls;
      });
      const after=await disk(p),bundle=await downloaded(p),message=(await p.textContent('#abInstruction'))+' '+(await p.textContent('#abStatus'))+' '+(await p.textContent('#motionStatus'));
      observations.push({limit,buttons,before:before.workspace.series[0].attempts.length,after:after.workspace.series[0].attempts.length,message});
      assert.equal(after.workspace.series[0].attempts.length,before.workspace.series[0].attempts.length,'limit refusal must not register empty attempts');
      assert.equal(bundle.series.attempts.length,before.workspace.series[0].attempts.length);assert.equal(await p.evaluate(()=>fullscreenCalls),0);
      assert.deepEqual(after.runs,before.runs);assert.deepEqual(after.chunks,before.chunks);assert.deepEqual(after.workspace.series[0].journals,before.workspace.series[0].journals);
      assert.deepEqual(buttons,{next:true,retry:true});assert.match(message,limit==='runs'?/20/:/120[ \u00a0]?000/);assert.match(message,/экспорт|выгруз/i);assert.match(message,/профил/i);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
  for(const {id,count,size,manual,label} of [
    {id:'live-ab-run-limit',count:20,size:1,manual:false,label:'20 runs'},
    {id:'live-manual-sample-limit',count:3,size:40000,manual:true,label:'120000 samples'},
  ])await check('file import without reload enforces '+label,async()=>{
    const {context,page:p,errors}=await open();
    try{
      const runIds=await importFixture(p,{id,count,size,manual});
      assert.equal(runIds.length,count);
      const before=await storedSeries(p,id);
      assert.equal(before.attempts.length,count);
      assert.equal(before.attempts.every(attempt=>attempt.slot==='A'&&attempt.complete),true);
      assert.match(await p.textContent('#abInstruction'),label==='20 runs'?/предел 20/:/предел 120[ \u00a0]?000/);
      assert.equal(await p.isDisabled('#abNext'),true);
      assert.equal(await p.isDisabled('#abRetry'),true);
      assert.equal(await p.isDisabled('#motionExport'),false);
      const exported=await downloadMotion(p);
      assert.deepEqual(exported.runs.map(run=>run.run_id).sort(),runIds.sort());
      assert.equal(exported.runs.reduce((total,run)=>total+run.samples.length,0),count*size);
      const fullscreenCalls=await p.evaluate(async()=>{
        let calls=0;
        document.querySelector('#motionStage').requestFullscreen=()=>{calls++;return Promise.reject(Error('test unexpected fullscreen'));};
        await document.querySelector('#abNext').onclick();
        await document.querySelector('#abRetry').onclick();
        return calls;
      });
      assert.equal(fullscreenCalls,0);
      assert.deepEqual(await storedSeries(p,id),before);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
  await check('file import keeps the memory-only portion of the last local run and its repeat plan',async()=>{
    const {context,page:p,errors}=await open();
    try{
      await p.evaluate(()=>{
        const append=MotionStore.append;
        window.restoreAppend=()=>{MotionStore.append=append;};
        MotionStore.append=()=>Promise.reject(Error('synthetic append failure'));
      });
      await start(p);
      await p.evaluate(()=>lifecycleTick(1000));
      await p.click('#motionStop');
      await idle(p);
      const local=await p.evaluate(()=>MotionUI.runs().at(-1));
      assert.ok(local.samples.length>0);
      const persisted=await p.evaluate(id=>MotionStore.list().then(runs=>runs.find(run=>run.run_id===id)),local.run_id);
      assert.equal(persisted.samples.length,0);
      await p.evaluate(()=>restoreAppend());

      const imported=await importFixture(p,{id:'live-import-with-memory',count:1,size:1,manual:true});
      const exported=await downloadMotion(p);
      assert.equal(exported.runs.length,2);
      assert.deepEqual(exported.runs.find(run=>run.run_id===local.run_id),local);
      assert.ok(exported.runs.some(run=>run.run_id===imported[0]));
      assert.deepEqual(await downloadMotion(p,'#motionExportLast'),local);
      await p.selectOption('#motionTestMode','single');
      await p.fill('#motionWidth',String(local.scenario.target_width_px+10));
      assert.equal(await p.isDisabled('#motionRepeat'),false);
      await start(p,'#motionRepeat');
      await p.click('#motionStop');
      await idle(p);
      const repeated=await p.evaluate(()=>MotionUI.runs().at(-1));
      assert.notEqual(repeated.run_id,local.run_id);
      assert.deepEqual(repeated.scenario,local.scenario);
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  });
}finally{await browser.close();}
if(process.env.AB_LIFECYCLE_EVIDENCE)fs.writeFileSync(process.env.AB_LIFECYCLE_EVIDENCE,JSON.stringify({observations,failures},null,2));
assert.deepEqual(failures,[],failures.join('\n'));

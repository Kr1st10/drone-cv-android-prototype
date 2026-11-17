// Real Chrome + IndexedDB. RAF clocks, renderer crashes and transaction
// failures are synthetic; this does not exercise a phone or camera.
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]),browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const failures=[];
async function check(name,work){try{await work();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}}
async function session(){
  const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage();
  page.on('dialog',d=>d.accept());
  await context.addInitScript(()=>{
    let now=0,next=0;const work=new Map();
    requestAnimationFrame=cb=>{work.set(++next,cb);return next;};cancelAnimationFrame=id=>work.delete(id);
    window.tickRepeat=ms=>{now+=ms;const callbacks=[...work.values()];work.clear();callbacks.forEach(cb=>cb(now));};
  });
  await page.goto('file://'+path.join(root,'gallery.html'));await page.click('[data-section=motion]');
  await page.waitForFunction(()=>!document.querySelector('#motionStart').disabled,null,{polling:50});
  await page.selectOption('#motionPhoto','civ01');
  const bbox=await page.evaluate(()=>MANIFEST.images.find(m=>m.id==='civ01').object_bbox);
  await page.click('#motionBounds');for(const [i,id] of ['boundX1','boundY1','boundX2','boundY2'].entries())await page.fill('#'+id,String(bbox[i]));await page.click('#saveBounds');
  await page.evaluate(()=>{document.querySelector('#motionSyncSize').value='6';});
  return {context,page};
}
const tick=(p,ms)=>p.evaluate(ms=>tickRepeat(ms),ms);
async function start(p,button='#motionStart'){
  await p.click(button);await p.waitForFunction(()=>document.fullscreenElement&&document.querySelector('#settings').classList.contains('hidden'),null,{timeout:5000,polling:50});
}
async function idle(p){await p.waitForFunction(()=>!document.fullscreenElement&&!document.querySelector('#motionStart').disabled,null,{timeout:5000,polling:50});}
async function end(p){await p.click('#motionStop');await idle(p);}
async function complete(p){for(let i=0;i<260;i++){if(!await p.evaluate(()=>!!document.fullscreenElement))break;await tick(p,500);}await idle(p);}
async function crashedReload(p){
  const cdp=await p.context().newCDPSession(p),crashed=p.waitForEvent('crash');
  cdp.send('Page.crash').catch(()=>{});await crashed;
  const restored=await p.context().newPage();restored.on('dialog',d=>d.accept());await p.close();
  await restored.goto('file://'+path.join(root,'gallery.html'));await restored.click('[data-section=motion]');await restored.waitForFunction(()=>!document.querySelector('#motionStart').disabled,null,{polling:50});
  return restored;
}
try {
  for(const prior of [true,false])await check(prior?'A complete → B chunk → crash → repeat B':'first run chunk → crash → repeat first run',async()=>{
    const {context,page}=await session();let p=page;try{
      if(prior){await start(p);await tick(p,0);await complete(p);}
      await p.fill('#motionWidth','45');await p.evaluate(()=>document.querySelector('#motionSetup').value='snapshot B');await start(p);
      for(let i=0;i<120;i++)await tick(p,1);
      await p.waitForFunction(()=>MotionStore.history().then(h=>h.last_local_run?.samples.length>=120),null,{polling:50});
      const before=await p.evaluate(()=>MotionStore.history());assert.equal(before.last_local_run.scenario.target_width_px,45);
      assert.ok(before.last_scenario.values.m.file.startsWith('data:image/'));
      assert.deepEqual(before.last_scenario.plan.calibration_markers,before.last_local_run.calibration_markers);
      assert.deepEqual(before.last_scenario.viewport,before.last_local_run.conditions.viewport);
      p=await crashedReload(p);
      assert.equal(await p.evaluate(()=>MotionStore.history().then(h=>h.last_local_run.run_id)),before.last_local_run.run_id);
      assert.equal(await p.isEnabled('#motionRepeat'),true,'a persisted first start must restore Repeat');
      await p.fill('#motionWidth','55');await p.evaluate(()=>document.querySelector('#motionSetup').value='changed form');await start(p,'#motionRepeat');await tick(p,0);await end(p);
      const after=await p.evaluate(()=>MotionStore.history());assert.equal(after.last_local_run.scenario.target_width_px,45);
      assert.equal(after.last_local_run.conditions.setup_id,'snapshot B');assert.deepEqual(after.last_local_run.photo,before.last_local_run.photo);
      assert.deepEqual(after.last_local_run.calibration_markers,before.last_local_run.calibration_markers);
      assert.deepEqual(after.last_local_run.scenario,before.last_local_run.scenario);
    }finally{await context.close();}
  });
  await check('begin transaction rollback preserves A and shows no live code',async()=>{
    const {context,page:p}=await session();try{
      await start(p);await tick(p,0);await complete(p);const before=await p.evaluate(async()=>({history:await MotionStore.history(),repeat:await MotionStore.settings()}));
      await p.fill('#motionWidth','45');await p.evaluate(()=>{
        const put=IDBObjectStore.prototype.put;window.restoreRepeatPut=()=>IDBObjectStore.prototype.put=put;
        IDBObjectStore.prototype.put=function(v,key){if(this.name==='settings'&&key==='last')throw new DOMException('synthetic snapshot write failure','QuotaExceededError');return put.apply(this,arguments);};
      });
      await p.click('#motionStart');await p.waitForTimeout(150);await tick(p,0);
      const state=await p.evaluate(async()=>({history:await MotionStore.history(),repeat:await MotionStore.settings(),canvas:document.querySelector('#motionCanvas').width,status:document.querySelector('#motionStatus').textContent}));
      assert.equal(state.canvas,0,'snapshot failure must precede first visible sync');assert.match(state.status,/synthetic snapshot write failure/);
      assert.deepEqual(state.history,before.history);assert.deepEqual(state.repeat,before.repeat);await p.evaluate(()=>restoreRepeatPut());
    }finally{await context.close();}
  });
  for(const cancel of ['Stop','Esc'])await check(cancel+' during pending begin keeps run and repeat paired',async()=>{
    const {context,page:p}=await session();try{
      await start(p);await tick(p,0);await complete(p);await p.fill('#motionWidth','45');
      await p.evaluate(()=>{const begin=MotionStore.begin;MotionStore.begin=async(...args)=>{const key=await begin(...args);window.repeatBeginStored=true;await new Promise(r=>window.releaseRepeatBegin=r);return key;};});
      await p.click('#motionStart');await p.waitForFunction(()=>window.repeatBeginStored,null,{polling:50});
      if(cancel==='Stop')await p.click('#motionStop');else await p.keyboard.press('Escape');
      await p.evaluate(()=>releaseRepeatBegin());await idle(p);await p.reload();await p.click('[data-section=motion]');await p.waitForFunction(()=>!document.querySelector('#motionStart').disabled,null,{polling:50});
      const state=await p.evaluate(async()=>({history:await MotionStore.history(),repeat:await MotionStore.settings()}));
      assert.equal(state.history.last_local_run.scenario.target_width_px,45);assert.equal(state.history.last_local_run.samples.length,0);
      assert.equal(state.repeat.values.target_width_px,45);await start(p,'#motionRepeat');await tick(p,0);await end(p);
      assert.equal(await p.evaluate(()=>MotionStore.history().then(h=>h.last_local_run.scenario.target_width_px)),45);
    }finally{await context.close();}
  });
  await check('unassociated legacy snapshot preserves history without repeating the wrong run',async()=>{
    const {context,page:p}=await session();try{
      await p.evaluate(async()=>{
        const run={schema:'dronecv-motion-run-2',run_id:'aabbccdd',complete:false,samples:[]};await MotionStore.begin(run);
        await MotionStore.settings({values:{target_width_px:40},viewport:{width:1280,height:800}});
      });
      await p.reload();await p.click('[data-section=motion]');await p.waitForFunction(()=>!document.querySelector('#motionStart').disabled,null,{polling:50});
      assert.equal(await p.isEnabled('#motionRepeat'),false);assert.equal(await p.isEnabled('#motionExportLast'),true);assert.equal(await p.isEnabled('#motionExport'),true);
      assert.match(await p.textContent('#motionHistoryStatus'),/Связанный снимок повторения отсутствует/);
      const h=await p.evaluate(()=>MotionStore.history());assert.equal(h.last_local_run.run_id,'aabbccdd');assert.equal(h.last_scenario,null);
    }finally{await context.close();}
  });
  assert.deepEqual(failures,[]);console.log('repeat recovery browser regressions passed');
}finally{await browser.close();}

// Real Chrome, fullscreen, IndexedDB and production start handlers. The photo,
// RAF clock, startup failures and rejected fullscreen cleanup are synthetic.
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(path.join(process.cwd(),'x.js'))('playwright');
const root=path.resolve(process.argv[2]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM,args:['--allow-file-access-from-files']});
const failures=[];
async function check(name,work){try{await work();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}}
try {
  for(const fault of ['photo','planner']) {
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
    await page.addInitScript(()=>{
      let now=0,next=1;const callbacks=new Map();
      window.requestAnimationFrame=fn=>{const key=next++;callbacks.set(key,fn);return key;};
      window.cancelAnimationFrame=id=>callbacks.delete(id);
      window.advanceCleanup=ms=>{now+=ms;const work=[...callbacks.values()];callbacks.clear();work.forEach(fn=>fn(now));};
    });
    try {
      await page.goto('file://'+path.join(root,'gallery.html'));await page.click('[data-section=motion]');
      await page.waitForFunction(()=>!document.getElementById('motionStart').disabled,null,{polling:50});
      await page.evaluate(async()=>{
        const c=document.createElement('canvas');c.width=c.height=100;const ctx=c.getContext('2d');ctx.fillStyle='#777';ctx.fillRect(0,0,100,100);
        const photo={id:'synthetic-cleanup-photo',file:c.toDataURL('image/png'),width:100,height:100};
        MotionGallery.images=()=>[photo];MotionGallery.bounds=()=>[0,0,100,100];await MotionUI.refresh(photo.id);
        // Observe rejection from the original async event handler without
        // replacing production start(), state or button availability.
        const button=document.getElementById('motionStart'),onclick=button.onclick;
        button.onclick=()=>{window.launchSettled=false;Promise.resolve(onclick()).catch(e=>{window.unhandledStart=String(e);}).finally(()=>{window.launchSettled=true;});};
        window.originalPhotoLoader=MotionGallery.imageLoaded;window.originalPlanner=MotionScenario.plan;
        window.originalFullscreenExit=document.exitFullscreen.bind(document);
      });
      // Establish an eligible repeat snapshot before the failed second start.
      await page.click('#motionStart');
      await page.waitForFunction(()=>document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
      await page.evaluate(()=>advanceCleanup(0));await page.click('#motionStop');
      await page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled,null,{polling:50});
      assert.equal(await page.isEnabled('#motionRepeat'),true);
      await page.evaluate(fault=>{
        if(fault==='photo')MotionGallery.imageLoaded=()=>Promise.reject(Error('synthetic photo failure'));
        else MotionScenario.plan=()=>{throw Error('synthetic planner failure');};
        document.exitFullscreen=()=>{window.cleanupCalls=(window.cleanupCalls||0)+1;return Promise.reject(Error('synthetic fullscreen cleanup failure'));};
      },fault);
      await page.click('#motionStart');await page.waitForFunction(()=>window.launchSettled===true,null,{polling:50});
      const observed=await page.evaluate(()=>({message:document.getElementById('motionStatus').textContent,cleanupCalls:window.cleanupCalls,
        start:document.getElementById('motionStart').disabled,repeat:document.getElementById('motionRepeat').disabled,sync:document.getElementById('syncCheckStart').disabled,
        hidden:document.getElementById('settings').classList.contains('hidden'),canvasWidth:document.getElementById('motionCanvas').width,unhandled:window.unhandledStart??null}));
      console.log(fault+' cleanup observation '+JSON.stringify(observed));
      await check(fault+' retains original and cleanup reasons',async()=>{
        assert.match(observed.message,fault==='photo'?/фотографи.*недоступна/:/synthetic planner failure/);
        assert.match(observed.message,/synthetic fullscreen cleanup failure/);assert.equal(observed.unhandled,null);
      });
      await check(fault+' releases startup flags and settings',async()=>{
        assert.equal(observed.cleanupCalls,1);assert.equal(observed.start,false);assert.equal(observed.repeat,false);assert.equal(observed.sync,false);
        assert.equal(observed.hidden,false);assert.equal(observed.canvasWidth,0);
      });
      await page.evaluate(async()=>{
        MotionGallery.imageLoaded=originalPhotoLoader;MotionScenario.plan=originalPlanner;document.exitFullscreen=originalFullscreenExit;
        if(document.fullscreenElement)await document.exitFullscreen();
      });
      // Do not wait on disabled controls in the regression baseline.
      await check(fault+' allows next movement and sync check without reload',async()=>{
        assert.equal(await page.isEnabled('#motionStart'),true);assert.equal(await page.isEnabled('#syncCheckStart'),true);
        await page.click('#motionStart');await page.waitForFunction(()=>document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
        await page.evaluate(()=>advanceCleanup(0));await page.click('#motionStop');
        await page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled,null,{polling:50});
        assert.equal(await page.isEnabled('#motionRepeat'),true);
        await page.locator('#motionSyncCheck > summary').click();
        await page.click('#syncCheckStart');await page.waitForFunction(()=>document.getElementById('settings').classList.contains('hidden'),null,{polling:50});
        await page.evaluate(()=>advanceCleanup(0));await page.keyboard.press('Escape');
        await page.waitForFunction(()=>!document.fullscreenElement&&!document.getElementById('motionStart').disabled,null,{polling:50});
        assert.equal(await page.isEnabled('#syncCheckStart'),true);assert.deepEqual(errors,[]);
      });
    } finally {await page.close();}
  }
  assert.deepEqual(failures,[]);console.log('startup cleanup browser regressions passed (6 checks, 0 skipped)');
} finally {await browser.close();}

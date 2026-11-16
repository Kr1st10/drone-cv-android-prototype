// Real UI/planner/analyzer modules with deterministic DOM, RAF and monotonic time.
// The 500 ms stalls are synthetic; this is not a browser or phone measurement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const sourceRef=process.argv[2];
const source=name=>sourceRef?execFileSync('git',['show',`${sourceRef}:lab/monitor_test/${name}`],{encoding:'utf8'}):fs.readFileSync(path.join(root,name),'utf8');

async function harness(stall, fault){
  let now=0,next=1,id=0,visible=null,stored=null,download=null;
  const calls=[],intervals=[],elements=new Map(),raf=new Map(),runs=[];
  const document={hidden:false,fullscreenElement:null,addEventListener(){},querySelectorAll:()=>[],
    getElementById:key=>element(key),createElement:()=>element('option'+next++),
    async exitFullscreen(){calls.push(['exit',now]);document.fullscreenElement=null;}};
  function clear(){if(visible){intervals.push({...visible,end:now});visible=null;calls.push(['clear',now]);}}
  function element(key){
    if(elements.has(key))return elements.get(key);
    let width=0,height=0;
    const classes=new Set();
    const e={value:'',textContent:'',disabled:false,style:{},dataset:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},
      addEventListener(){},replaceChildren(){},append(o){if(!this.value)this.value=o.value;},removeAttribute(){},
      getBoundingClientRect:()=>({width:key==='motionStop'?80:1280,height:key==='motionStop'?32:800}),
      async requestFullscreen(){document.fullscreenElement=e;},
      getContext:()=>ctx};
    Object.defineProperties(e,{width:{get:()=>width,set:v=>{width=v;if(key==='motionCanvas')clear();}},height:{get:()=>height,set:v=>{height=v;if(key==='motionCanvas')clear();}}});
    elements.set(key,e);return e;
  }
  const ctx={fillStyle:'',fillRect(x,y,w,h){if(this.fillStyle==='#000'&&x===0&&y===0&&w===element('motionCanvas').width&&h===element('motionCanvas').height)clear();},strokeRect(){},fillText(){},drawImage(){}};
  for(const [k,v] of Object.entries({motionWidth:40,motionSpeed:300,motionAcceleration:500,motionLaps:1,motionAreaX:5,motionAreaY:5,motionAreaWidth:90,motionAreaHeight:90,motionTagSize:48,motionSyncSize:18}))element(k).value=String(v);
  const photo={id:'civ01',file:'data:image/png;base64,test',width:2400,height:1600};
  const gallery={load:(_,fallback)=>fallback,save(key,value){
    if(key==='sync_reading_checks_v1'){
      calls.push(['storage',now]);if(stall==='storage')now+=500;
      if(fault==='storage')throw Error('storage fault');
      stored=JSON.parse(JSON.stringify(value.at(-1)));
    }return true;
  },images:()=>[photo],bounds:()=>[1306,604,1593,895],imageLoaded:async()=>({src:photo.file,naturalWidth:2400,naturalHeight:1600}),
    settings(){calls.push(['settings',now]);if(fault==='cleanup')throw Error('cleanup fault');element('settings').classList.remove('hidden');},
    download(_,text){download=JSON.parse(text);}};
  const sandbox={document,console,structuredClone,performance:{now:()=>now},screen:{width:1280,height:800},
    crypto:{getRandomValues:a=>{a[0]=++id;return a;}},devicePixelRatio:1,
    requestAnimationFrame:fn=>{const k=next++;raf.set(k,fn);return k;},cancelAnimationFrame:k=>raf.delete(k),addEventListener(){},
    MotionGallery:gallery,MotionCalibration:{draw(){}},
    MotionStore:{history:async()=>({runs:[],last_local_run:null}),settings:async()=>null,
      begin:async r=>{runs.push(r);return r.run_id;},append:async()=>{},end:async()=>{}}};
  sandbox.window=sandbox;
  const context=vm.createContext(sandbox);
  for(const name of ['motion.js','motion-timeline.js','motion-scenario.js','motion-journal-status.js','sync-check.js','sync-check-ui.js','motion-ui.js'])vm.runInContext(source(name),context,{filename:name});
  await settle();
  const bits=sandbox.Motion.markerBits;
  sandbox.Motion.markerBits=(run_id,step_id)=>{clear();visible={run_id,step_id,start:now};calls.push(['draw',now,step_id]);return bits(run_id,step_id);};
  const analyze=sandbox.SyncCheck.analyze;
  sandbox.SyncCheckUI.renderJournal({name:'synthetic',data:{schema:'dronecv-motion-android-1',frames:[]}});
  sandbox.SyncCheck.analyze=(...args)=>{calls.push(['analysis',now]);if(stall==='analysis')now+=500;if(fault==='analysis')throw Error('analysis fault');return analyze(...args);};
  const reset=()=>{calls.length=0;intervals.length=0;stored=download=null;};
  async function settle(){for(let i=0;i<20;i++)await Promise.resolve();}
  async function tick(ms){now+=ms;const work=[...raf.values()];raf.clear();work.forEach(fn=>fn(now));await settle();}
  async function start(){await element('syncCheckStart').onclick();reset();}
  async function stop(){await element('motionStop').onclick();await settle();}
  function exported(){element('syncCheckExport').onclick();return download;}
  return {sandbox,calls,intervals,runs,start,tick,stop,exported,analyze,element,get stored(){return stored;},get now(){return now;},
    async nextLaunches(){
      assert.equal(element('syncCheckStart').disabled,false);assert.equal(element('motionStart').disabled,false);
      assert.equal(element('settings').classList.contains('hidden'),false);
      gallery.settings=()=>element('settings').classList.remove('hidden');
      await start();await tick(0);assert.ok(visible);await stop();
      await element('motionStart').onclick();await tick(0);assert.equal(runs.length,1,'next ordinary movement starts');await stop();
    }};
}

const failures=[];
async function check(name,work){try{await work();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}}
for(const stall of ['storage','analysis'])for(const mode of ['natural','stop'])await check(`${stall} 500ms / ${mode}`,async()=>{
  const h=await harness(stall);await h.start();await h.tick(0);await h.tick(10000);
  for(let i=0;i<4;i++)await h.tick(1000);
  if(mode==='natural')await h.tick(1000);else {await h.tick(250);await h.stop();}
  const run=h.exported(),clear=h.calls.filter(c=>c[0]==='clear').at(-1);
  const frames=h.intervals.flatMap(i=>[i.start+.25,i.end-.25].map(t=>({frame_id:t,capture_ns:(t+100)*1e6,marker:{run_id:i.run_id,step_id:i.step_id}})));
  const timing=h.analyze(run,{frames}).timing;
  console.log(JSON.stringify({stall,mode,end_ms:run.end_ms,cleared_ms:clear?.[1],timing,calls:h.calls}));
  assert.equal(timing,'compatible','frames from the actual programmed display intervals must align');
  assert.equal(run.end_ms,clear[1],'end_ms equals the code removal command, before stalls');
  assert.equal(run.end_ms,mode==='natural'?15000:14250);
  assert.equal(h.now-run.end_ms,500,'exact synthetic delay occurred after the recorded display end');
  const order=h.calls.map(c=>c[0]);
  assert.ok(order.indexOf('clear')<order.indexOf('storage'));assert.ok(order.indexOf('exit')<order.indexOf('storage'));
  assert.ok(order.indexOf('settings')<order.indexOf('analysis'));
  assert.deepEqual(h.stored,run);assert.equal(run.complete,mode==='natural');
  const late={frame_id:h.now+1,capture_ns:(run.end_ms+250+100)*1e6,marker:{run_id:run.run_id,step_id:5}};
  assert.equal(h.analyze(run,{frames:[...frames,late]}).timing,'incompatible','analyzer must still reject a code after removal');
  await h.nextLaunches();
});
for(const fault of ['cleanup','storage','analysis'])await check(`recover ${fault}`,async()=>{
  const h=await harness(null,fault);await h.start();await h.tick(0);await h.tick(250);await h.stop();
  const run=h.exported();assert.equal(run.end_ms,250);assert.equal(run.steps.length,1);
  assert.equal(h.element('motionCanvas').width,0);assert.equal(h.element('syncCheckExport').disabled,false);
  const status=h.element('motionStatus').textContent;
  if(fault==='storage')assert.match(status,/Не удалось сохранить в браузере/);
  if(fault==='analysis')assert.match(status,/сохранена.*Ошибка отображения/);
  if(fault==='cleanup')assert.match(status,/Ошибка очистки/);
  await h.nextLaunches();
});
await check('cancel before first RAF',async()=>{
  const h=await harness('storage');await h.start();await h.stop();const run=h.exported();
  assert.deepEqual(run.steps,[]);assert.equal(run.end_ms,null);assert.equal(run.complete,false);await h.nextLaunches();
});
assert.deepEqual(failures,[]);
console.log('sync display end: 8 deterministic UI/RAF cases passed (not a browser test)');

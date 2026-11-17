import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Timeline=require('../motion-timeline.js'),{analyze}=require('../motion-report-v4.js');
const points=[[0,0],[1,0],[1,1],[0,1]],box=[.2,.2,.4,.4];

// Synthetic clocks and boxes; code intervals come from the production generator.
function fixture(reacquire=false,dense=false){
  const times=dense?Array.from({length:65},(_,i)=>i*10):[0,100,...Array.from({length:15},(_,i)=>500+i*10)];
  if(reacquire&&!times.includes(50))times.splice(1,0,50);
  const run={schema:'dronecv-motion-run-3',run_id:'12345678',scenario:{version:'simple-motion-v1'},
    complete:true,duration_ms:650,end_ms:null,sync_period_ms:100,
    calibration_points:[[0,0],[100,0],[100,100],[0,100]],sync_intervals:[],samples:[]};
  for(const elapsed_ms of times){
    const step=Timeline.nextCode(run.sync_intervals,elapsed_ms,run.sync_period_ms);
    Timeline.commit(run.sync_intervals,step,elapsed_ms);
    const visible=elapsed_ms>=100||reacquire&&elapsed_ms<50;
    run.samples.push({run_id:run.run_id,sample_id:run.samples.length,elapsed_ms,visible,
      phase:visible?'stationary':reacquire?'disappearance':'calibration',bbox_screen_px:visible?[20,20,40,40]:null});
  }
  Timeline.close(run,650);Timeline.validate(run);
  const frame=(id,time,step)=>({frame_id:id,capture_ns:time*1e6,analyzer_ns:time*1e6,marker:{run_id:run.run_id,step_id:step}});
  const codeAt=time=>run.sync_intervals.find(s=>s.start_ms<=time&&time<s.end_ms).step_id;
  const publication=(frame_id,time,bbox=box)=>({frame_id,published_ns:time*1e6,bbox,source:bbox?'yolo':'clear',state_known:true});
  const journal={schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,truncated:false,
    geometry:{width:100,height:100},calibration_image:{width:100,height:100},stop_ns:650e6,detections:[],
    frames:[frame(0,1,0),frame(1,100,0),frame(2,150,codeAt(150)),frame(3,510,codeAt(510)),frame(4,650,codeAt(649))],
    publications:[publication(null,0,reacquire?box:null),...(reacquire?[publication(null,75,null)]:[]),publication(2,160),publication(3,520)]};
  return {run,journal,early:journal.publications.at(-2),frame:journal.frames[2]};
}
function report(f){
  const r=analyze(f.run,f.journal,points);
  assert.equal(r.timing_status,'compatible');assert.equal(r.offset_lower_ms,0);assert.equal(r.offset_upper_ms,1);
  return r;
}
function bounds(r,key,lower,upper=420){
  assert.equal(r[key].status,upper===null?'right_censored':'bounded');
  assert.equal(r[key].lower_ms,lower);assert.equal(r[key].upper_ms,upper);
}
for(const reacquire of [false,true]){
  const key=reacquire?'reacquisition':'capture';
  test(`${key}: uncovered exposure permits 59–420 ms and remains unknown`,()=>{
    const f=fixture(reacquire),r=report(f);
    if(!reacquire)assert.deepEqual(f.run.sync_intervals.map(s=>[s.start_ms,s.end_ms]),[[0,100],[100,500],[500,600],[600,650]]);
    assert.equal(r.frame_evaluations.find(e=>e.frame_id===2).status,'unknown');
    bounds(r,key,59);
  });
  test(`${key}: uncovered exposure cannot prove an upper bound`,()=>{
    const f=fixture(reacquire);f.journal.publications.pop();bounds(report(f),key,59,null);
  });
  for(const [name,change] of [
    ['initial_snapshot',f=>{f.early.initial_snapshot=true;}],
    ['missing box',f=>{f.early.bbox=null;f.early.source='clear';}],
    ['publication before exposure',f=>{f.early.published_ns=140e6;}],
    ['entire exposure before appearance',f=>{f.journal.frames[1].capture_ns=98e6;f.frame.capture_ns=99e6;f.frame.marker.step_id=0;}],
    ['exposure ending at appearance (exclusive)',f=>{f.journal.frames[1].capture_ns=98e6;f.frame.capture_ns=100e6;f.frame.marker.step_id=0;}]
  ])test(`${key}: ${name} cannot supply an earlier capture`,()=>{
    const f=fixture(reacquire);change(f);bounds(report(f),key,419);
  });
  test(`${key}: sufficiently covered bad box stays excluded`,()=>{
    const f=fixture(reacquire,true);f.early.bbox=[.6,.6,.8,.8];const r=report(f);
    assert.equal(r.frame_evaluations.find(e=>e.frame_id===2).status,'bad');bounds(r,key,419);
  });
  test(`${key}: sufficient coverage still measures an early correct box`,()=>{
    const f=fixture(reacquire,true),r=report(f);
    assert.equal(r.frame_evaluations.find(e=>e.frame_id===2).status,'good');bounds(r,key,59,60);
  });
  for(const dense of [false,true])test(`${key}: ${dense?'covered':'uncovered'} exposure crossing appearance is possible but not definite`,()=>{
    const f=fixture(reacquire,dense);
    // Appearance inside a held code allows the exposure interval to straddle it.
    f.run.samples.find(s=>s.elapsed_ms===100).visible=false;
    f.run.samples.find(s=>s.elapsed_ms===100).bbox_screen_px=null;
    f.run.samples.find(s=>s.elapsed_ms===100).phase=reacquire?'disappearance':'calibration';
    f.run.samples.push({...f.run.samples.find(s=>s.elapsed_ms===510),elapsed_ms:105});
    f.run.samples.sort((a,b)=>a.elapsed_ms-b.elapsed_ms).forEach((s,i)=>{s.sample_id=i;});
    Timeline.validate(f.run);f.frame.capture_ns=105.5e6;f.frame.marker.step_id=1;
    const r=report(f);assert.equal(r.frame_evaluations.find(e=>e.frame_id===2).status,'unknown');bounds(r,key,54,415);
    f.journal.publications.pop();bounds(report(f),key,54,null);
  });
  test(`${key}: uncovered exposure entirely before this episode is excluded`,()=>{
    const f=fixture(reacquire);
    const at100=f.run.samples.find(s=>s.elapsed_ms===100);
    Object.assign(at100,{visible:false,bbox_screen_px:null,phase:reacquire?'disappearance':'calibration'});
    f.run.samples.push({...f.run.samples.find(s=>s.elapsed_ms===500),elapsed_ms:400});
    f.run.samples.sort((a,b)=>a.elapsed_ms-b.elapsed_ms).forEach((s,i)=>{s.sample_id=i;});
    f.run.sync_intervals=[];
    for(const s of f.run.samples)Timeline.commit(f.run.sync_intervals,Timeline.nextCode(f.run.sync_intervals,s.elapsed_ms,100),s.elapsed_ms);
    Timeline.close(f.run,650);Timeline.validate(f.run);
    for(const frame of f.journal.frames){
      const time=frame.capture_ns/1e6;
      frame.marker.step_id=f.run.sync_intervals.find(s=>s.start_ms<time&&time<=s.end_ms).step_id;
    }
    f.early.published_ns=450e6;
    const r=report(f);assert.equal(r.frame_evaluations.find(e=>e.frame_id===2).status,'unknown');bounds(r,key,119,120);
  });
  for(const missing of ['frame','timestamp','marker','state'])test(`${key}: unknown ${missing} preserves possible capture`,()=>{
    const f=fixture(reacquire);
    if(missing==='frame')f.early.frame_id=null;
    if(missing==='timestamp')f.frame.capture_ns=null;
    if(missing==='marker')f.frame.marker=null;
    if(missing==='state')f.early.state_known=false;
    bounds(report(f),key,59);
  });
}
test('reacquisition still requires confirmed coordinate absence',()=>{
  for(const unknown of [false,true]){
    const f=fixture(true);
    if(unknown)f.journal.publications[1].state_known=false;
    else f.journal.publications.splice(1,1);
    assert.equal(report(f).reacquisition.status,'no_confirmed_absence');
  }
});

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Timeline=require('../motion-timeline.js');
const Scenario=require('../motion-scenario.js'),Status=require('../motion-journal-status.js'),Report=require('../motion-report-v4.js');
const points=[[0,0],[1,0],[1,1],[0,1]];
const plan=Scenario.plan({width:1280,height:800,workspace:{x:64,y:40,width:1152,height:720},calibration_size_px:48,sync_module_px:18,
  image_width:2400,image_height:1600,bbox:[1306,604,1593,895],target_width_px:40,max_speed_px_s:300,acceleration_px_s2:500,laps:1});
function rendered(times,period=100){
  const sync_intervals=[],samples=[];
  for(const elapsed of times){
    const step=Timeline.nextCode(sync_intervals,elapsed,period);
    const s=Scenario.sample(plan,elapsed,step,'12345678');
    Timeline.commit(sync_intervals,step,elapsed);
    delete s.step_id;s.sample_id=samples.length;samples.push(s);
  }
  return {schema:'dronecv-motion-run-3',run_id:'12345678',sync_period_ms:period,sync_intervals,samples,end_ms:null};
}
{
  const times=Array.from({length:800},(_,i)=>i*1000/75),run=rendered(times);
  Timeline.close(run,times.at(-1)+8);Timeline.validate(run);
  assert.ok(run.sync_intervals.length<times.length/6);
  assert.ok(run.sync_intervals.slice(0,-1).every(s=>s.end_ms-s.start_ms>=100));
  const held=run.sync_intervals.find(s=>s.start_ms>4000&&s.start_ms<4200);
  const samples=run.samples.filter(s=>s.elapsed_ms>=held.start_ms&&s.elapsed_ms<held.end_ms);
  assert.ok(samples.length>=7);assert.notDeepEqual(samples[0].bbox_screen_px,samples.at(-1).bbox_screen_px);
  assert.deepEqual(rendered(times,1000).samples,run.samples,'route, image size, speed, acceleration and disappearance independent of code period');
}
{
  const run=rendered([0,13,27,400,413,499,500]);Timeline.close(run,507);Timeline.validate(run);
  assert.deepEqual(run.sync_intervals,[{step_id:0,start_ms:0,end_ms:400},{step_id:1,start_ms:400,end_ms:500},{step_id:2,start_ms:500,end_ms:507}]);
  assert.equal(run.samples.length,7,'late RAF creates no fictitious trajectory or code updates');
}
function fixture(wide=false,stale=false){
  const run={schema:'dronecv-motion-run-3',run_id:'12345678',scenario:{version:'simple-motion-v1'},complete:true,duration_ms:210,
    calibration_points:[[0,0],[300,0],[300,300],[0,300]],sync_period_ms:100,end_ms:210,
    sync_intervals:[{step_id:0,start_ms:0,end_ms:100},{step_id:1,start_ms:100,end_ms:200},{step_id:2,start_ms:200,end_ms:210}],
    samples:Array.from({length:21},(_,i)=>({run_id:'12345678',sample_id:i,elapsed_ms:i*10,visible:true,phase:'cruise',bbox_screen_px:[30+i*6,30,40+i*6,40]}))};
  const times=wide?[40,140,205]:[1,21,41,61,81,100,121,141,161,181,200,205];
  const frames=times.map((t,i)=>({frame_id:i,capture_ns:t*1e6,analyzer_ns:t*1e6,marker:{run_id:run.run_id,step_id:t===100?0:t===200?1:Math.floor(t/100)}}));
  const publications=frames.map(f=>{
    const t=f.capture_ns/1e6,index=Math.floor((stale?Math.floor((t-1)/100)*100:t-1)/10);
    return {frame_id:f.frame_id,published_ns:f.capture_ns,bbox:run.samples[Math.max(0,index)].bbox_screen_px.map(v=>v/300),source:'lk'};
  });
  const journal={schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,truncated:false,geometry:{width:300,height:300},calibration_image:{width:300,height:300},stop_ns:210e6,frames,publications,detections:[]};
  return {run,journal};
}
{
  const {run,journal}=fixture(),timing=Status.timing(run,journal),result=Report.analyze(run,journal,points);
  assert.equal(timing.timing_status,'compatible');assert.equal(timing.offset_lower_ms,0);assert.equal(timing.offset_upper_ms,1);
  assert.deepEqual(timing.stalled_step_ids,[],'multiple camera exposures in a held code are legal');
  assert.equal(result.criterion_version,'motion-scenario-v5');
  assert.ok(result.frame_evaluations.every(f=>f.status==='good'),'frame boxes follow actual trajectory inside each code interval');
  assert.ok(result.frame_evaluations.some(f=>f.sample_ids.includes(8)));
  assert.equal(result.expected_ms,210,'last trajectory update held until recorded removal boundary');
  assert.equal(result.sync_period_ms,100);
}
{
  const {run,journal}=fixture(false,true),result=Report.analyze(run,journal,points);
  assert.equal(result.frame_evaluations[4].status,'bad','box frozen at code start must fail at current exposure');
  assert.ok(result.good_ms<result.bad_ms,'retention must not treat code-start coordinates as stationary truth');
}
{
  const {run,journal}=fixture(true),result=Report.analyze(run,journal,points);
  assert.equal(result.timing_status,'compatible');
  const frame=result.frame_evaluations.find(f=>f.frame_id===1);
  assert.equal(frame.status,'unknown');assert.ok(frame.iou_lower<.5&&frame.iou_upper>=.5);
  assert.ok(result.unknown_ms>0);assert.ok(result.good_fraction_lower<result.good_fraction_upper);
}
{
  const {run,journal}=fixture();journal.frames[1].marker.step_id=2;
  assert.equal(Status.timing(run,journal).timing_status,'incompatible');
  assert.ok(Report.analyze(run,journal,points).frame_evaluations.every(f=>f.status==='unknown'));
}
{
  const {run,journal}=fixture();journal.stop_ns=260e6;
  journal.frames.push({frame_id:99,capture_ns:250e6,marker:{run_id:run.run_id,step_id:2}});
  assert.equal(Status.timing(run,journal).timing_status,'incompatible','final closed interval rejects observations after code removal');
  assert.equal(Report.analyze(run,journal,points).timing_status,'incompatible');
}
for(const end of [0,8,99,100,170]){
  const times=[0,13,27,100,160].filter(t=>t<=end),run=rendered(times);Timeline.close(run,end);Timeline.validate(run);
  assert.equal(run.sync_intervals.at(-1).end_ms,end,'Stop closes the actual last code, even if shorter than nominal period');
}
{
  const run=rendered([]);Timeline.close(run,null);Timeline.validate(run);assert.deepEqual(run.sync_intervals,[]);
  const {run:r}=fixture();r.sync_intervals[0].end_ms=99;assert.throws(()=>Timeline.validate(r),/интервал/);
  assert.throws(()=>Timeline.validate({...r,schema:'dronecv-motion-run-99'}),/Неподдерживаемая версия/);
}
console.log('independent sync cadence, RAF trajectory, interval timing and exposure evaluation passed');

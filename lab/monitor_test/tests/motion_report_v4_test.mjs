import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {analyze}=createRequire(import.meta.url)('../motion-report-v4.js');
const points=[[0,0],[1,0],[1,1],[0,1]];
const run_id='12345678';
function fixture() {
  const samples=Array.from({length:61},(_,i)=>({run_id,step_id:i,elapsed_ms:i*100,
    phase:i<5?'calibration':i<15?'stationary':i<30?'cruise':i<40?'disappearance':i<55?'cruise':'blank_after',
    visible:i>=5&&i<30 || i>=40&&i<55,bbox_screen_px:i>=5&&i<30 || i>=40&&i<55?[20,20,40,40]:null}));
  const run={schema:'dronecv-motion-run-2',run_id,complete:true,mode:null,scenario:{version:'simple-motion-v1'},samples,duration_ms:6000,calibration_points:[[0,0],[100,0],[100,100],[0,100]]};
  const pub=(time,clear=false,frame=Math.floor(time/100))=>({published_ns:time*1e6,frame_id:clear?null:frame,bbox:clear?null:[.2,.2,.4,.4],source:clear?'clear':'yolo'});
  const journal={schema:'dronecv-motion-android-1',mode:'yolo_lk',complete:true,truncated:false,geometry:{width:100,height:100},calibration_image:{width:100,height:100},stop_ns:6000e6,
    frames:samples.map((s,i)=>({frame_id:i,analyzer_ns:i===0?99999999:i*1e8,capture_ns:i===0?99999999:i*1e8,marker:{run_id,step_id:i}})),
    detections:[],publications:[pub(0,true),pub(600),pub(3200,true),pub(4200),pub(5600,true)]};
  return {run,journal,pub};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
{
  const {run,journal,pub}=fixture();journal.publications=[pub(0,true),pub(600),pub(4100,true),pub(4300),pub(5600,true)];
  const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'bounded');near(r.reacquisition.upper_ms,300);near(r.cleanup.upper_ms,1100);
}
{
  const {run,journal}=fixture(), r=analyze(run,journal,points);
  assert.equal(r.criterion_version,'motion-scenario-v4'); assert.equal(r.mode,'yolo_lk');
  assert.equal(r.expected_ms,4000); assert.equal(r.stationary.expected_ms,1000);assert.equal(r.movement.expected_ms,3000);
  near(r.good_ms,3700); near(r.capture.lower_ms,100); near(r.capture.upper_ms,100);
  near(r.cleanup.lower_ms,200);near(r.cleanup.upper_ms,200);
  near(r.reacquisition.lower_ms,200);near(r.reacquisition.upper_ms,200);
  assert.equal(r.cleanup.status,'bounded');assert.equal(r.reacquisition.status,'bounded');
  assert.equal(r.pass,undefined);assert.equal(r.capture_latency_ms,undefined);
  assert.equal(r.center_error.domain,'all_visible_time_including_stationary_and_turns');near(r.center_error.p50_px,0);
}
{
  const {run,journal}=fixture(); journal.publications.splice(2,1);
  const r=analyze(run,journal,points);
  assert.equal(r.cleanup.status,'right_censored');near(r.cleanup.lower_ms,2500);
  assert.equal(r.reacquisition.status,'no_confirmed_absence');
}
{
  const {run,journal}=fixture();journal.publications=journal.publications.filter(p=>p.published_ns<1e6||p.published_ns>4000e6);
  const r=analyze(run,journal,points);assert.equal(r.cleanup.status,'not_applicable');
  assert.equal(r.capture.status,'right_censored');near(r.capture.lower_ms,2500);
}
{
  const {run,journal}=fixture();journal.publications.splice(3,1);
  const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'right_censored');near(r.reacquisition.lower_ms,1500);
}
{
  const {run,journal}=fixture(); journal.publications[3].frame_id=20;
  assert.equal(analyze(run,journal,points).reacquisition.status,'right_censored','old pre-disappearance frame is not fresh reacquisition');
}
{
  const {run,journal}=fixture();journal.truncated=true;
  const r=analyze(run,journal,points);assert.equal(r.capture.status,'unavailable');assert.equal(r.cleanup.status,'unavailable');
  assert.equal(r.good_ms,0);assert.equal(r.unknown_ms,4000);
}
{
  const {run,journal}=fixture();journal.frames.forEach(f=>f.capture_ns=null);
  const r=analyze(run,journal,points);assert.equal(r.capture.status,'unavailable');assert.equal(r.timing_status,'insufficient_capture');
}
{
  const {run,journal}=fixture(); journal.frames[0].capture_ns=0;
  const r=analyze(run,journal,points);assert.equal(r.capture.status,'bounded');near(r.capture.lower_ms,100);near(r.capture.upper_ms,200);
}
{
  const {run,journal}=fixture(); journal.publications[1].bbox=[.6,.6,.8,.8];
  const r=analyze(run,journal,points);assert.equal(r.capture.status,'right_censored','box presence alone is not capture');
  near(r.stationary.good_ms,0);assert.ok(r.stationary.bad_ms>800);
}
{
  const {run,journal}=fixture(); const original=JSON.stringify(run);analyze(run,journal,points);assert.equal(JSON.stringify(run),original);
  assert.throws(()=>analyze({...run,schema:'dronecv-motion-run-1'},journal,points));
}
{
  const {run,journal,pub}=fixture();journal.publications.splice(1,0,{...pub(550),frame_id:null});
  const r=analyze(run,journal,points);near(r.capture.lower_ms,50);near(r.capture.upper_ms,100);
}
function assertFiniteNumbers(value, path='result') {
  if(typeof value==='number') assert.ok(Number.isFinite(value),`${path} contains ${value}`);
  else if(value && typeof value==='object') for(const [key,item] of Object.entries(value)) assertFiniteNumbers(item,`${path}.${key}`);
}
function absentBeforeHide(extraClear=false, wideOffset=false) {
  const {run,journal,pub}=fixture();
  journal.publications=[pub(0,true),pub(600),pub(2900,true),...(extraClear?[pub(3100,true)]:[]),pub(4200),pub(5600,true)];
  if(wideOffset) journal.frames[0].capture_ns=0;
  return {run,journal,pub};
}
function noReturnFixture(complete=true) {
  const {run,journal,pub}=fixture();
  run.samples=run.samples.filter(s=>s.elapsed_ms<=3000 || s.elapsed_ms>=5500).map((s,i)=>({...s,step_id:i}));
  journal.frames=run.samples.map((s,i)=>({frame_id:i,analyzer_ns:i===0?99999999:s.elapsed_ms*1e6,
    capture_ns:i===0?99999999:s.elapsed_ms*1e6,marker:{run_id,step_id:i}}));
  journal.publications=[pub(0,true),pub(600),pub(3200,true),pub(5600,true)];
  run.complete=complete;journal.complete=complete;
  return {run,journal};
}
const reviewCases=[
  ['absence interval started before disappearance',()=>{
    const {run,journal}=absentBeforeHide(),r=analyze(run,journal,points);
    assert.equal(r.cleanup.status,'not_applicable');assert.equal(r.reacquisition.status,'bounded');
    near(r.reacquisition.lower_ms,200);near(r.reacquisition.upper_ms,200);
    const duplicate=absentBeforeHide(true);
    assert.deepEqual(analyze(duplicate.run,duplicate.journal,points).reacquisition,r.reacquisition,
      'redundant clear at 3100 does not change the sustained absence interval');
  }],
  ['absence interval under every compatible clock offset',()=>{
    const {run,journal}=absentBeforeHide(false,true),r=analyze(run,journal,points);
    assert.equal(r.cleanup.status,'not_applicable');assert.equal(r.reacquisition.status,'bounded');
    near(r.reacquisition.lower_ms,200);near(r.reacquisition.upper_ms,300);
    const duplicate=absentBeforeHide(true,true);
    assert.deepEqual(analyze(duplicate.run,duplicate.journal,points).reacquisition,r.reacquisition);
  }],
  ['old clear replaced by a box is not absence during disappearance',()=>{
    const {run,journal,pub}=absentBeforeHide();journal.publications.splice(3,0,pub(2950,false,29));
    const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'no_confirmed_absence');
    assert.equal(r.cleanup.status,'right_censored');assertFiniteNumbers(r);
  }],
  ['unknown empty state does not establish absence',()=>{
    const {run,journal}=absentBeforeHide();journal.publications[2].state_known=false;
    const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'no_confirmed_absence');
    assert.equal(r.cleanup.status,'unavailable');assertFiniteNumbers(r);
  }],
  ['absence covering only some clock offsets is insufficient',()=>{
    const {run,journal,pub}=absentBeforeHide(false,true);journal.publications.splice(3,0,pub(2950,false,29));
    const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'no_confirmed_absence');
    assert.equal(r.cleanup.status,'unavailable');assertFiniteNumbers(r);
  }],
  ['sustained absence still needs fresh post-return exposure',()=>{
    const {run,journal}=absentBeforeHide();journal.publications[3].frame_id=29;
    const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'right_censored');
    near(r.reacquisition.lower_ms,1500);assertFiniteNumbers(r);
  }],
  ['fresh post-return coordinates still need the correct box',()=>{
    const {run,journal}=absentBeforeHide();journal.publications[3].bbox=[.6,.6,.8,.8];
    const r=analyze(run,journal,points);assert.equal(r.reacquisition.status,'right_censored');
    near(r.reacquisition.lower_ms,1500);assertFiniteNumbers(r);
  }],
  ['complete reference with no actual return sample has no event estimate',()=>{
    const {run,journal}=noReturnFixture(),r=analyze(run,journal,points);
    assert.equal(r.reacquisition.status,'unavailable');assert.match(r.reacquisition.reason,/появление.*не.*зафиксировано/i);
    assert.equal(r.reacquisition.lower_ms,null);assert.equal(r.reacquisition.upper_ms,null);
    assert.ok(r.expected_ms>0);assert.ok(r.stationary.expected_ms>0);assertFiniteNumbers(r);
    assertFiniteNumbers(JSON.parse(JSON.stringify(r)));
  }],
  ['incomplete recording remains a distinct unavailable reason',()=>{
    const {run,journal}=noReturnFixture(false),r=analyze(run,journal,points);
    assert.equal(r.reacquisition.status,'unavailable');assert.match(r.reacquisition.reason,/Неполная запись|незавершённый эталон/);
    assertFiniteNumbers(r);
  }],
  ['missing actual return cannot emit nonfinite numbers',()=>{
    const {run,journal}=noReturnFixture();assertFiniteNumbers(analyze(run,journal,points));
  }],
  ['unknown boxed state widens cleanup lower bound',()=>{
    const {run,journal,pub}=fixture();journal.publications.splice(2,0,{...pub(3100),state_known:false});
    const r=analyze(run,journal,points);assert.equal(r.cleanup.status,'bounded');
    near(r.cleanup.lower_ms,100);near(r.cleanup.upper_ms,200);assertFiniteNumbers(r);
  }],
  ['known clear after unknown empty state still bounds cleanup',()=>{
    const {run,journal,pub}=fixture();journal.publications.splice(2,0,{...pub(3100,true),state_known:false});
    const r=analyze(run,journal,points);assert.equal(r.cleanup.status,'bounded');
    near(r.cleanup.lower_ms,100);near(r.cleanup.upper_ms,200);assertFiniteNumbers(r);
  }],
  ['unknown is a possible earlier removal, never a known clear',()=>{
    const {run,journal,pub}=fixture();journal.publications.splice(2,1,{...pub(3100,true),state_known:false});
    const r=analyze(run,journal,points);assert.equal(r.cleanup.status,'right_censored');
    near(r.cleanup.lower_ms,100);assert.equal(r.cleanup.upper_ms,null);assertFiniteNumbers(r);
  }],
  ['unknown empty state can conceal an earlier first capture',()=>{
    const {run,journal,pub}=fixture();journal.publications.splice(1,0,{...pub(550,true),state_known:false});
    const r=analyze(run,journal,points);assert.equal(r.capture.status,'bounded');
    near(r.capture.lower_ms,50);near(r.capture.upper_ms,100);assertFiniteNumbers(r);
  }],
  ['unknown empty state never proves a first-capture upper bound',()=>{
    const {run,journal,pub}=fixture();journal.publications.splice(1,1,{...pub(550,true),state_known:false});
    const r=analyze(run,journal,points);assert.equal(r.capture.status,'right_censored');
    near(r.capture.lower_ms,50);assert.equal(r.capture.upper_ms,null);assertFiniteNumbers(r);
  }]
];
const reviewFailures=[];
for(const [name,test] of reviewCases) {
  try {test();console.log(`review regression PASS: ${name}`);}
  catch(error) {reviewFailures.push(error);console.error(`review regression FAIL: ${name}: ${error.message}`);}
}
if(reviewFailures.length) throw new AggregateError(reviewFailures,'PR43 report regressions failed');
console.log('scenario v4 synthetic report tests passed');

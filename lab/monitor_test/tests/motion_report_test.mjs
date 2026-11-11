import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {analyze,homography,iou,maxima}=createRequire(import.meta.url)('../motion-report.js');
// Fixtures pin the offset to a one-nanosecond interval, not an impossible point.
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=1e-5, `${actual} is not near ${expected}`);
const points=[[0,0],[1,0],[1,1],[0,1]], screen=[[0,0],[100,0],[100,100],[0,100]];
const transform=homography(screen,points);
assert.deepEqual(transform([50,50]),[.5,.5]);
assert.equal(iou([[0,0],[1,0],[1,1],[0,1]],[0,0,1,1]),1);
const samples=Array.from({length:31},(_,i)=>({run_id:'12345678',step_id:i,elapsed_ms:i*100,visible:i>=5&&i<25,phase:i<5?'blank_before':i<25?'cruise':'blank_after',bbox_screen_px:i>=5&&i<25?[20,20,40,40]:null}));
const run={schema:'dronecv-motion-run-1',run_id:'12345678',mode:'yolo',complete:true,samples,duration_ms:3000,calibration_points:screen,photo:{id:'synthetic'},conditions:{setup_id:'synthetic'},scenario:{target_width_px:20,acceleration_px_s2:100}};
const make=()=>({schema:'dronecv-motion-android-1',mode:'yolo',complete:true,truncated:false,stop_ns:3000e6,geometry:{width:100,height:100},calibration_image:{width:100,height:100},frames:samples.map((s,i)=>({frame_id:i,analyzer_ns:i===0?99999999:i*1e8,capture_ns:i===0?99999999:i*1e8,marker:{run_id:s.run_id,step_id:i}})),detections:[{frame_id:5,published_ns:600e6,bbox:[.2,.2,.4,.4]}],publications:[{frame_id:5,published_ns:600e6,bbox:[.2,.2,.4,.4],source:'yolo'},{frame_id:null,published_ns:2500e6,bbox:null,source:'clear'}]});
let j=make(), r=analyze(run,j,points);
assert.equal(r.capture_latency_ms,100);assert.equal(r.pass,true);near(r.good_fraction,.95);near(r.coverage,1);
j=make();j.frames[12].marker=null;j.frames[16].marker=null;r=analyze(run,j,points);assert.equal(r.missing_markers,2);assert.equal(r.pass,null);
j=make();j.publications[0].published_ns=1200e6;r=analyze(run,j,points);assert.equal(r.pass,false);assert.ok(r.longest_failure_ms>500);
j=make();j.publications[1].published_ns=2800e6;r=analyze(run,j,points);near(r.false_box_blank_ms,300);
j=make();j.frames[15].capture_ns=null;r=analyze(run,j,points);assert.equal(r.clock,'capture_ns');
j=make();j.frames[15].marker.step_id=3;r=analyze(run,j,points);assert.equal(r.pass,null);assert.equal(r.marker_order_invalid,true);
j=make();j.detections[0].frame_id=1;r=analyze(run,j,points);assert.equal(r.capture_latency_ms,null);assert.equal(r.pass,true);
j=make();j.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},{frame_id:17,published_ns:1700e6,bbox:[.2,.2,.4,.4],source:'lk'});r=analyze(run,j,points);assert.equal(r.pass,false);near(r.longest_failure_ms,700);
j=make();for(let i=10;i<=15;i++)j.frames[i].marker=null;r=analyze(run,j,points);assert.equal(r.pass,null);assert.equal(r.unknown_may_hide_long_failure,true);
j=make();j.truncated=true;assert.equal(analyze(run,j,points).pass,null);
assert.throws(()=>analyze(run,{...make(),mode:'yolo_lk'},points));

// Synthetic regression cases; no camera or model performance is measured here.
const uncertain=make(); uncertain.frames[10].marker=null;
const uncertainResult=analyze(run,uncertain,points);
assert.equal(uncertainResult.pass,null, '1700/2000 confirmed good and 200 unknown cannot prove 90%');
const repeated=make(); repeated.frames[0].capture_ns=0; repeated.frames[0].analyzer_ns=0; repeated.frames=repeated.frames.flatMap((f,i)=>i<30?[f,{...f,analyzer_ns:f.analyzer_ns+(i===0?99999999:50e6),capture_ns:f.capture_ns+(i===0?99999999:50e6)}]:[f]).map((f,i)=>({...f,frame_id:i})); repeated.detections[0].frame_id=10; repeated.publications[0].frame_id=10;
const repeatedResult=analyze(run,repeated,points);
assert.equal(repeatedResult.matched_frames,61); near(repeatedResult.coverage,1);
near(repeatedResult.good_fraction,.95); assert.equal(repeatedResult.pass,true);
const frozen=make(); frozen.frames.forEach(f=>f.marker.step_id=5);
assert.notEqual(analyze(run,frozen,points).pass,true);
function outside(before) {
 const x=make(), shift=before?1e9:0;
 x.frames.forEach(f=>{f.analyzer_ns+=shift;f.capture_ns+=shift});
 x.publications.forEach(p=>p.published_ns+=shift); x.detections.forEach(d=>d.published_ns+=shift); x.stop_ns+=1e9;
 const f={frame_id:100,analyzer_ns:before?0:4000e6,capture_ns:before?0:4000e6,marker:null};
 if(before){x.frames.unshift(f); x.frames.forEach((frame,i)=>frame.frame_id=i); x.detections[0].frame_id=6; x.publications[0].frame_id=6;}else x.frames.push(f); return x;
}
assert.equal(analyze(run,outside(true),points).pass,true);
assert.equal(analyze(run,outside(false),points).pass,true);
const missingStart=make(); missingStart.frames.slice(0,6).forEach(f=>f.marker=null);
assert.notEqual(analyze(run,missingStart,points).pass,true);
const missingEnd=make(); missingEnd.frames.slice(25).forEach(f=>f.marker=null);
assert.notEqual(analyze(run,missingEnd,points).pass,true);
assert.equal(uncertainResult.expected_ms,2000); near(uncertainResult.good_ms,1700);
near(uncertainResult.bad_ms,100); near(uncertainResult.unknown_ms,200);
near(uncertainResult.good_fraction_lower,.85); near(uncertainResult.good_fraction_upper,.95);
const knownFail=make(); knownFail.frames[20].marker=null; knownFail.publications[0].published_ns=1100e6;
assert.equal(analyze(run,knownFail,points).pass,false);
const threshold=make(); threshold.publications[0].published_ns=700e6;
assert.equal(analyze(run,threshold,points).pass,null); // Offset uncertainty straddles 90%.
const durationBoundary=make(); durationBoundary.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},{frame_id:15,published_ns:1500e6,bbox:[.2,.2,.4,.4],source:'lk'});
// 500 ms is allowed for the duration criterion, though the fraction fails.
near(analyze(run,durationBoundary,points).longest_failure_ms,500);
const bridge=make(); bridge.frames[12].marker=null;
bridge.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},{frame_id:15,published_ns:1500e6,bbox:[.2,.2,.4,.4],source:'lk'});
assert.ok(analyze(run,bridge,points).longest_possible_failure_ms>=500);
const version='motion-retention-v3';
const levelRun=(id,speed,accel,extra={})=>({...run,run_id:id,scenario:{...run.scenario,width:100,height:100,laps:2,max_speed_px_s:speed,acceleration_px_s2:accel},...extra});
const entry=(r,pass)=>({run:r,result:{run_id:r.run_id,pass,criterion_version:version}});
const grouped=maxima([entry(levelRun('a1',100,200),true),entry(levelRun('a2',100,200),true),entry(levelRun('b1',300,600),true),entry(levelRun('b2',300,600),true)]);
assert.equal(grouped.length,2);
for(const [speed,accel] of [[100,200],[300,600]]) {
 const group=grouped.find(g=>g.max_speed_px_s===speed); assert.ok(group); assert.equal(group.max_acceleration_px_s2,accel);
 assert.deepEqual(group.photo,{id:'synthetic'}); assert.deepEqual(group.conditions,{setup_id:'synthetic'});
 assert.deepEqual(group.viewport,{width:100,height:100}); assert.equal(group.laps,2); assert.equal(group.criterion_version,version); assert.equal(group.run_ids.length,2);
}
for(const bad of [false,null]) assert.equal(maxima([entry(levelRun('a1',100,200),true),entry(levelRun('a2',100,200),true),entry(levelRun('a3',100,200),bad)])[0].max_acceleration_px_s2,null);
assert.equal(maxima([entry(levelRun('a1',100,200),true),entry(levelRun('a1',100,200),true)])[0].max_acceleration_px_s2,null);
assert.equal(maxima([entry(levelRun('a1',100,200),true),entry(levelRun('a2',100,200,{photo:{id:'other'}}),true)].filter(Boolean)).every(g=>g.max_acceleration_px_s2===null),true);
const almostFrozen=make(); almostFrozen.frames.forEach((f,i)=>f.marker.step_id=i===30?30:5);
assert.notEqual(analyze(run,almostFrozen,points).pass,true);
function longFixture(motionSteps) {
 const end=5+motionSteps;
 const ss=Array.from({length:end+6},(_,i)=>({run_id:'longtest',step_id:i,elapsed_ms:i*100,visible:i>=5&&i<end,phase:i<5?'blank_before':i<end?'cruise':'blank_after',bbox_screen_px:i>=5&&i<end?[20,20,40,40]:null}));
 const rr={...run,run_id:'longtest',samples:ss,duration_ms:(end+5)*100};
 const jj={...make(),stop_ns:(end+5)*100e6,frames:ss.map((s,i)=>({frame_id:i,analyzer_ns:i===0?99999999:i*100e6,capture_ns:i===0?99999999:i*100e6,marker:{run_id:'longtest',step_id:i}})),detections:[{frame_id:5,published_ns:500e6,bbox:[.2,.2,.4,.4]}],publications:[{frame_id:5,published_ns:500e6,bbox:[.2,.2,.4,.4],source:'yolo'},{frame_id:null,published_ns:end*100e6,bbox:null,source:'clear'}]};
 return [rr,jj];
}
{
 const [rr,jj]=longFixture(1);
 jj.frames.splice(6,0,{...jj.frames[5],analyzer_ns:550e6,capture_ns:550e6}); jj.frames.forEach((f,i)=>f.frame_id=i);
 const result=analyze(rr,jj,points);
 assert.equal(result.expected_ms,100); near(result.coverage,1);
 near(result.good_fraction_lower,1); assert.equal(result.pass,null);
 assert.equal(result.decision_reason,'Недостаточно подтверждений продвижения движения.');
}
{
 const [rr,jj]=longFixture(50);
 jj.publications[0].published_ns=0; jj.publications.at(-1).published_ns+=100e6;
 jj.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},{frame_id:15,published_ns:1500e6,bbox:[.2,.2,.4,.4],source:'lk'});
 const result=analyze(rr,jj,points); near(result.good_fraction_lower,.9); near(result.longest_failure_ms,500); assert.notEqual(result.pass,false);
}
{
 const [rr,jj]=longFixture(80); jj.frames[13].marker=null;
 jj.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},{frame_id:16,published_ns:1600e6,bbox:[.2,.2,.4,.4],source:'lk'});
 const result=analyze(rr,jj,points); assert.ok(result.good_fraction_lower>=.9); near(result.longest_failure_ms,200); near(result.longest_possible_failure_ms,600); assert.equal(result.pass,null);
}
assert.equal(maxima([entry(levelRun('o1',100,200),true),entry(levelRun('o2',100,200),true)].map(x=>({...x,result:{pass:true}})))[0].max_acceleration_px_s2,null);

assert.equal(uncertainResult.expected_ms,uncertainResult.good_ms+uncertainResult.bad_ms+uncertainResult.unknown_ms);
{
 const [rr,jj]=longFixture(80); jj.frames[60].marker.step_id=59;
 jj.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},{frame_id:16,published_ns:1600e6,bbox:[.2,.2,.4,.4],source:'lk'});
 const result=analyze(rr,jj,points); assert.equal(result.expected_ms,result.good_ms+result.bad_ms+result.unknown_ms); assert.equal(result.alignment_invalid,true); assert.equal(result.pass,null);
}
{
 const x=make(); x.frames[20].marker.step_id=18;
 const result=analyze(run,x,points); assert.equal(result.alignment_invalid,true); near(result.unknown_ms,2000); assert.equal(result.pass,null);
}
{
 const x=make(), rr={...run,samples:run.samples.map(s=>({...s}))};
 rr.samples[11].elapsed_ms=1400; rr.samples[12].elapsed_ms=1500; rr.samples[13].elapsed_ms=1600;
 // Use an otherwise coherent reference with a long held visible step.
 rr.samples.splice(11,3); x.frames[11].marker.step_id=10; x.frames[12].marker.step_id=10; x.frames[13].marker.step_id=10;
 const result=analyze(rr,x,points); assert.ok(result.unknown_ms>=300); assert.notEqual(result.pass,true);
}
{
 const x=make(); x.publications[1].published_ns=3000e6;
 assert.equal(analyze(run,x,points).false_box_blank_ms,500);
}
{
 const rr={...run,samples:run.samples.map(s=>({...s}))}; rr.samples[11].bbox_screen_px=[60,60,80,80];
 const x=make(); x.frames.splice(11,1);
 const result=analyze(rr,x,points); near(result.bad_ms,200); assert.equal(result.pass,null);
}

// The same observed markers admit multiple presentation-clock offsets.  At zero
// offset these moving boxes are good for 75% of visible time; at +20 ms, 95%.
{
 const movingSamples=samples.map((s,i)=>({...s,bbox_screen_px:s.visible?[20+(i-5),10,22+(i-5),12]:null}));
 const movingRun={...run,mode:'yolo_lk',samples:movingSamples,scenario:{...run.scenario,width:100,height:100}};
 const movingJournal={...make(),mode:'yolo_lk',stop_ns:3050e6,
  frames:movingSamples.map((s,i)=>({frame_id:i,capture_ns:(i*100+20)*1e6,analyzer_ns:(i*100+21)*1e6,marker:{run_id:s.run_id,step_id:i}})),
  publications:movingSamples.filter(s=>s.visible).map(s=>({frame_id:s.step_id,published_ns:(s.elapsed_ms+25)*1e6,bbox:s.bbox_screen_px.map(v=>v/100),source:s.step_id===5?'yolo':'lk'})),
  detections:[{frame_id:5,published_ns:525e6,bbox:movingSamples[5].bbox_screen_px.map(v=>v/100)}]};
 movingJournal.publications.push({frame_id:null,published_ns:2525e6,bbox:null,source:'clear'});
 const result=analyze(movingRun,movingJournal,points);
 assert.equal(result.pass,null,'75% and 95% compatible offsets cannot yield a definite decision');
}
{
 const [rr,jj]=longFixture(50);
 for(let i=10;i<15;i++) rr.samples[i].bbox_screen_px=[60,60,80,80];
 jj.publications[0].published_ns=0; jj.publications.at(-1).published_ns+=100e6;
 const result=analyze(rr,jj,points);
 assert.equal(result.pass,true,'invariant exactly 90% and 500 ms must pass');
}
{
 const [rr,jj]=longFixture(60);
 jj.stop_ns+=20e6; jj.frames.forEach(f=>{f.capture_ns+=20e6;f.analyzer_ns+=20e6});
 // Remove the narrow-window observation: offsets span (-80, +20] ms.
 jj.frames[0].capture_ns=20e6; jj.frames[0].analyzer_ns=20e6;
 jj.publications[0].published_ns=1020e6;
 const result=analyze(rr,jj,points);
 assert.equal(result.pass,null,'500–600 ms possible loss makes the decision ambiguous');
}
{
 const [rr,jj]=longFixture(50);
 jj.publications[0].published_ns=0; jj.publications.at(-1).published_ns+=100e6;
 jj.publications.splice(1,0,{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},
  {frame_id:15,published_ns:1501e6,bbox:[.2,.2,.4,.4],source:'lk'});
 assert.equal(analyze(rr,jj,points).pass,false,'a confirmed loss above 500 ms fails');
}
{
 const x=make(); x.frames.forEach(f=>{f.capture_ns=null});
 const result=analyze(run,x,points);
 assert.equal(result.timing_status,'insufficient_capture');
 assert.equal(result.pass,null);
 assert.equal(result.capture_latency_ms,null,'analyzer timing is not capture latency');
}
{
 const x=make();
 // A pre-roll frame may have negative camera time, and rows outside the
 // observed run with no capture time must not invalidate compatible evidence.
 x.frames.forEach(f=>f.frame_id+=2); x.detections[0].frame_id+=2; x.publications[0].frame_id+=2; x.stop_ns+=200e6;
 x.frames.unshift({frame_id:1,analyzer_ns:-1e8,capture_ns:-1e8,marker:null});
 x.frames.unshift({frame_id:0,analyzer_ns:-2e8,capture_ns:null,marker:null});
 x.frames.push({frame_id:33,analyzer_ns:3100e6,capture_ns:null,marker:null});
 const result=analyze(run,x,points);
 assert.equal(result.timing_status,'compatible');
 assert.equal(result.pass,true);
}

console.log('synthetic motion report tests passed');

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), {timelineImporter}=require('../motion-report.js');
const base=90071992547409930n, p=timelineImporter();
let id=0n;
const push=(type,data,time=base)=>p.push({schema:'dronecv-session-timeline-1',session_id:'s',event_id:String(++id),event_ns:String(time),type,data});
push('header',{start_ns:String(base),mode:'yolo_lk'});
for(let i=0;i<21001;i++)push('frame',{frame_id:String(base+BigInt(i)),analyzer_entry_ns:String(base+BigInt(i)),capture_ns:String(base+BigInt(i)),timebase:'elapsed_realtime',marker:null});
push('publication',{frame_id:String(base+20000n),published_ns:String(base+21005n),bbox:[0,0,1,1],source:'lk'});
push('session_end',{stop_ns:String(base+22000n),recording_complete:true,dropped_count:'0',accepted_count:String(id),written_count:String(id),experiment_status:'not_observed',interrupted:false});
const j=p.finish();
assert.equal(j.frames.length,21001);assert.equal(j.frames[20000].original_frame_id,String(base+20000n));
assert.equal(j.publications[0].frame_id,20001);assert.equal(j.stop_ns,22000);assert.equal(j.complete,true);
const incomplete=timelineImporter();incomplete.push({schema:'dronecv-session-timeline-1',session_id:'s',event_id:'1',event_ns:String(base),type:'header',data:{start_ns:String(base)}});assert.equal(incomplete.finish().complete,false);
assert.throws(()=>timelineImporter().push({schema:'dronecv-session-timeline-2'}),/Неподдерживаемая/);

if (process.env.TIMELINE_KOTLIN_FIXTURE) {
  const fs=await import('node:fs'), readline=await import('node:readline');
  const actual=timelineImporter();
  for await(const line of readline.createInterface({input:fs.createReadStream(process.env.TIMELINE_KOTLIN_FIXTURE),crlfDelay:Infinity})) actual.push(JSON.parse(line));
  const out=actual.finish();
  assert.equal(out.recording_complete,true);assert.ok(out.frames.length>20000);
  assert.equal(out.frames[0].original_frame_id,'0');assert.equal(out.frames[10000].original_frame_id,'10000');assert.equal(out.frames.at(-1).original_frame_id,'21000');
}

const combined=timelineImporter();let cid=0n;
const add=(type,data,event=base)=>combined.push({schema:'dronecv-session-timeline-1',session_id:'combined',event_id:String(++cid),event_ns:String(event),type,data});
add('header',{start_ns:String(base),mode:'yolo_lk'});
for(const type of ['resource','diagnostic_frame','tracking','frame_geometry','stale_discard']) add(type,{});
add('session_end',{stop_ns:String(base+1n),recording_complete:true,dropped_count:'0',accepted_count:'6',written_count:'6',experiment_status:'not_observed',interrupted:false});
add('recording_failure',{reason:'close failed'},base+2n);
assert.equal(combined.finish().recording_complete,false);

if (process.env.TIMELINE_KOTLIN_FIXTURE) {
  const fs=await import('node:fs'), readline=await import('node:readline');
  const filename=process.env.TIMELINE_KOTLIN_FIXTURE+'-diagnostic.ndjson';
  if(fs.existsSync(filename)) {
    const actual=timelineImporter();
    for await(const line of readline.createInterface({input:fs.createReadStream(filename),crlfDelay:Infinity})) actual.push(JSON.parse(line));
    assert.equal(actual.finish().recording_complete,true);
  }
}

// Initial coordinates belong to the recording, even when their source frame does not.
const {analyze}=require('../motion-report.js');
const points=[[0,0],[1,0],[1,1],[0,1]], screen=[[0,0],[100,0],[100,100],[0,100]];
const samples=Array.from({length:31},(_,i)=>({run_id:'initial',step_id:i,elapsed_ms:i*100,visible:i>=5&&i<25,phase:i<5?'blank_before':i<25?'cruise':'blank_after',bbox_screen_px:i>=5&&i<25?[20,20,40,40]:null}));
const run={schema:'dronecv-motion-run-1',run_id:'initial',mode:'yolo',complete:true,samples,calibration_points:screen};
function stateFixture({box=[.2,.2,.4,.4],duplicate=false,initial=true}={}) {
  const importer=timelineImporter();let id=0n;
  const add=(type,data,t=0n)=>importer.push({schema:'dronecv-session-timeline-1',session_id:'s',event_id:String(++id),event_ns:String(base+t),type,data});
  add('header',{start_ns:String(base),mode:'yolo'});
  add('metadata',{geometry:{width:100,height:100},calibration_image:{width:100,height:100}});
  if(initial)add('state',{publication_ns:String(base),reason:'initial_snapshot',box,frame_id:'1',motion_frame_id:'1',result_source:'yolo'});
  add('frame',{frame_id:'0',analyzer_entry_ns:String(base),capture_ns:String(base),timebase:'elapsed_realtime',marker:{run_id:'initial',step_id:0}});
  for(const s of samples) {
    // First exposure is 1 ns before the next reference step: offset bounds [-1,0].
    const capture=BigInt(s.step_id===0?99999999:s.step_id*1e8);
    add('frame',{frame_id:String(s.step_id+1),analyzer_entry_ns:String(base+capture),capture_ns:String(base+capture),timebase:'elapsed_realtime',marker:{run_id:'initial',step_id:s.step_id}},capture);
  }
  const change=(ns,bbox,frame=null)=>{
    add('state',{publication_ns:String(base+BigInt(ns)),box:bbox,reason:'update',frame_id:'1',motion_frame_id:frame,result_source:'yolo'},BigInt(ns));
    if(duplicate)add('publication',{published_ns:String(base+BigInt(ns)),frame_id:frame,bbox,source:bbox?'yolo':'clear'},BigInt(ns));
  };
  change(300e6,null);change(600e6,[.2,.2,.4,.4],'999');change(2500e6,null);
  add('session_end',{stop_ns:String(base+3000000000n),recording_complete:true,dropped_count:'0',accepted_count:String(id),written_count:String(id),interrupted:false});
  return importer.finish();
}
const initial=stateFixture(), duplicated=stateFixture({duplicate:true});
assert.equal(initial.publications.find(p=>p.initial_snapshot).frame_id,null);
assert.equal(initial.publications.find(p=>p.original_frame_id==='999').frame_reference,'outside_recording');
assert.equal(initial.detections.length,0);
// Offset uncertainty is one nanosecond; all 300 ms have trusted exposures.
assert.ok(Math.abs(analyze(run,initial,points).false_box_blank_ms-299.999999)<.00001);
assert.deepEqual(analyze(run,initial,points),analyze(run,duplicated,points));
assert.equal(initial.publications.length,duplicated.publications.length);
assert.equal(analyze(run,initial,points).capture_latency_ms,null);
const empty=stateFixture({box:null});
assert.equal(empty.publications.find(p=>p.initial_snapshot).state_known,true);
assert.equal(analyze(run,empty,points).false_box_blank_ms,0);
const unknown=stateFixture({initial:false});
assert.ok(analyze(run,unknown,points).blank_evaluated_ms<analyze(run,empty,points).blank_evaluated_ms);

// Timebase validation precedes relative arithmetic. Invalid exposure times never
// borrow analyzer-entry timestamps, including the review's synthetic large offset.
for(const capture of ['10000000000000000',null,'0','-1']) {
  const imp=timelineImporter();let n=0;
  const add=(type,data)=>imp.push({schema:'dronecv-session-timeline-1',session_id:'clock',event_id:String(++n),event_ns:'1010000000',type,data});
  add('header',{start_ns:'1000000000'});
  add('frame',{frame_id:'1',analyzer_entry_ns:'1010000000',capture_ns:capture,timebase:'unknown'});
  add('frame',{frame_id:'2',analyzer_entry_ns:'1010000000',capture_ns:capture,timebase:'elapsed_realtime'});
  // Huge REALTIME capture is later than entry and thus invalid before subtraction.
  const out=imp.finish();
  assert.ok(out.frames.every(f=>f.capture_ns===null));
  assert.equal(out.frames[0].raw_capture_ns,capture);
}
const noExposure=stateFixture();noExposure.frames.forEach(f=>f.capture_ns=null);
assert.equal(analyze(run,noExposure,points).timing_status,'insufficient_capture');
assert.equal(analyze(run,noExposure,points).pass,null);
assert.equal(analyze(run,noExposure,points).capture_latency_ms,null);

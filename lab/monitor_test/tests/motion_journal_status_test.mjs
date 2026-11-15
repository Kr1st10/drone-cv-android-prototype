// Synthetic journal diagnostics are independent of the calibration image and geometry.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {codeReadability,timing}=createRequire(import.meta.url)('../motion-journal-status.js');
const legacy=createRequire(import.meta.url)('../motion-report.js');
const run_id='12345678',other='abcdef01';
const run={schema:'dronecv-motion-run-2',run_id,complete:true,samples:[0,100,200].map((elapsed_ms,step_id)=>({run_id,elapsed_ms,step_id}))};
const frame=(step_id,time,id=step_id,runId=run_id)=>({frame_id:id,capture_ns:time,analyzer_ns:time,marker:step_id===null?null:{run_id:runId,step_id}});
const fixture=()=>({schema:'dronecv-motion-android-1',complete:true,truncated:false,stop_ns:1500e6,frames:[frame(0,1020e6),frame(1,1120e6),frame(null,1220e6,2)]});
{
 const journal=fixture(), before=JSON.stringify(journal),r=codeReadability(journal);
 assert.equal(r.total_frames,3);assert.equal(r.read_frames,2);assert.equal(r.missing_markers,1);assert.deepEqual(r.run_ids,[run_id]);
 assert.equal(r.recording_complete,true);assert.equal(r.completeness_reason,null);assert.equal(JSON.stringify(journal),before);
 const t=timing(run,journal);assert.equal(t.matched_frames,2);assert.equal(t.missing_markers,1);assert.equal(t.timing_status,'compatible');
 assert.equal(t.offset_lower_ms,920);assert.equal(t.offset_upper_ms,1020);assert.equal(t.offset_uncertainty_ms,100);
 assert.equal(t.matched_timed_frames,2);assert.equal(t.reference_complete,true);assert.equal(t.marker_order_invalid,false);
 assert.equal(journal.calibration_image,undefined,'no JPEG is needed');assert.equal(journal.geometry,undefined,'no spatial geometry is needed');
}
{
 const journal=fixture();journal.frames[2].marker={run_id:other,step_id:2};
 assert.deepEqual(codeReadability(journal).run_ids,[run_id,other].sort());assert.equal(codeReadability(journal).read_frames,3);
 const t=timing(run,journal);assert.equal(t.foreign_run_frames,1);assert.equal(t.unknown_step_frames,0);assert.equal(t.matched_frames,2);
}
{
 const journal=fixture();journal.frames[2].marker={run_id,step_id:99};
 const t=timing(run,journal);assert.equal(t.unknown_step_frames,1);assert.equal(t.foreign_run_frames,0);assert.equal(t.matched_frames,2);
}
{
 const journal=fixture();journal.complete=false;journal.truncated=true;
 const r=codeReadability(journal),t=timing(run,journal);assert.equal(r.read_frames,2);assert.equal(r.recording_complete,false);
 assert.match(r.completeness_reason,/усеч|непол|прерв/);assert.equal(t.timing_status,'compatible');assert.match(t.completeness_reason,/усеч|непол|прерв/);
 assert.equal(t.recording_complete,false);
}
{
 const journal=fixture();journal.frames=[frame(1,1020e6,0),frame(0,1120e6,1)];
 const t=timing(run,journal);assert.equal(t.marker_order_invalid,true);assert.equal(t.order_violations,1);assert.equal(t.timing_status,'incompatible');
 assert.match(t.reason,/смещ|совмест/);
}
{
 const journal=fixture();journal.frames=[frame(0,1020e6,0),frame(0,1220e6,1)];
 const t=timing(run,journal);assert.equal(t.marker_order_invalid,false);assert.deepEqual(t.stalled_step_ids,[0]);assert.equal(t.timing_status,'incompatible');
}
{
 const journal=fixture();journal.frames.forEach(f=>f.capture_ns=null);
 const t=timing(run,journal);assert.equal(t.timing_status,'insufficient_capture');assert.equal(t.untimed_frames,3);assert.equal(t.offset_lower_ms,null);assert.equal(t.offset_upper_ms,null);assert.equal(t.offset_uncertainty_ms,null);
}
{
 const journal=fixture();journal.frames=[frame(2,1220e6,0)];
 const t=timing(run,journal);assert.equal(t.timing_status,'insufficient_capture');assert.equal(t.offset_lower_ms,null);assert.equal(t.offset_upper_ms,1020);assert.equal(t.offset_uncertainty_ms,null);
}
{
 const journal=fixture();journal.frames=[];
 assert.deepEqual(codeReadability(journal).run_ids,[]);assert.equal(timing(run,journal).timing_status,'insufficient_capture');
}
{
 const journal=fixture();const t=timing({...run,complete:false},journal);assert.equal(t.reference_complete,false);assert.match(t.completeness_reason,/эталон/i);
 for(const value of Object.values(t))if(typeof value==='number')assert.ok(Number.isFinite(value),'diagnostic export has no non-finite numbers');
}
{
 assert.throws(()=>timing({...run,samples:[run.samples[0],run.samples[0]]},fixture()),/поряд|step_id|повтор/i);
 const journal=fixture();journal.frames[1].capture_ns=1600e6;assert.throws(()=>timing(run,journal),/времен|кадр/i);
}
{
 const journal=fixture(),legacyRun={...run,schema:'dronecv-motion-run-1',calibration_points:[[0,0],[100,0],[100,100],[0,100]],
  samples:run.samples.map((s,i)=>({...s,phase:i===0?'blank_before':i===1?'cruise':'blank_after',visible:i===1,bbox_screen_px:i===1?[20,20,40,40]:null}))};
 const spatialJournal={...journal,mode:'yolo',geometry:{width:100,height:100},calibration_image:{width:100,height:100},publications:[],detections:[]};
 const a=timing(run,journal),b=legacy.analyze(legacyRun,spatialJournal,[[0,0],[1,0],[1,1],[0,1]]);
 for(const field of ['timing_status','offset_lower_ms','offset_upper_ms','matched_frames','missing_markers','marker_order_invalid'])assert.equal(a[field],b[field],`same legacy ${field}`);
 assert.equal(a.foreign_run_frames+a.unknown_step_frames,b.unmatched_markers);
}
console.log('independent journal readability and timing diagnostics passed');

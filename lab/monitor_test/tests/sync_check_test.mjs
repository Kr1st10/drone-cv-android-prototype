import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{analyze}=require('../sync-check.js'),{layout,plan,sample}=require('../motion-scenario.js');
const run={run_id:'12345678',steps:[0,1,2,3,4,5].map(step_id=>({step_id,elapsed_ms:step_id?9000+step_id*1000:0})),end_ms:15000};
const frame=(time,step,id=run.run_id)=>({frame_id:time,capture_ns:(time+100)*1e6,marker:step===null?null:{run_id:id,step_id:step}});
let j={frames:[frame(0,0),frame(9999,0),frame(10000,1),frame(10999,1),frame(11000,2),frame(12000,3),frame(13000,4),frame(14000,5),frame(14999,5)]};
let r=analyze(run,j);assert.equal(r.matched,9);assert.deepEqual(r.missing,[]);assert.equal(r.timing,'compatible');assert.ok(r.static.frames>=2);assert.ok(r.switching.frames>=5);
r=analyze(run,{frames:j.frames.map(f=>({...f,marker:null}))});assert.equal(r.read,0);assert.equal(r.static,null);assert.equal(r.switching,null);
r=analyze(run,{frames:j.frames.map(f=>({...f,marker:{...f.marker,run_id:'deadbeef'}}))});assert.equal(r.foreign,9);assert.equal(r.matched,0);
r=analyze(run,{frames:[frame(0,99)]});assert.equal(r.unknown,1);assert.deepEqual(r.missing,[0,1,2,3,4,5]);
r=analyze(run,{frames:j.frames.map(f=>({...f,capture_ns:null}))});assert.equal(r.static,null);assert.equal(r.switching,null);assert.equal(r.matched,9);
r=analyze(run,{frames:[frame(1000,1),frame(2000,0)]});assert.equal(r.timing,'incompatible');assert.equal(r.static,null);
assert.equal(analyze(null,j).matched,0);assert.equal(analyze(run,{frames:[]}).fraction,null);
const base={width:1280,height:1000,workspace:{x:64,y:40,width:1152,height:920},calibration_size_px:48,image_width:400,image_height:300,bbox:[0,0,400,300],target_width_px:40,max_speed_px_s:300,acceleration_px_s2:500,laps:1};
const rect=([x,y,w,h])=>[x,y,x+w,y+h],overlap=(a,b)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
for(const m of [12,18,24,32]){
  const p=plan({...base,sync_module_px:m});assert.equal(p.marker.module_px,m);assert.deepEqual(p.sync_backing.slice(2),[14*m,12*m]);
  const sync=rect(p.sync_backing),tags=p.calibration_markers.map(t=>rect([t.x,t.y,t.size,t.size]));assert.ok(tags.every(t=>!overlap(t,sync)));
  for(let t=0;t<p.duration_ms;t+=17){const s=sample(p,t,Math.floor(t),run.run_id);if(s.image_rect_px)assert.ok([...tags,sync,rect(p.control_rect)].every(r=>!overlap(s.image_rect_px,r)));}
}
assert.throws(()=>layout({...base,sync_module_px:32,workspace:{x:0,y:0,width:400,height:720}}),/по ширине/);
assert.throws(()=>layout({...base,sync_module_px:32,workspace:{x:0,y:0,width:1152,height:400}}),/по высоте/);
console.log('sync check: clock bounds, phases, zero/foreign/unknown/untimed reads; all preset sizes and route separation passed');

const {timelineImporter}=require('../motion-report.js');
const {framesOf}=require('../motion-journal-status.js');
for(const bad of [null,42,'frame',[],{marker:[]},{marker:{run_id:42,step_id:0}},{marker:{run_id:'12345678',step_id:-1}}]){
 assert.throws(()=>framesOf({schema:'dronecv-motion-android-1',frames:[bad]}),/frames\[0\]/);
}
const allowed={schema:'dronecv-motion-android-1',recording_complete:false,frames:[{}, {marker:null,capture_ns:null},frame(0,0)]};
assert.equal(framesOf(allowed),allowed.frames,'missing marker/time and incomplete records are valid structures');
assert.doesNotThrow(()=>framesOf({...allowed,frames:[{marker:{run_id:'legacy-id',step_id:0}}]}),'historical string IDs remain importable');
for(const gap of [false,true]){
 const p=timelineImporter(),base=1000000000n;let id=0;
 const push=(type,data)=>p.push({schema:'dronecv-session-timeline-1',session_id:'s',event_id:String(++id),event_ns:String(base),type,data});
 push('header',{start_ns:String(base),mode:'yolo_lk'});
 if(gap)id++;
 push('frame',{frame_id:'1',capture_ns:String(base),analyzer_entry_ns:String(base),timebase:'elapsed_realtime',marker:null});
 push('session_end',{stop_ns:String(base+1n),recording_complete:true,dropped_count:gap?'1':'0',accepted_count:'2',written_count:'2',interrupted:false});
 const j=p.finish();assert.equal(j.event_integrity.missing_events,gap?'1':'0');assert.equal(j.event_integrity.footer_present,true);assert.equal(j.recording_complete,!gap);assert.equal(analyze(run,j).read,0);
}

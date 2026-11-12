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

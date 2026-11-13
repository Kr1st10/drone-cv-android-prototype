// Synthetic computations in the project's actual v1 and NDJSON formats.
// These fixtures do not measure camera, detector or physical tracking accuracy.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {analyze,homography,timelineImporter}=createRequire(import.meta.url)('../motion-report.js');
const points=[[0,0],[1,0],[1,1],[0,1]], screen=[[0,0],[100,0],[100,100],[0,100]];
const near=(a,b,tolerance=1e-5)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
function fixture() {
  const samples=Array.from({length:31},(_,i)=>({run_id:'synthetic',step_id:i,elapsed_ms:i*100,
    visible:i>=5&&i<25,phase:i<5?'blank_before':i<25?'cruise':'blank_after',bbox_screen_px:i>=5&&i<25?[20,20,40,40]:null}));
  const run={schema:'dronecv-motion-run-1',run_id:'synthetic',mode:'yolo',complete:true,samples,calibration_points:screen};
  const journal={schema:'dronecv-motion-android-1',mode:'yolo',complete:true,truncated:false,stop_ns:3000e6,
    geometry:{width:200,height:100},calibration_image:{width:200,height:100},
    frames:samples.map((s,i)=>({frame_id:i,capture_ns:i===0?99999999:i*1e8,analyzer_ns:i===0?1e8:i*1e8,marker:{run_id:s.run_id,step_id:i}})),
    detections:[],publications:[{frame_id:0,published_ns:0,bbox:[.2,.2,.4,.4],source:'yolo'}]};
  return {run,journal};
}
const result=({run,journal},p=points)=>analyze(run,journal,p);
const metric=(f,p)=>result(f,p).center_error;
const shifted=(dx,dy)=>[.2+dx/200,.2+dy/100,.4+dx/200,.4+dy/100];
{
  const c=metric(fixture());
  near(c.mean_px,0);near(c.p50_px,0);near(c.p95_px,0);near(c.max_observed_px,0);
  assert.equal(c.evaluated_ms,2000);assert.equal(c.coverage,1);assert.equal(c.unknown_ms,0);
}
{
  const f=fixture();f.journal.publications[0].bbox=shifted(3,4);
  const c=metric(f);near(c.mean_px,5);near(c.p95_px,5); // W != H: separate scales are essential.
}
{
  const f=fixture(), p=[[.05,.05],[.95,.1],[.7,.95],[.2,.75]], h=homography(screen,p);
  const corners=[[20,20],[40,20],[40,40],[20,40]].map(h);
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
  const bbox=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
  f.journal.publications[0].bbox=bbox;
  near(metric(f,p).mean_px,0);
  const originalCenter=h([30,30]);
  assert.ok(Math.hypot((bbox[0]+bbox[2])/2-originalCenter[0],(bbox[1]+bbox[3])/2-originalCenter[1])>.0001);
}
{
  const f=fixture();f.journal.publications.push({frame_id:10,published_ns:1000e6,bbox:shifted(10,0),source:'lk'});
  const c=metric(f);near(c.mean_px,7.5);near(c.p50_px,10);near(c.p95_px,10);near(c.max_observed_px,10);
  near(c.evaluated_ms,2000);near(c.unknown_ms,.000001);
  const repeated=structuredClone(f);
  for(let t=50;t<3000;t+=50) repeated.journal.publications.push({frame_id:0,published_ns:t*1e6,bbox:t<1000?[.2,.2,.4,.4]:shifted(10,0),source:'lk'});
  assert.deepEqual(metric(repeated),c,'identical publications do not alter duration statistics');
  const weighted=fixture();weighted.journal.publications.push({frame_id:20,published_ns:2400e6,bbox:shifted(10,0),source:'lk'});
  near(metric(weighted).p50_px,0);near(metric(weighted).p95_px,0);near(metric(weighted).mean_px,.5);
}
{
  const f=fixture();f.journal.state_contract=true;
  f.journal.publications=[{frame_id:null,published_ns:1000e6,bbox:null,source:'clear'},
    {frame_id:15,published_ns:1500e6,bbox:shifted(100,40),source:'yolo'}];
  const c=metric(f);near(c.absent_ms,500);near(c.unknown_ms,500);near(c.evaluated_ms,1000);
  near(c.mean_px,Math.hypot(100,40));near(c.coverage,.5);assert.equal(c.whole_run_statistics,null);
  assert.ok(result(f).good_fraction===0,'low IoU and large errors remain in center distribution');
}
{
  const f=fixture();f.journal.frames[0].capture_ns=0; // 100 ms uncertainty, not a point offset.
  assert.equal(metric(f).coverage,1,'nonzero offset width alone must not discard the run');
  f.journal.publications.push({frame_id:10,published_ns:1000e6,bbox:shifted(10,0),source:'lk'});
  const c=metric(f);near(c.unknown_ms,100);near(c.evaluated_ms,1900);near(c.coverage,.95);
  assert.ok(c.mean_px>7 && c.mean_px<8);assert.equal(c.whole_run_statistics,null);
  assert.equal(c.unknown_reasons_ms.offset_ambiguity,100);
  const interior=fixture();interior.journal.frames[0].capture_ns=0;
  interior.journal.publications.push({frame_id:10,published_ns:1020e6,bbox:shifted(10,0),source:'lk'},
    {frame_id:10,published_ns:1040e6,bbox:[.2,.2,.4,.4],source:'lk'});
  // At reference 1050 ms, both extreme offsets show zero error; an interior
  // common offset shows 10 px. Checking endpoints alone would miss this.
  near(metric(interior).unknown_ms,120);near(metric(interior).mean_px,0);
  // A delayed held box must be compared with the current reference, not its source frame.
  const delayed=fixture();for(let i=10;i<25;i++)delayed.run.samples[i].bbox_screen_px=[30,20,50,40];
  near(metric(delayed).mean_px,15); // 0 for 500 ms, 20 px for 1500 ms.
}
{
  const f=fixture();f.journal.publications=[];
  assert.equal(metric(f).mean_px,null);assert.equal(metric(f).absent_ms,2000);
  f.journal.state_contract=true;assert.equal(metric(f).unknown_ms,2000);assert.equal(metric(f).absent_ms,0);
  f.journal.frames.forEach(frame=>frame.capture_ns=null);
  assert.equal(metric(f).unknown_reasons_ms.insufficient_capture,2000);
}
{
  const f=fixture();f.journal.geometry={};f.journal.calibration_image={};
  assert.equal(metric(f).unavailable_reason,'missing_frame_dimensions');
  const g=fixture();g.journal.frames[15].width=999;
  assert.equal(metric(g).unknown_reasons_ms.conflicting_frame_geometry,2000);
  const t=fixture();t.journal.truncated=true;assert.equal(metric(t).evaluated_ms,0);
  const old=result(fixture()).provenance;
  assert.equal(old.android.fields.git_sha,null);assert.equal(old.source.series_id,null);
}
{
  const f=fixture();f.run.samples[10].phase='turn';f.run.samples[11].phase='blank_after';f.run.samples[11].visible=false;
  assert.equal(metric(f).expected_ms,1800);assert.equal(metric(f).evaluated_ms,1800);
  // Equal timestamps use the final publication; a zero-duration state adds no weight.
  f.journal.publications.push({frame_id:null,published_ns:1200e6,bbox:null,source:'clear'},
    {frame_id:12,published_ns:1200e6,bbox:[.2,.2,.4,.4],source:'lk'});
  near(metric(f).mean_px,0);assert.equal(metric(f).absent_ms,0);
}
{
  const f=fixture(), parser=timelineImporter(), base=900719925474099300n;let id=0;
  const push=(type,data,t=0)=>parser.push({schema:'dronecv-session-timeline-1',session_id:'session',event_id:String(++id),event_ns:String(base+BigInt(t)),type,data});
  push('header',{start_ns:String(base),mode:'yolo'});
  const metadata={mode:'yolo',confidence:.5,nms_iou:.7,backend:'onnxruntime_cpu_sequential',intra_op_threads:2,
    yolo_period_ns:'300000000',confirmation_ttl_ns:'900000000',lk:{max_points:60},
    camera_context:{git_sha:'abc',git_dirty:false,app_version:'0.5.2',model_asset:'model.onnx',model_sha256:'sha',
      device:'synthetic',android_release:'16',requested_zoom:5,latest_capture_zoom:4.9,requested_af:1,actual_af:0,
      scope:'latest_context_not_frame_bound'}};
  push('metadata',metadata);push('metadata',{geometry:f.journal.geometry,calibration_image:f.journal.calibration_image});
  push('state',{publication_ns:String(base),box:[.2,.2,.4,.4],reason:'initial_snapshot',result_source:'yolo'});
  for(const frame of f.journal.frames)push('frame',{frame_id:String(frame.frame_id),analyzer_entry_ns:String(base+BigInt(frame.analyzer_ns)),
    capture_ns:String(base+BigInt(frame.capture_ns)),timebase:'elapsed_realtime',marker:frame.marker,width:200,height:100},frame.analyzer_ns);
  push('session_end',{stop_ns:String(base+3000000000n),recording_complete:true,dropped_count:'0',accepted_count:String(id),written_count:String(id),interrupted:false});
  f.journal=parser.finish();Object.assign(f.run,{series_id:'series',pair_index:2,slot:1,order:'BA'});
  const r=result(f), exported=JSON.parse(JSON.stringify({schema:'dronecv-motion-report-4',runs:[r]})).runs[0];
  assert.deepEqual(exported.center_error,r.center_error);near(r.center_error.mean_px,0);
  assert.equal(exported.provenance.android.fields.git_sha,'abc');assert.equal(exported.provenance.android.fields.git_dirty,false);
  assert.deepEqual(exported.provenance.android.fields.camera_context,metadata.camera_context);
  assert.equal(exported.provenance.source.session_id,'session');assert.equal(exported.provenance.source.order,'BA');
  assert.equal(exported.provenance.android.records[1].event_ns,String(base));
  f.journal.metadata_records.push({type:'metadata',data:{confidence:.7}});
  const conflict=result(f).provenance.android;
  assert.equal(conflict.fields.confidence,null);assert.equal(conflict.conflicts.confidence.length,2);
  f.journal.metadata_records.push({type:'diagnostic_report',data:{model:{name:'YOLO11s',asset:'other.onnx',sha256:'other-sha',backend:'CPU',intra_op_threads:4}}});
  const model=result(f).provenance.android;
  assert.equal(model.fields.model_name,'YOLO11s');assert.equal(model.fields.model_sha256,null);
  assert.equal(model.conflicts.model_sha256.length,2);assert.equal(model.conflicts.intra_op_threads.length,2);
}
{
  const parser=timelineImporter();let id=0;
  const push=(type,data)=>parser.push({schema:'dronecv-session-timeline-1',session_id:'geometry',event_id:String(++id),event_ns:'100',type,data});
  push('header',{start_ns:'100',mode:'yolo'});
  push('frame_geometry',{source_width:400,source_height:300,crop:[0,0,200,100],rotation_degrees:0});
  push('frame_geometry',{source_width:400,source_height:300,crop:[10,10,210,110],rotation_degrees:0});
  const j=parser.finish();assert.equal(j.geometry_conflict,true);
  assert.equal(j.metadata_records.filter(r=>r.type==='frame_geometry').length,2);
  const f=fixture();f.journal.metadata_records=[{type:'frame_geometry',data:{crop:[0,0,100,200],rotation_degrees:90}}];
  assert.equal(metric(f).coverage,1);
  f.journal.metadata_records[0].data.rotation_degrees=0;
  assert.equal(metric(f).unknown_reasons_ms.conflicting_frame_geometry,2000);
}
console.log('synthetic center error tests passed');

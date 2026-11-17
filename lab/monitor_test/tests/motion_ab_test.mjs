import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),AB=require('../motion-ab.js');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function fixture(){
  const series=AB.create({id:'series',factor:'mode',variants:{A:{value:'yolo',description:'YOLO'},B:{value:'yolo_lk',description:'YOLO+LK'}},base_values:{target_width_px:40}});
  const fields={git_sha:'abc',git_dirty:false,app_version:'1.0',version_code:1,build_type:'debug',model_sha256:'model',device:'phone',confidence:.25,nms_iou:.45,backend:'cpu',model_input_size:640,camera_context:{logical_id:'0',confirmed_zoom:1,latest_capture_zoom:1}};
  const runs=['A','B'].map((slot,i)=>({run_id:'1234567'+i,complete:true,series_id:series.id,pair_index:1,slot,
    photo:{sha256:'photo',bbox:[0,0,1,1],width:100,height:100},conditions:{setup_id:'desk',zoom:'1',orientation:'landscape',camera_config:'rear',distance_cm:30,viewport:{width:1000,height:800,dpr:1}},
    sync_period_ms:100,scenario:{version:'simple-motion-v1',target_width_px:40,max_speed_px_s:150,acceleration_px_s2:500,laps:2,workspace:{x:0,y:0,width:1000,height:800},movement_ms:7000}}));
  for(const r of runs){AB.begin(series,{pair_index:1,slot:r.slot,run_id:r.run_id});AB.select(series,1,r.slot,r.run_id);
    series.analyses.push({run_id:r.run_id,source_hash:r.run_id,result:{mode:series.variants[r.slot].value,criterion_version:'motion-scenario-v5',timing_status:'compatible',recording_complete:true,
      expected_ms:1000,evaluated_ms:666,good_fraction_lower:.55278,good_fraction_upper:.88678,coverage:.666,good_fraction:.83,good_ms:552.78,bad_ms:113.22,unknown_ms:334,total_frames:100,matched_frames:80,
      longest_failure_ms:50,longest_possible_failure_ms:300,center_error:{p50_px:3,p95_px:5,coverage:.537},capture:{status:'bounded',lower_ms:59,upper_ms:420},
      cleanup:{status:'right_censored',lower_ms:50,upper_ms:null,reason:'not observed'},reacquisition:{status:'unavailable',reason:'not observed'},provenance:{geometry:{width:100,height:100},android:{fields:structuredClone(fields)}}},
      journal:{complete:true,truncated:false,frames:[{frame_id:1,capture_ns:100e6},{frame_id:2,capture_ns:200e6}],publications:[{frame_id:1,published_ns:120e6,source:'yolo',bbox:[0,0,1,1]},{frame_id:2,published_ns:230e6,source:'lk',bbox:[0,0,1,1]}]}});
  }
  return {series,runs};
}
test('frozen snapshot and AB BA schedule, attempts require explicit selection',()=>{
  const input={id:'x',factor:'speed',variants:{A:{value:150},B:{value:300}},base_values:{width:40}},s=AB.create(input);input.base_values.width=100;input.variants.A.value=1;
  assert.equal(s.base_values.width,40);assert.equal(s.variants.A.value,150);assert.deepEqual(AB.schedule(s).map(r=>r.slot),['A','B','B','A','A','B']);
  assert.equal(s.metadata_provenance.conditions,'operator_input');assert.equal(s.metadata_provenance.phone_fields,'journal_metadata');
  AB.begin(s,{run_id:'a',pair_index:1,slot:'A'});AB.begin(s,{run_id:'b',pair_index:1,slot:'A'});
  assert.equal(s.attempts[1].attempt,2);assert.equal(s.attempts[1].actual_order,2);assert.deepEqual(s.selections,{});AB.select(s,1,'A','a');assert.equal(s.selections['1:A'],'a');
  assert.throws(()=>AB.select(s,1,'B','a'));assert.throws(()=>AB.begin(s,{run_id:'a',pair_index:1,slot:'B'}));
});
test('independent A/A exact differences are zero and intervals contain zero',()=>{
  const {series,runs}=fixture(),p=AB.compare(series,1,runs);assert.equal(p.state,'complete');
  const metric=key=>p.rows.find(r=>r.key===key);
  assert.equal(metric('good_fraction').delta.value,0);assert.equal(metric('center_p95').delta.value,0);
  near(metric('holding').delta.lower,-33.4);near(metric('holding').delta.upper,33.4);near(metric('capture').delta.lower,-361);near(metric('capture').delta.upper,361);
  assert.equal(metric('cleanup').delta.status,'unavailable');assert.equal(metric('reacquisition').A.status,'unavailable');
  assert.equal(metric('latency_yolo_p50').A.n,1);assert.equal(metric('latency_lk_p95').A.value,30);
});
test('swapping A and B negates exact and interval deltas',()=>{
  const a={status:'bounded',lower:10,upper:20,unit:'ms'},b={status:'bounded',lower:30,upper:50,unit:'ms'},ab=AB.delta(a,b),ba=AB.delta(b,a);
  assert.equal(ab.lower,-ba.upper);assert.equal(ab.upper,-ba.lower);
  assert.equal(AB.delta({status:'available',value:.3,unit:'fraction'},{status:'available',value:.5,unit:'fraction'}).value,20);
});
test('83 percent at 66.6 percent coverage keeps whole-run denominator',()=>{
  const r={expected_ms:1000,evaluated_ms:666,good_fraction:.83,coverage:.666,good_ms:.83*.666*1000,bad_ms:.17*.666*1000,unknown_ms:.334*1000,good_fraction_lower:.83*.666,good_fraction_upper:.83*.666+.334};
  const m=AB.metrics(r);near(m.holding.lower,.55278);near(m.holding.upper,.88678);near(m.good_ms.value,552.78);near(m.unknown_ms.value,334);near(m.good_fraction.value,.83);near(m.good_fraction.coverage,.666);
});
test('undeclared condition changes, wrong phone mode, unknown conditions stay distinct',()=>{
  const {series,runs}=fixture();runs[1].scenario.target_width_px=41;let p=AB.compare(series,1,runs);assert.equal(p.state,'incomparable');assert.match(p.reasons.join(' '),/target_width_px/);assert.equal(p.rows[0].delta.status,'unavailable');
  runs[1].scenario.target_width_px=40;series.analyses[1].result.mode='yolo';p=AB.compare(series,1,runs);assert.match(p.reasons.join(' '),/другой режим/);
  series.analyses[1].result.mode='yolo_lk';delete runs[0].conditions.setup_id;delete runs[1].conditions.setup_id;p=AB.compare(series,1,runs);assert.equal(p.state,'unconfirmed');assert.match(p.reasons.join(' '),/setup_id/);
});
test('speed and acceleration permit selected input and derived duration, not other inputs',()=>{
  for(const factor of ['speed','acceleration']){const {series,runs}=fixture();series.factor=factor;series.variants={A:{value:150},B:{value:300}};const key=factor==='speed'?'max_speed_px_s':'acceleration_px_s2';runs[0].scenario[key]=150;runs[1].scenario[key]=300;runs[1].scenario.movement_ms=9000;series.analyses[1].result.mode='yolo';
    assert.equal(AB.compare(series,1,runs).state,'complete');runs[1].scenario.laps=3;assert.equal(AB.compare(series,1,runs).state,'incomparable');}
});
test('incomplete, missing journal, missing metric and censored event are not zero',()=>{
  const {series,runs}=fixture();runs[0].complete=false;runs[0].abort_reason='cancelled';assert.equal(AB.compare(series,1,runs).state,'interrupted');runs[0].complete=true;
  series.analyses[0].journal.truncated=true;assert.equal(AB.compare(series,1,runs).state,'incomparable');series.analyses[0].journal.truncated=false;
  series.analyses.pop();assert.equal(AB.compare(series,1,runs).state,'awaiting_journal');assert.equal(AB.metrics({}).center_p50.value,null);
  assert.equal(AB.delta({status:'right_censored',lower:4,upper:null,unit:'ms'},{status:'available',value:5,unit:'ms'}).status,'unavailable');
});
test('latency rejects unknown clocks, negative intervals, snapshot and clear',()=>{
  const journal={frames:[{frame_id:1,capture_ns:1e6}],publications:[{frame_id:1,published_ns:2e6,bbox:[0,0,1,1],source:'yolo'},{frame_id:1,published_ns:0,bbox:[0,0,1,1]},{frame_id:2,published_ns:3e6,bbox:[0,0,1,1]},{frame_id:1,published_ns:3e6,bbox:[0,0,1,1],initial_snapshot:true},{frame_id:1,published_ns:3e6,bbox:null}]};
  assert.equal(AB.latencies(journal).all.n,1);assert.equal(AB.latencies(journal).all.p95_ms,1);
});
test('journal repeat import uses content hash, foreign and ambiguous IDs rejected',async()=>{
  const {series,runs}=fixture(),data={frames:[{marker:{run_id:runs[0].run_id}}]},raw=JSON.stringify(data);
  let result=await AB.registerSource(series,{raw,data,name:'first.json'});assert.equal(result.status,'added');result=await AB.registerSource(series,{raw,data,name:'renamed.json'});assert.equal(result.status,'duplicate');assert.equal(series.journals.length,1);
  await assert.rejects(AB.registerSource(series,{raw:raw+'\n',data,name:'changed.json'}),/разным содержимым/);
  await assert.rejects(AB.registerSource(series,{raw:'foreign',data:{frames:[{marker:{run_id:'foreign'}}]},name:'foreign'}),/Чужой/);
  await assert.rejects(AB.registerSource(series,{raw:'ambiguous',data:{frames:runs.map(r=>({marker:{run_id:r.run_id}}))},name:'ambiguous'}),/неоднозначные/);
});
test('same physical source and same run cannot become independent repetitions',()=>{
  const {series,runs}=fixture();series.analyses[1].source_hash=series.analyses[0].source_hash;assert.equal(AB.compare(series,1,runs).state,'incomparable');series.selections['1:B']=runs[0].run_id;assert.equal(AB.compare(series,1,runs).state,'incomparable');
});
test('summary keeps all pairs and aggregates pair deltas with explicit unit',()=>{
  const {series,runs}=fixture(),s=AB.summarize(series,runs);assert.equal(s.planned,3);assert.equal(s.performed,1);assert.equal(s.usable,1);assert.equal(s.pairs.length,3);assert.equal(s.metrics.good_fraction.exact.n,1);assert.match(s.aggregation_rule,/не является p95/);assert.match(AB.csv(s),/awaiting_attempt/);
});
test('self-contained export/import checks sources, relationships and analysis reproducibility',async()=>{
  const {series,runs}=fixture();for(const run of runs){const data={frames:[{marker:{run_id:run.run_id}}]};const added=await AB.registerSource(series,{raw:JSON.stringify(data),data,name:run.run_id+'.json'});series.analyses.find(a=>a.run_id===run.run_id).source_hash=added.source.hash;}
  const before=JSON.stringify({series,runs}),bundle=await AB.exportBundle(series,runs),restored=await AB.importBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(JSON.stringify({series,runs}),before);assert.deepEqual(AB.summarize(restored.series,restored.runs),AB.summarize(series,runs));assert.equal(bundle.manifest.length,4);
  assert.deepEqual(bundle.summary,AB.summarize(series,runs));assert.equal(bundle.summary.pairs[1].state,'awaiting_attempt');
  bundle.series.journals[0].raw+=' ';await assert.rejects(AB.importBundle(bundle),/сумма/);
});
test('source binding validates identity and reanalysis retains versions without cloning journal',async()=>{
  const {series,runs}=fixture(),run=runs[0],data={frames:[{marker:{run_id:run.run_id}}]},added=await AB.registerSource(series,{raw:JSON.stringify(data),data,name:'journal.json'});
  assert.throws(()=>AB.bind(series,runs[1].run_id,added.source.hash),/соответствует/);
  AB.bind(series,run.run_id,added.source.hash);const result={criterion_version:'motion-scenario-v5',coverage:.5};
  const first=AB.recordAnalysis(series,run.run_id,{result,journal:data,parameters:{calibration_points:[[0,0],[1,0],[1,1],[0,1]]},source_hash:added.source.hash});
  result.coverage=.1;assert.equal(first.result.coverage,.5);assert.equal(first.journal,undefined);assert.equal(first.version,AB.VERSION);
  AB.recordAnalysis(series,run.run_id,{result,journal:data,parameters:{},source_hash:added.source.hash});assert.equal(series.analyses.filter(a=>a.run_id===run.run_id).length,3);
  const previous=series.analyses.at(-1),duplicate=AB.recordAnalysis(series,run.run_id,{result,journal:data,parameters:{},source_hash:added.source.hash});
  assert.equal(duplicate,previous);assert.equal(series.analyses.filter(a=>a.run_id===run.run_id).length,3);
});
test('preflight failures survive export without a fabricated reference',async()=>{
  const series=AB.create({id:'preflight',factor:'mode',variants:{A:{value:'yolo'},B:{value:'yolo_lk'}}});series.attempts.push({run_id:'deadbeef',pair_index:1,slot:'A',attempt:1,complete:false,abort_reason:'fullscreen denied'});
  const restored=await AB.importBundle(await AB.exportBundle(series,[]));assert.equal(restored.series.attempts[0].abort_reason,'fullscreen denied');assert.equal(restored.runs.length,0);
});
test('profile comparison verifies declared fields while preserving other phone invariants',()=>{
  const {series,runs}=fixture();series.factor='build';series.variants={A:{value:'{"confidence":0.25}'},B:{value:'{"confidence":0.5}'}};
  series.analyses[1].result.mode='yolo';series.analyses[1].result.provenance.android.fields.confidence=.5;
  assert.equal(AB.compare(series,1,runs).state,'complete');
  series.analyses[1].result.provenance.android.fields.git_sha='other';assert.equal(AB.compare(series,1,runs).state,'incomparable');
  series.analyses[1].result.provenance.android.fields.git_sha='abc';series.analyses[1].result.provenance.android.fields.confidence=.4;
  assert.match(AB.compare(series,1,runs).reasons.join(' '),/другой профиль B: confidence/);
  assert.throws(()=>AB.create({factor:'build',variants:{A:{value:'{"confidence":0.25}'},B:{value:'{"nms_iou":0.5}'}}}),/одинаковые ключи/);
  assert.throws(()=>AB.create({factor:'mode',variants:{A:{value:'YOLO'},B:{value:'yolo_lk'}}}),/Режим телефона/);
});
test('nested unknowns cannot prove equality and camera evidence detects changed zoom',()=>{
  assert.equal(AB.compareKnown({a:null},{a:null}),'unknown');assert.equal(AB.compareKnown({a:null,b:1},{a:null,b:2}),'different');
  const {series,runs}=fixture();series.analyses[1].result.provenance.android.fields.camera_context.confirmed_zoom=5;
  assert.match(AB.compare(series,1,runs).reasons.join(' '),/confirmed_zoom/);
});
test('zero denominators and unobserved conditional metrics remain unavailable',()=>{
  const base={expected_ms:0,evaluated_ms:0,coverage:0,good_fraction:0,good_fraction_lower:0,good_fraction_upper:0,good_ms:0,bad_ms:0,unknown_ms:0,longest_failure_ms:0,longest_possible_failure_ms:0,center_error:{p50_px:0,p95_px:0,evaluated_ms:0,coverage:0}};
  const empty=AB.metrics(base);for(const key of ['holding','coverage','good_ms','bad_ms','unknown_ms','good_fraction','longest_failure_ms','longest_possible_failure_ms','center_p50','center_p95','center_coverage'])assert.equal(empty[key].status,'unavailable',key);
  const unknown=AB.metrics({...base,expected_ms:1000,unknown_ms:1000,good_fraction_upper:1});assert.equal(unknown.good_fraction.status,'unavailable');assert.equal(unknown.good_fraction.value,null);assert.equal(unknown.holding.lower,0);assert.equal(unknown.holding.upper,1);assert.equal(unknown.unknown_ms.value,1000);
});
test('selected builds permit derived identity differences; dirty snapshots remain unconfirmed',()=>{
  const {series,runs}=fixture();series.factor='build';series.variants={A:{value:'abc'},B:{value:'def'}};
  const af=series.analyses[0].result.provenance.android.fields,bf=series.analyses[1].result.provenance.android.fields;
  bf.git_sha='def';bf.app_version='2.0';bf.version_code=2;bf.build_type='release';series.analyses[1].result.mode='yolo';
  assert.equal(AB.compare(series,1,runs).state,'complete');
  bf.git_dirty=true;assert.equal(AB.compare(series,1,runs).state,'unconfirmed');bf.git_dirty=false;
  series.factor='speed';series.variants={A:{value:150},B:{value:150}};
  assert.match(AB.compare(series,1,runs).reasons.join(' '),/version_code/);
  assert.equal(af.git_dirty,false);
});
test('bundle rejects excessive virtual pair count before allocating a summary',async()=>{
  const series=AB.create({factor:'speed',variants:{A:{value:1},B:{value:2}}}),bundle=await AB.exportBundle(series,[]);
  bundle.series.pair_count=1000000;delete bundle.integrity;bundle.integrity=await AB.sha256(AB.canonical(bundle));
  await assert.rejects(AB.importBundle(bundle),/структура или лимиты/);
});

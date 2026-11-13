(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotionReport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_GAP_NS = 250e6, MIN_COVERAGE = 0.9;
  const finite = Number.isFinite;
  function homography(from, to) {
    if (![from, to].every(a => Array.isArray(a) && a.length === 4 && a.every(p => Array.isArray(p) && p.length === 2 && p.every(finite)))) throw Error('Нужны четыре пары точек калибровки.');
    const m = [];
    from.forEach(([x,y], i) => { const [u,v] = to[i]; m.push([x,y,1,0,0,0,-u*x,-u*y,u], [0,0,0,x,y,1,-v*x,-v*y,v]); });
    for (let c=0;c<8;c++) { let p=c; for(let i=c+1;i<8;i++) if(Math.abs(m[i][c])>Math.abs(m[p][c])) p=i; if(Math.abs(m[p][c])<1e-10) throw Error('Точки калибровки вырождены.'); [m[c],m[p]]=[m[p],m[c]]; const d=m[c][c]; for(let j=c;j<9;j++) m[c][j]/=d; for(let i=0;i<8;i++) if(i!==c) { const k=m[i][c]; for(let j=c;j<9;j++) m[i][j]-=k*m[c][j]; } }
    const h=m.map(r=>r[8]);
    return ([x,y]) => { const d=h[6]*x+h[7]*y+1; if(Math.abs(d)<1e-10) throw Error('Недопустимое преобразование.'); return [(h[0]*x+h[1]*y+h[2])/d,(h[3]*x+h[4]*y+h[5])/d]; };
  }
  function area(p) { return Math.abs(p.reduce((s,a,i)=>{const b=p[(i+1)%p.length]; return s+a[0]*b[1]-a[1]*b[0];},0))/2; }
  function projected(box, transform) { const [l,t,r,b]=box; return [[l,t],[r,t],[r,b],[l,b]].map(transform); }
  function validBox(b) { return Array.isArray(b) && b.length===4 && b.every(finite) && b[0]>=0 && b[1]>=0 && b[2]<=1 && b[3]<=1 && b[0]<b[2] && b[1]<b[3]; }
  function iou(poly, box) {
    if (!validBox(box)) return 0;
    let p=poly;
    for (const [axis, bound, sign] of [[0,box[0],1],[0,box[2],-1],[1,box[1],1],[1,box[3],-1]]) {
      const out=[]; for(let i=0;i<p.length;i++) { const a=p[i], b=p[(i+1)%p.length], da=sign*(a[axis]-bound), db=sign*(b[axis]-bound); if(da>=0) out.push(a); if((da<0 && db>0)||(da>0 && db<0)) { const t=da/(da-db); out.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]); } } p=out;
    }
    const intersection=area(p), union=area(poly)+(box[2]-box[0])*(box[3]-box[1])-intersection;
    return union>0 ? intersection/union : 0;
  }

  function centerError(ordered, spans, transform, journal, lo, hi, timingStatus, expected) {
    const width=journal.geometry?.width, height=journal.geometry?.height;
    const reasons={};
    let evaluated=0, absent=0, unknown=0, weighted=0, maximum=null;
    const distribution=new Map();
    const geometryIssue=!(finite(width)&&width>0&&finite(height)&&height>0) ? 'missing_frame_dimensions' :
      journal.geometry_conflict || (journal.metadata_records||[]).some(r=>{
        const d=r.data;
        if(r.type!=='frame_geometry' || !Array.isArray(d.crop) || d.crop.length!==4 || !d.crop.every(finite) || !finite(d.rotation_degrees)) return false;
        const w=d.crop[2]-d.crop[0], h=d.crop[3]-d.crop[1];
        return d.rotation_degrees%180===0 ? w!==width || h!==height : h!==width || w!==height;
      }) || journal.frames.some(f=>
        (f.width!=null && f.width!==width)||(f.height!=null && f.height!==height)) ? 'conflicting_frame_geometry' : null;
    const addUnknown=(reason,d)=>{unknown+=d;reasons[reason]=(reasons[reason]||0)+d;};
    // Merge before expanding by clock uncertainty: extra identical publications
    // must not create extra ambiguous time around artificial boundaries.
    const merged=[];
    for(const span of spans) {
      const last=merged.at(-1);
      if(last && last.b===span.a && last.known===span.known && JSON.stringify(last.box)===JSON.stringify(span.box)) last.b=span.b;
      else merged.push({...span});
    }
    let first=0;
    for(let k=0;k+1<ordered.length;k++) {
      const s=ordered[k];
      if(!s.visible || !['accelerate','cruise','brake'].includes(s.phase)) continue;
      const a=s.elapsed_ms*1e6, b=ordered[k+1].elapsed_ms*1e6;
      if(geometryIssue || timingStatus!=='compatible') {addUnknown(geometryIssue||timingStatus,b-a);continue;}
      let poly;
      try {
        const box=s.bbox_screen_px;
        if(!Array.isArray(box)||box.length!==4||!box.every(finite)||box[0]>=box[2]||box[1]>=box[3]) throw Error();
        poly=projected(box,transform);
        if(!poly.every(p=>p.every(finite)) || area(poly)<=0) throw Error();
      } catch (_) {addUnknown('invalid_reference_geometry',b-a);continue;}
      const xs=poly.map(p=>p[0]), ys=poly.map(p=>p[1]);
      const cx=(Math.min(...xs)+Math.max(...xs))/2*width;
      const cy=(Math.min(...ys)+Math.max(...ys))/2*height;
      const events=[[a,null,0],[b,null,0]];
      while(first<merged.length && merged[first].b-lo<=a) first++;
      for(let i=first;i<merged.length && merged[i].a-hi<b;i++) {
        const span=merged[i], start=Math.max(a,span.a-hi), end=Math.min(b,span.b-lo);
        if(end<=start) continue;
        const value=!span.known || b-a>MAX_GAP_NS ? 'untrusted_interval' : span.box===null ? 'absent' :
          Math.hypot((span.box[0]+span.box[2])/2*width-cx,(span.box[1]+span.box[3])/2*height-cy);
        events.push([start,value,1],[end,value,-1]);
      }
      if(merged.length) {
        const left=Math.min(b,merged[0].a-lo), right=Math.max(a,merged.at(-1).b-hi);
        if(left>a) events.push([a,'outside_capture_coverage',1],[left,'outside_capture_coverage',-1]);
        if(right<b) events.push([right,'outside_capture_coverage',1],[b,'outside_capture_coverage',-1]);
      }
      events.sort((x,y)=>x[0]-y[0]);
      const active=new Map(); let previous=a, index=0;
      while(index<events.length) {
        const time=events[index][0], d=time-previous;
        if(d>0) {
          const values=[...active.keys()];
          if(values.length===1 && typeof values[0]==='number') {
            const value=values[0]; evaluated+=d;weighted+=value*d;
            distribution.set(value,(distribution.get(value)||0)+d);maximum=maximum===null?value:Math.max(maximum,value);
          } else if(values.length===1 && values[0]==='absent') absent+=d;
          else addUnknown(values.length===1?values[0]:values.length?'offset_ambiguity':'outside_capture_coverage',d);
        }
        while(index<events.length && events[index][0]===time) {
          const [,value,delta]=events[index++]; if(!delta) continue;
          const n=(active.get(value)||0)+delta;if(n)active.set(value,n);else active.delete(value);
        }
        previous=time;
      }
    }
    const sorted=[...distribution].sort((a,b)=>a[0]-b[0]);
    const quantile=q=>{let cumulative=0;for(const [value,d] of sorted){cumulative+=d;if(cumulative>=q*evaluated)return value;}return null;};
    return {version:'motion-center-error-v1',coordinate_space:'upright_crop',units:'camera_px',
      reference_center:'center_of_aabb_of_four_projected_corners',domain:'visible_accelerate_cruise_brake',
      weighting:'duration_ns',quantile:'inverse_weighted_cdf',uncertainty_method:'invariant_over_all_common_offsets',
      statistics_scope:'conditional_on_evaluated_time',expected_ms:expected/1e6,evaluated_ms:evaluated/1e6,
      absent_ms:absent/1e6,unknown_ms:unknown/1e6,coverage:expected?evaluated/expected:0,
      mean_px:evaluated?weighted/evaluated:null,p50_px:quantile(.5),p95_px:quantile(.95),max_observed_px:maximum,
      whole_run_statistics:unknown||absent?null:{mean_px:evaluated?weighted/evaluated:null,p50_px:quantile(.5),p95_px:quantile(.95),max_observed_px:maximum},
      unavailable_reason:evaluated?null:geometryIssue||'no_unambiguous_coordinates',
      unknown_reasons_ms:Object.fromEntries(Object.entries(reasons).map(([reason,d])=>[reason,d/1e6]))};
  }

  function reportMetadata(run, journal, points) {
    const records=journal.metadata_records || [{type:'legacy_journal',data:Object.fromEntries(
      Object.entries(journal).filter(([key])=>!['frames','publications','detections','calibration_image'].includes(key)))}];
    const fields=['git_sha','git_dirty','app_version','model_asset','model_sha256','model_name','mode','confidence','nms_iou','nms_max_detections','model_input_size',
      'backend','intra_op_threads','inter_op_threads','execution_mode','execution_provider','lk','yolo_period_ns','confirmation_ttl_ns','retry_ns','coordinate_timeout_ns',
      'device','android_release','android_sdk','camera_context'];
    const values=Object.fromEntries(fields.map(key=>[key,[]]));
    const canonical=v=>JSON.stringify(v,(_,x)=>x && !Array.isArray(x) && typeof x==='object' ?
      Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
    for(const record of [{type:'journal',data:{mode:journal.mode}},...records]) {
      const d=record.data;
      for(const key of fields) for(const source of [d,d?.metadata,d?.camera_context,d?.metadata?.camera_context,
        d?.model && {model_asset:d.model.asset,model_sha256:d.model.sha256,model_name:d.model.name,confidence:d.model.confidence,
          nms_iou:d.model.nms_iou,backend:d.model.backend,intra_op_threads:d.model.intra_op_threads,
          inter_op_threads:d.model.inter_op_threads,execution_mode:d.model.execution_mode,execution_provider:d.model.execution_provider}]) {
        if(source?.[key]!=null && !values[key].some(v=>canonical(v.value)===canonical(source[key])))
          values[key].push({value:source[key],source_type:record.type,event_id:record.event_id??null});
      }
    }
    return {android:{fields:Object.fromEntries(fields.map(key=>[key,values[key].length===1?values[key][0].value:null])),
      conflicts:Object.fromEntries(fields.filter(key=>values[key].length>1).map(key=>[key,values[key]])),records,
      camera_context_scope:'latest_context_not_frame_bound'},
      source:{journal_schema:journal.source_schema??journal.schema,session_id:journal.session_id??null,run_id:run.run_id,
        series_id:run.series_id??null,pair_index:run.pair_index??null,slot:run.slot??null,order:run.order??null},
      geometry:journal.geometry??null,calibration:{screen_points:run.calibration_points,camera_normalized_points:points},
      scenario:run.scenario??null,conditions:run.conditions??null,photo:run.photo??null};
  }
  function analyze(run, journal, points) {
    if(run?.schema!=='dronecv-motion-run-1' || journal?.schema!=='dronecv-motion-android-1') throw Error('Неподдерживаемый формат JSON.');
    if(!Array.isArray(run.samples)||!Array.isArray(journal.frames)||!Array.isArray(journal.publications)||!Array.isArray(journal.detections)) throw Error('Отсутствуют записи.');
    if(!['yolo','yolo_lk'].includes(run.mode)||run.mode!==journal.mode) throw Error('Режимы эталона и журнала не совпадают.');
    if(!finite(journal.stop_ns) || journal.stop_ns<0) throw Error('Некорректное время остановки.');
    if(!journal.geometry || !journal.calibration_image || journal.geometry.width!==journal.calibration_image.width || journal.geometry.height!==journal.calibration_image.height) throw Error('Нет совместимого калибровочного кадра.');
    if(!points.every(p=>p.every(v=>finite(v)&&v>=0&&v<=1))) throw Error('Точки должны находиться внутри кадра.');
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
    const turns=points.map((p,i)=>cross(p,points[(i+1)%4],points[(i+2)%4]));
    if(turns.some(v=>v<=1e-7)) throw Error('Точки должны образовывать невырожденный контур TL → TR → BR → BL.');
    const transform=homography(run.calibration_points, points), samples=new Map();
    for(const s of run.samples) { if(s.run_id!==run.run_id || !Number.isInteger(s.step_id) || samples.has(s.step_id) || !finite(s.elapsed_ms)) throw Error('Некорректный run_id или step_id эталона.'); samples.set(s.step_id,s); }
    const ordered=run.samples.slice().sort((a,b)=>a.elapsed_ms-b.elapsed_ms);
    if(ordered.some((s,i)=>i && (s.elapsed_ms<=ordered[i-1].elapsed_ms || s.step_id<=ordered[i-1].step_id))) throw Error('Некорректный порядок эталона.');
    const visible=ordered.filter(s=>s.visible); if(!visible.length) throw Error('В эталоне нет видимой фазы.');
    const moving=s=>s.visible && ['accelerate','cruise','brake'].includes(s.phase);
    const expected=ordered.slice(0,-1).reduce((sum,s,i)=>sum+(moving(s)?(ordered[i+1].elapsed_ms-s.elapsed_ms)*1e6:0),0);
    // Only exposure timestamps share the fixed clock offset. Analyzer timestamps
    // are useful for diagnostics and locating gaps, but cannot anchor the clocks.
    const clock=journal.frames.some(f=>finite(f.capture_ns)) ? 'capture_ns' : 'analyzer_ns';
    const allFrames=journal.frames.slice();
    if(allFrames.some(f=>!Number.isInteger(f.frame_id) ||
      (finite(f.capture_ns) && f.capture_ns>journal.stop_ns) ||
      (finite(f.analyzer_ns) && f.analyzer_ns>journal.stop_ns)) ||
      new Set(allFrames.map(f=>f.frame_id)).size!==allFrames.length) throw Error('Некорректные времена или номера кадров.');
    const frames=allFrames.filter(f=>finite(f.capture_ns)).sort((a,b)=>a.capture_ns-b.capture_ns);
    if(frames.some((f,i)=>i && (f.capture_ns<=frames[i-1].capture_ns || f.frame_id<=frames[i-1].frame_id))) throw Error('Некорректные времена или номера кадров.');
    const pubs=journal.publications.slice().sort((a,b)=>a.published_ns-b.published_ns);
    const frameIds=new Set(allFrames.map(f=>f.frame_id));
    if(pubs.some(p=>!finite(p.published_ns)||p.published_ns>journal.stop_ns||(p.frame_id!==null && !frameIds.has(p.frame_id))||!['clear','yolo','lk'].includes(p.source)||(p.source==='clear' ? p.bbox!==null : !validBox(p.bbox)))) throw Error('Некорректные публикации.');
    const matched=f=>f?.marker && f.marker.run_id===run.run_id && samples.get(f.marker.step_id) || null;
    let matchedFrames=0, missing=0, other=0, reversed=false, lastStep=-Infinity;
    for(const f of allFrames) { if(matched(f)) matchedFrames++; else if(f.marker) other++; else missing++; }
    for(const f of frames) { const s=matched(f); if(s) { if(s.step_id<lastStep) reversed=true; lastStep=s.step_id; } }
    const stepWindows=new Map();
    for(const f of frames) { const s=matched(f); if(!s) continue; const w=stepWindows.get(s.step_id); if(w) w.last=f.capture_ns; else stepWindows.set(s.step_id,{first:f.capture_ns,last:f.capture_ns}); }
    const stalled=new Set();
    for(let i=0;i+1<ordered.length;i++) { const w=stepWindows.get(ordered[i].step_id); if(w && w.last-w.first>(ordered[i+1].elapsed_ms-ordered[i].elapsed_ms)*1e6+0.001) stalled.add(ordered[i].step_id); }
    const before=frames.some(f=>matched(f)?.phase==='blank_before');
    const after=frames.some(f=>matched(f)?.phase==='blank_after');
    const sampleIndex=new Map(ordered.map((s,i)=>[s.step_id,i]));
    const bounds=f=>{ const s=matched(f), i=s && sampleIndex.get(s.step_id); if(i==null) return null; return [i+1<ordered.length ? f.capture_ns-ordered[i+1].elapsed_ms*1e6 : -Infinity,f.capture_ns-s.elapsed_ms*1e6]; };
    let lo=-Infinity, hi=Infinity;
    for(const f of frames) { const b=bounds(f); if(b) { lo=Math.max(lo,b[0]); hi=Math.min(hi,b[1]); } }
    const alignmentInvalid=lo>=hi;
    const timingStatus=alignmentInvalid?'incompatible':finite(lo)&&finite(hi)?'compatible':'insufficient_capture';
    let evaluated=0, good=0, bad=0, unknown=0, blank=0, falseBlank=0, falseBlankIntervals=0;
    let longest=0, longestPossible=0, loss=0, possibleLoss=0, possibleHasUnknown=false, uncertainLoss=false;
    function record(kind,duration) {
      if(duration<=0) return;
      if(kind==='G') { good+=duration; evaluated+=duration; loss=0; possibleLoss=0; possibleHasUnknown=false; }
      else if(kind==='B') { bad+=duration; evaluated+=duration; loss+=duration; possibleLoss+=duration; }
      else { unknown+=duration; loss=0; possibleLoss+=duration; possibleHasUnknown=true; }
      longest=Math.max(longest,loss); longestPossible=Math.max(longestPossible,possibleLoss);
      if(possibleHasUnknown && possibleLoss>500e6+0.001) uncertainLoss=true;
    }
    const compatible=f=>!!matched(f) && !stalled.has(matched(f).step_id);
    // Frame IDs are assigned in acquisition order by MotionJournal. An
    // untimed frame between two exposures makes that entire span unknown;
    // analyzer timestamps never locate the exposure within it.
    const missingIds=allFrames.filter(f=>!finite(f.capture_ns)).map(f=>f.frame_id).sort((a,b)=>a-b);
    let gapIndex=0, pi=0, active=null;
    const spans=[];
    for(let i=0;i+1<frames.length;i++) {
      const f=frames[i], n=frames[i+1], a=f.capture_ns, b=n.capture_ns;
      while(gapIndex<missingIds.length && missingIds[gapIndex]<f.frame_id) gapIndex++;
      const gap=gapIndex<missingIds.length && missingIds[gapIndex]<n.frame_id;
      const c=matched(f), following=matched(n);
      const known=!journal.truncated && !gap && compatible(f) && compatible(n) && following.step_id>=c.step_id && b-a<=MAX_GAP_NS;
      while(pi<pubs.length && pubs[pi].published_ns<=a) active=pubs[pi++];
      let t=a;
      while(t<b) {
        const end=Math.min(b,pi<pubs.length?pubs[pi].published_ns:b);
        if(end>t) spans.push({a:t,b:end,known:known && (!journal.state_contract || active!==null) && active?.state_known!==false,box:active?.bbox??null});
        t=end;
        while(pi<pubs.length && pubs[pi].published_ns<=t) active=pubs[pi++];
      }
    }
    // Each expanded range contains all reference instants where this Android
    // outcome is possible for some *common* offset. Combining them pointwise is
    // an over-approximation, so ambiguity can only widen the final bounds.
    let spanStart=0;
    for(let k=0;k+1<ordered.length;k++) {
      const s=ordered[k], start=s.elapsed_ms*1e6, end=ordered[k+1].elapsed_ms*1e6;
      if(!moving(s) && s.visible) { loss=0; possibleLoss=0; possibleHasUnknown=false; continue; }
      if(timingStatus!=='compatible') { if(moving(s)) record('U',end-start); continue; }
      while(spanStart<spans.length && spans[spanStart].b-lo<=start) spanStart++;
      const events=[[start,'edge',0],[end,'edge',0]];
      const poly=moving(s)?projected(s.bbox_screen_px,transform):null;
      for(let j=spanStart;j<spans.length && spans[j].a-hi<end;j++) {
        const span=spans[j], a=Math.max(start,span.a-hi), b=Math.min(end,span.b-lo);
        if(b<=a) continue;
        const kind=!span.known || end-start>MAX_GAP_NS?'U':moving(s)?(span.box && iou(poly,span.box)>=0.5?'G':'B'):(span.box?'G':'B');
        events.push([a,kind,1],[b,kind,-1]);
      }
      // Outside the trusted frame coverage is another possible unknown outcome.
      const left=Math.min(end,frames[0].capture_ns-lo);
      const right=Math.max(start,frames.at(-1).capture_ns-hi);
      if(left>start) events.push([start,'U',1],[left,'U',-1]);
      if(right<end) events.push([right,'U',1],[end,'U',-1]);
      events.sort((a,b)=>a[0]-b[0]);
      const counts={G:0,B:0,U:0}; let previous=start, idx=0;
      while(idx<events.length) {
        const t=events[idx][0], duration=t-previous;
        const kind=counts.U || (!counts.G && !counts.B) || (counts.G && counts.B)?'U':counts.G?'G':'B';
        if(moving(s)) record(kind,duration);
        else if(kind!=='U' && duration>0) { blank+=duration; if(kind==='G') { falseBlank+=duration; falseBlankIntervals++; } }
        while(idx<events.length && events[idx][0]===t) { const [,type,delta]=events[idx++]; if(type!=='edge') counts[type]+=delta; }
        previous=t;
      }
      if(!s.visible) { loss=0; possibleLoss=0; possibleHasUnknown=false; }
    }
    const first=frames.find(f=>matched(f)?.visible), frameById=new Map(allFrames.map(f=>[f.frame_id,f]));
    if(journal.detections.some(d=>!finite(d.published_ns)||d.published_ns>journal.stop_ns||!validBox(d.bbox)||!frameById.has(d.frame_id))) throw Error('Некорректные детекции.');
    const detections=journal.detections.slice().sort((a,b)=>a.published_ns-b.published_ns);
    const capture=detections.find(d=>{const f=frameById.get(d.frame_id), s=matched(f); return first && s?.visible && finite(f.capture_ns) && f.capture_ns>=first.capture_ns && d.published_ns>=f.capture_ns && iou(projected(s.bbox_screen_px,transform),d.bbox)>=0.5;});
    const coverage=expected>0 ? Math.min(1,evaluated/expected) : 0, ratio=evaluated?good/evaluated:0;
    const lower=expected?good/expected:0, upper=expected?(good+unknown)/expected:0;
    const valid=!!run.complete && !!journal.complete && !journal.truncated && expected>0 && !reversed;
    const boundaries=before && after;
    const movingSteps=new Set(frames.filter(f=>compatible(f) && moving(matched(f))).map(f=>matched(f).step_id));
    const progressed=movingSteps.size>1;
    const sufficient=valid && boundaries && coverage>=MIN_COVERAGE && !!first && progressed;
    let pass=null, decision_reason='Недостаточно данных для решения.';
    if(timingStatus==='compatible' && valid && (upper<0.9-1e-12 || longest>500e6+0.001)) { pass=false; decision_reason='Доказано нарушение критерия удержания.'; }
    else if(timingStatus==='compatible' && sufficient && lower>=0.9-1e-12 && !uncertainLoss) { pass=true; decision_reason='Оба критерия удержания подтверждены.'; }
    else if(alignmentInvalid) decision_reason='Метки несовместимы с единым смещением часов.';
    else if(timingStatus==='insufficient_capture') decision_reason='Недостаточно меток экспозиции для сопоставления часов.';
    else if(!progressed) decision_reason='Недостаточно подтверждений продвижения движения.';
    else if(!boundaries) decision_reason='Нет подтверждения начальной и конечной пустых фаз.';
    else if(reversed) decision_reason='Нарушен порядок меток сценария.';
    else if(uncertainLoss) decision_reason='Неизвестный участок может скрывать длинный провал.';
    const center_error=centerError(ordered,spans,transform,journal,lo,hi,timingStatus,expected);
    const provenance=reportMetadata(run,journal,points);
    return {center_error,provenance,run_id:run.run_id,mode:run.mode,criterion_version:'motion-retention-v3',decision_reason,clock,timing_status:timingStatus,offset_lower_ms:finite(lo)?lo/1e6:null,offset_upper_ms:finite(hi)?hi/1e6:null,total_frames:allFrames.length,matched_frames:matchedFrames,missing_markers:missing,unmatched_markers:other,marker_order_invalid:reversed,alignment_invalid:alignmentInvalid,unknown_may_hide_long_failure:uncertainLoss,coverage,expected_ms:expected/1e6,evaluated_ms:evaluated/1e6,good_ms:good/1e6,bad_ms:bad/1e6,unknown_ms:unknown/1e6,good_fraction:ratio,good_fraction_lower:lower,good_fraction_upper:upper,longest_failure_ms:longest/1e6,longest_possible_failure_ms:longestPossible/1e6,blank_evaluated_ms:blank/1e6,false_box_blank_ms:falseBlank/1e6,false_box_blank_intervals:falseBlankIntervals,capture_latency_ms:capture?(capture.published_ns-first.capture_ns)/1e6:null,capture_frame_id:capture?(frameById.get(capture.frame_id)?.original_frame_id??capture.frame_id):null,recording_complete:journal.recording_complete??null,experiment_status:journal.experiment_status??null,sufficient,pass};
  }

  // Long timestamps are subtracted as BigInt before converting to Number. Frame
  // IDs remain available as strings; the legacy evaluator uses dense indices.
  function timelineImporter() {
    let start=null, session=null, lastId=null, footer=null, broken=false, latest=0, accepted=0n, missing=0n, firstMissing=null, lastMissing=null;
    let diagnosticRequired=false, diagnosticReports=0;
    const j={schema:'dronecv-motion-android-1',frames:[],detections:[],publications:[],complete:false,truncated:true};
    const ids=new Map(), states=[];
    j.source_schema='dronecv-session-timeline-1';j.metadata_records=[];
    j.state_contract=true;
    const integer=(v,name)=>{if(typeof v!=='string'||!/^\d+$/.test(v)) throw Error(`Некорректное поле ${name}.`);return BigInt(v);};
    const relative=(v,name)=>{if(v==null)return null;const n=integer(v,name)-start;if(n < -BigInt(Number.MAX_SAFE_INTEGER)||n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Длительность превышает точный диапазон JavaScript.');return Number(n);};
    function push(row) {
      if(row?.schema!=='dronecv-session-timeline-1') throw Error(`Неподдерживаемая версия журнала: ${row?.schema}`);
      if(!row.data || typeof row.data!=='object'||typeof row.session_id!=='string') throw Error('Некорректная запись журнала.');
      const id=integer(row.event_id,'event_id'); integer(row.event_ns,'event_ns');
      if(session===null) session=row.session_id;
      if(session!==row.session_id||footer || (lastId===null && id!==1n)) broken=true;
      if(lastId!==null && id!==lastId+1n) {broken=true;if(id>lastId+1n){missing+=id-lastId-1n;firstMissing??=lastId+1n;lastMissing=id-1n;}}
      lastId=id; const d=row.data;
      if(['header','metadata','diagnostic_report','frame_geometry'].includes(row.type)) {
        const data=Object.fromEntries(Object.entries(d).filter(([key])=>!['frames','resources','tracking','calibration_image'].includes(key)));
        if(d.calibration_image) data.calibration_image={width:d.calibration_image.width,height:d.calibration_image.height};
        j.metadata_records.push({type:row.type,event_id:row.event_id,event_ns:row.event_ns,data});
      }
      if(row.type==='frame_geometry' && Array.isArray(d.crop) && d.crop.length===4) {
        const signature=JSON.stringify([d.source_width,d.source_height,d.crop,d.rotation_degrees]);
        if(j.frame_geometry_signature && j.frame_geometry_signature!==signature)j.geometry_conflict=true;
        j.frame_geometry_signature=signature;
      }
      if(start!==null) latest=Math.max(latest,relative(row.event_ns,'event_ns'));
      if(row.type==='state' && start!==null) latest=Math.max(latest,relative(d.publication_ns,'publication_ns'));
      if(row.type!=='session_end' && row.type!=='recording_failure') accepted++;
      if(row.type==='header') { if(start!==null) throw Error('Повторный заголовок.');start=integer(d.start_ns,'start_ns');j.mode=d.mode;diagnosticRequired=d.diagnostic_report_required===true; }
      else if(start===null) throw Error('Отсутствует заголовок.');
      else if(row.type==='metadata') {
        if(d.geometry) {if(j.geometry && (j.geometry.width!==d.geometry.width || j.geometry.height!==d.geometry.height))j.geometry_conflict=true;j.geometry=d.geometry;}
        if(d.calibration_image)j.calibration_image=d.calibration_image;
      }
      else if(row.type==='frame') {
        integer(d.frame_id,'frame_id'); if(ids.has(d.frame_id)) throw Error('Повторный номер кадра.');
        const dense=j.frames.length+1;ids.set(d.frame_id,dense);
        const entry=relative(d.analyzer_entry_ns,'analyzer_entry_ns');
        const usable=d.timebase==='elapsed_realtime' && typeof d.capture_ns==='string' && /^\d+$/.test(d.capture_ns) && BigInt(d.capture_ns)>0n && BigInt(d.capture_ns)<=integer(d.analyzer_entry_ns,'analyzer_entry_ns');
        const capture=usable ? relative(d.capture_ns,'capture_ns') : null;
        j.frames.push({frame_id:dense,original_frame_id:d.frame_id,analyzer_ns:entry,capture_ns:capture,raw_capture_ns:d.capture_ns??null,timebase:d.timebase,marker:d.marker,width:d.width??null,height:d.height??null});
      } else if(row.type==='detection') {
        j.detections.push({original_frame_id:d.frame_id,published_ns:relative(d.published_ns,'published_ns'),bbox:d.bbox,confidence:d.confidence});
      } else if(row.type==='publication') {
        j.publications.push({original_frame_id:d.frame_id,published_ns:relative(d.published_ns,'published_ns'),bbox:d.bbox,source:d.source});
      } else if(row.type==='state') {
        const initial=d.reason==='initial_snapshot';
        states.push({original_frame_id:initial?null:d.motion_frame_id??null,controller_frame_id:d.frame_id??null,
          published_ns:relative(d.publication_ns,'publication_ns'),bbox:d.box??null,
          source:d.box==null?'clear':d.result_source==='yolo'?'yolo':'lk',
          state_known:Object.hasOwn(d,'box'),initial_snapshot:initial});
      } else if(row.type==='session_end') {footer=d;try {j.stop_ns=relative(d.stop_ns,'stop_ns');} catch (_) {broken=true;footer=null;}}
      else if(row.type==='recording_failure') broken=true;
      else if(row.type==='diagnostic_report') diagnosticReports++;
      else if(!['state','resource','diagnostic_frame','tracking','frame_geometry','stale_discard','discard'].includes(row.type)) throw Error(`Неизвестная запись: ${row.type}`);
    }
    function finish(partial=false) {
      if(start===null) throw Error('Отсутствует заголовок.');
      let incomplete=partial || broken || !footer || (diagnosticRequired && diagnosticReports!==1);
      if(footer) try {
        const dropped=integer(footer.dropped_count,'dropped_count');
        const recorded=integer(footer.accepted_count,'accepted_count');
        const written=integer(footer.written_count,'written_count');
        const bounds=firstMissing===null ? footer.missing_first_event_id==null && footer.missing_last_event_id==null :
          footer.missing_first_event_id===String(firstMissing) && footer.missing_last_event_id===String(lastMissing);
        incomplete ||= footer.recording_complete!==true || dropped!==0n || dropped!==missing || recorded!==accepted || written!==accepted || !bounds;
      } catch (_) {incomplete=true;}
      // State is authoritative for coordinate transitions. The legacy publication
      // emitted at the same instant is one observation, not a second transition.
      const keys=new Set(states.map(p=>JSON.stringify([p.published_ns,p.bbox])));
      j.publications=j.publications.filter(p=>!keys.has(JSON.stringify([p.published_ns,p.bbox]))).concat(states);
      for(const p of [...j.detections,...j.publications]) {
        p.frame_id=p.original_frame_id===null?null:ids.get(p.original_frame_id);
        if(p.frame_id===undefined) {
          // A state can originate from work started before this recording.
          if(!Object.hasOwn(p,'controller_frame_id') && !incomplete)throw Error('Ссылка на отсутствующий кадр.');
          p.frame_id=null;p.frame_reference='outside_recording';
        } else if(p.frame_id===null) p.frame_reference='unavailable';
      }
      if(incomplete) j.detections=j.detections.filter(d=>d.frame_id!==null);
      if(!footer) j.stop_ns=latest;
      j.complete=!incomplete && footer.interrupted===false;j.truncated=incomplete;
      j.recording_complete=!incomplete;j.experiment_status=footer?.experiment_status??'unknown';j.session_id=session;
      return j;
    }
    return {push,finish};
  }

  function maxima(items) {
    // Object key order in imported JSON does not change the experimental conditions.
    const canonical = value => Array.isArray(value) ? value.map(canonical) :
      value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
    const groups=new Map(), appearances=new Map();
    for(const {run,result} of items) {
      const s=run.scenario;
      const config=canonical({mode:run.mode,size_px:s.target_width_px,max_speed_px_s:s.max_speed_px_s,
        photo:run.photo,conditions:run.conditions,viewport:{width:s.width,height:s.height},laps:s.laps});
      const key=JSON.stringify(config), a=s.acceleration_px_s2;
      const g=groups.get(key)||{...config,levels:new Map()};
      const level=g.levels.get(a)||[];
      level.push({run_id:run.run_id,result}); g.levels.set(a,level); groups.set(key,g);
      const entries=appearances.get(run.run_id)||new Set();
      entries.add(JSON.stringify([key,a])); appearances.set(run.run_id,entries);
    }
    return [...groups.values()].map(g=>{
      const eligible=[...g.levels].filter(([,entries])=>{
        const ids=new Set(entries.map(e=>e.run_id));
        return ids.size>=2 && entries.every(({run_id,result})=>appearances.get(run_id).size===1 &&
          result.run_id===run_id && result.criterion_version==='motion-retention-v3' && result.pass===true);
      }).sort((a,b)=>b[0]-a[0]);
      const winner=eligible[0];
      const {levels,...config}=g;
      return {...config,criterion_version:'motion-retention-v3',max_acceleration_px_s2:winner?.[0]??null,
        run_ids:winner ? [...new Set(winner[1].map(e=>e.run_id))] : []};
    });
  }
  return {homography,iou,analyze,maxima,timelineImporter,MAX_GAP_NS,MIN_COVERAGE};
});

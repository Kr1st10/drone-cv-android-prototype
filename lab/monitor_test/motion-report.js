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
    const clock=journal.frames.length && journal.frames.every(f=>finite(f.capture_ns)) ? 'capture_ns' : 'analyzer_ns';
    const frames=journal.frames.slice().sort((a,b)=>a[clock]-b[clock]);
    if(frames.some((f,i)=>!finite(f[clock]) || f[clock]>journal.stop_ns || !Number.isInteger(f.frame_id) || (i && f[clock]<=frames[i-1][clock])) || new Set(frames.map(f=>f.frame_id)).size!==frames.length) throw Error('Некорректные времена или номера кадров.');
    const pubs=journal.publications.slice().sort((a,b)=>a.published_ns-b.published_ns);
    const frameIds=new Set(frames.map(f=>f.frame_id));
    if(pubs.some(p=>!finite(p.published_ns)||p.published_ns>journal.stop_ns||(p.frame_id!==null && !frameIds.has(p.frame_id))||!['clear','yolo','lk'].includes(p.source)||(p.source==='clear' ? p.bbox!==null : !validBox(p.bbox)))) throw Error('Некорректные публикации.');
    const matched=f=>f.marker && f.marker.run_id===run.run_id && samples.get(f.marker.step_id) || null;
    let matchedFrames=0, missing=0, other=0, reversed=false, lastStep=-Infinity;
    const anchors=[];
    for(const f of frames) {
      const s=matched(f);
      if(s) { matchedFrames++; if(s.step_id<lastStep) reversed=true; if(s.step_id>lastStep) anchors.push({s,t:f[clock]}); lastStep=s.step_id; }
      else if(f.marker) other++; else missing++;
    }
    const stepWindows=new Map();
    for(const f of frames) { const s=matched(f); if(!s) continue; const w=stepWindows.get(s.step_id); if(w) w.last=f[clock]; else stepWindows.set(s.step_id,{first:f[clock],last:f[clock]}); }
    const stalled=new Set();
    for(let i=0;i+1<ordered.length;i++) { const w=stepWindows.get(ordered[i].step_id); if(w && w.last-w.first>(ordered[i+1].elapsed_ms-ordered[i].elapsed_ms)*1e6+0.001) stalled.add(ordered[i].step_id); }
    const before=frames.some(f=>matched(f)?.phase==='blank_before');
    const after=frames.some(f=>matched(f)?.phase==='blank_after');
    // A marker identifies a reference sample's half-open display interval. Intersect
    // feasible unit-slope clock offsets; inconsistent observations remain unknown.
    const sampleIndex=new Map(ordered.map((s,i)=>[s.step_id,i]));
    const bounds=f=>{ const s=matched(f), i=s && sampleIndex.get(s.step_id); if(i==null) return null; return [i+1<ordered.length ? f[clock]-ordered[i+1].elapsed_ms*1e6 : -Infinity,f[clock]-s.elapsed_ms*1e6]; };
    let lo=-Infinity, hi=Infinity;
    for(const f of frames) { const b=bounds(f); if(b) { lo=Math.max(lo,b[0]); hi=Math.min(hi,b[1]); } }
    const alignmentInvalid=lo>hi;
    const offset=!alignmentInvalid && finite(hi) ? hi : NaN;
    let evaluated=0, good=0, bad=0, unknown=0, blank=0, falseBlank=0, falseBlankIntervals=0;
    let longest=0, longestPossible=0, loss=0, possibleLoss=0, possibleHasUnknown=false, uncertainLoss=false;
    let fi=0, pi=0, active=null;
    function record(kind,duration) {
      if(duration<=0) return;
      if(kind==='G') { good+=duration; evaluated+=duration; loss=0; possibleLoss=0; possibleHasUnknown=false; }
      else if(kind==='B') { bad+=duration; evaluated+=duration; loss+=duration; possibleLoss+=duration; }
      else { unknown+=duration; loss=0; possibleLoss+=duration; possibleHasUnknown=true; }
      longest=Math.max(longest,loss); longestPossible=Math.max(longestPossible,possibleLoss);
      if(possibleHasUnknown && possibleLoss>500e6+0.001) uncertainLoss=true;
    }
    function compatible(f) { const b=bounds(f); return b && offset>=b[0]-0.001 && offset<=b[1]+0.001 && !stalled.has(matched(f).step_id); }
    for(let k=0;k+1<ordered.length;k++) {
      const s=ordered[k], start=ordered[k].elapsed_ms*1e6, end=ordered[k+1].elapsed_ms*1e6;
      if(!moving(s) && s.visible) { loss=0; possibleLoss=0; possibleHasUnknown=false; continue; }
      let t=start;
      while(t<end-0.001) {
        if(!finite(offset)) { if(moving(s)) record('U',end-t); break; }
        const camera=t+offset;
        while(fi+1<frames.length && frames[fi+1][clock]<=camera+0.001) fi++;
        while(pi<pubs.length && pubs[pi].published_ns<=camera+0.001) active=pubs[pi++];
        const f=frames[fi], n=frames[fi+1];
        if(!f || camera<f[clock] || !n) {
          const next=f && camera<f[clock] ? Math.min(end,f[clock]-offset) : end;
          if(moving(s)) record('U',next-t); t=next; continue;
        }
        const until=Math.min(end,n[clock]-offset,pi<pubs.length?pubs[pi].published_ns-offset:end);
        if(until<=t+0.001) { t=Math.min(end,t+0.001); continue; }
        const c=matched(f), following=matched(n);
        const known=end-start<=MAX_GAP_NS && compatible(f) && compatible(n) && following.step_id>=c.step_id && n[clock]-f[clock]<=MAX_GAP_NS;
        const duration=until-t;
        if(moving(s)) {
          const ok=known && active?.bbox && iou(projected(s.bbox_screen_px,transform),active.bbox)>=0.5;
          record(!known?'U':ok?'G':'B',duration);
        } else if(known) {
          blank+=duration; if(active?.bbox) { falseBlank+=duration; falseBlankIntervals++; }
        }
        t=until;
      }
      if(!s.visible) { loss=0; possibleLoss=0; possibleHasUnknown=false; }
    }
    const first=frames.find(f=>matched(f)?.visible), frameById=new Map(frames.map(f=>[f.frame_id,f]));
    if(journal.detections.some(d=>!finite(d.published_ns)||d.published_ns>journal.stop_ns||!validBox(d.bbox)||!frameById.has(d.frame_id))) throw Error('Некорректные детекции.');
    const detections=journal.detections.slice().sort((a,b)=>a.published_ns-b.published_ns);
    const capture=detections.find(d=>{const f=frameById.get(d.frame_id), s=matched(f); return first && s?.visible && f[clock]>=first[clock] && d.published_ns>=f[clock] && iou(projected(s.bbox_screen_px,transform),d.bbox)>=0.5;});
    const coverage=expected>0 ? Math.min(1,evaluated/expected) : 0, ratio=evaluated?good/evaluated:0;
    const lower=expected?good/expected:0, upper=expected?(good+unknown)/expected:0;
    const valid=!!run.complete && !!journal.complete && !journal.truncated && expected>0 && !reversed;
    const boundaries=before && after;
    const movingSteps=new Set(frames.filter(f=>compatible(f) && moving(matched(f))).map(f=>matched(f).step_id));
    const progressed=movingSteps.size>1;
    const sufficient=valid && boundaries && coverage>=MIN_COVERAGE && !!first && progressed;
    let pass=null, decision_reason='Недостаточно данных для решения.';
    if(valid && (upper<0.9-1e-12 || longest>500e6+0.001)) { pass=false; decision_reason='Доказано нарушение критерия удержания.'; }
    else if(sufficient && lower>=0.9-1e-12 && !uncertainLoss) { pass=true; decision_reason='Оба критерия удержания подтверждены.'; }
    else if(alignmentInvalid) decision_reason='Метки несовместимы с единым смещением часов.';
    else if(!progressed) decision_reason='Недостаточно подтверждений продвижения движения.';
    else if(!boundaries) decision_reason='Нет подтверждения начальной и конечной пустых фаз.';
    else if(reversed) decision_reason='Нарушен порядок меток сценария.';
    else if(uncertainLoss) decision_reason='Неизвестный участок может скрывать длинный провал.';
    return {run_id:run.run_id,mode:run.mode,criterion_version:'motion-retention-v2',decision_reason,clock,total_frames:frames.length,matched_frames:matchedFrames,missing_markers:missing,unmatched_markers:other,marker_order_invalid:reversed,alignment_invalid:alignmentInvalid,unknown_may_hide_long_failure:uncertainLoss,coverage,expected_ms:expected/1e6,evaluated_ms:evaluated/1e6,good_ms:good/1e6,bad_ms:bad/1e6,unknown_ms:unknown/1e6,good_fraction:ratio,good_fraction_lower:lower,good_fraction_upper:upper,longest_failure_ms:longest/1e6,longest_possible_failure_ms:longestPossible/1e6,blank_evaluated_ms:blank/1e6,false_box_blank_ms:falseBlank/1e6,false_box_blank_intervals:falseBlankIntervals,capture_latency_ms:capture?(capture.published_ns-first[clock])/1e6:null,capture_frame_id:capture?.frame_id??null,sufficient,pass};
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
          result.run_id===run_id && result.criterion_version==='motion-retention-v2' && result.pass===true);
      }).sort((a,b)=>b[0]-a[0]);
      const winner=eligible[0];
      const {levels,...config}=g;
      return {...config,criterion_version:'motion-retention-v2',max_acceleration_px_s2:winner?.[0]??null,
        run_ids:winner ? [...new Set(winner[1].map(e=>e.run_id))] : []};
    });
  }
  return {homography,iou,analyze,maxima,MAX_GAP_NS,MIN_COVERAGE};
});

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
    const visible=run.samples.filter(s=>s.visible); if(!visible.length) throw Error('В эталоне нет видимой фазы.');
    const expected=Math.max(0, (run.samples.find(s=>s.phase==='blank_after')?.elapsed_ms ?? run.duration_ms)-visible[0].elapsed_ms)*1e6;
    const clock=journal.frames.length && journal.frames.every(f=>finite(f.capture_ns)) ? 'capture_ns' : 'analyzer_ns';
    const frames=journal.frames.slice().sort((a,b)=>a[clock]-b[clock]);
    if(frames.some((f,i)=>!finite(f[clock]) || f[clock]>journal.stop_ns || !Number.isInteger(f.frame_id) || (i && f[clock]<=frames[i-1][clock])) || new Set(frames.map(f=>f.frame_id)).size!==frames.length) throw Error('Некорректные времена или номера кадров.');
    const pubs=journal.publications.slice().sort((a,b)=>a.published_ns-b.published_ns);
    const frameIds=new Set(frames.map(f=>f.frame_id));
    if(pubs.some(p=>!finite(p.published_ns)||p.published_ns>journal.stop_ns||(p.frame_id!==null && !frameIds.has(p.frame_id))||!['clear','yolo','lk'].includes(p.source)||(p.source==='clear' ? p.bbox!==null : !validBox(p.bbox)))) throw Error('Некорректные публикации.');
    const matched=f=>f.marker && f.marker.run_id===run.run_id && samples.get(f.marker.step_id) || null;
    let matchedFrames=0, missing=0, other=0; for(const f of frames) { if(matched(f)) matchedFrames++; else if(f.marker) other++; else missing++; }
    let evaluated = 0, referenceCovered = 0, good = 0, falseBlank = 0, blank = 0;
    let longest = 0, loss = 0, possibleLoss = 0, hasUnknown = false;
    let uncertainLoss = false, falseBlankIntervals = 0, pi = 0, active = null, reversed = false;
    for (let i = 0; i + 1 < frames.length; i++) {
      const frame = frames[i], start = frame[clock], end = frames[i + 1][clock];
      const current = matched(frame), following = matched(frames[i + 1]), gap = end - start;
      if (current && following && following.step_id < current.step_id) reversed = true;
      if (!current || !following || gap > MAX_GAP_NS || following.step_id < current.step_id) {
        loss = 0;
        possibleLoss += gap;
        hasUnknown = true;
        if (possibleLoss > 500e6) uncertainLoss = true;
        continue;
      }
      if (current.visible) {
        referenceCovered += Math.min(gap, Math.max(0, (following.elapsed_ms - current.elapsed_ms) * 1e6));
      }
      while (pi < pubs.length && pubs[pi].published_ns <= start) active = pubs[pi++];
      let time = start;
      while (time < end) {
        const next = Math.min(end, pi < pubs.length ? pubs[pi].published_ns : end);
        const duration = next - time;
        if (current.visible) {
          const ok = active?.bbox && iou(projected(current.bbox_screen_px, transform), active.bbox) >= 0.5;
          evaluated += duration;
          if (ok) {
            good += duration;
            loss = 0;
            possibleLoss = 0;
            hasUnknown = false;
          } else {
            loss += duration;
            possibleLoss += duration;
            if (hasUnknown && possibleLoss > 500e6) uncertainLoss = true;
            longest = Math.max(longest, loss);
          }
        } else {
          blank += duration;
          if (active?.bbox) {
            falseBlank += duration;
            falseBlankIntervals++;
          }
          loss = 0;
          possibleLoss = 0;
          hasUnknown = false;
        }
        time = next;
        if (pi < pubs.length && pubs[pi].published_ns <= time) active = pubs[pi++];
      }
    }
    const first=frames.find(f=>matched(f)?.visible), frameById=new Map(frames.map(f=>[f.frame_id,f]));
    if(journal.detections.some(d=>!finite(d.published_ns)||d.published_ns>journal.stop_ns||!validBox(d.bbox)||!frameById.has(d.frame_id))) throw Error('Некорректные детекции.');
    const detections=journal.detections.slice().sort((a,b)=>a.published_ns-b.published_ns);
    const capture=detections.find(d=>{const f=frameById.get(d.frame_id), s=matched(f); return first && s?.visible && f[clock]>=first[clock] && d.published_ns>=f[clock] && iou(projected(s.bbox_screen_px,transform),d.bbox)>=0.5;});
    const coverage=expected>0 ? Math.min(1,evaluated/expected,referenceCovered/expected) : 0, ratio=evaluated?good/evaluated:0;
    const sufficient=!!run.complete && !!journal.complete && !journal.truncated && coverage>=MIN_COVERAGE && evaluated>0 && !!first && !reversed && !uncertainLoss;
    return {run_id:run.run_id,mode:run.mode,clock,total_frames:frames.length,matched_frames:matchedFrames,missing_markers:missing,unmatched_markers:other,marker_order_invalid:reversed,unknown_may_hide_long_failure:uncertainLoss,coverage,expected_ms:expected/1e6,evaluated_ms:evaluated/1e6,good_fraction:ratio,longest_failure_ms:longest/1e6,blank_evaluated_ms:blank/1e6,false_box_blank_ms:falseBlank/1e6,false_box_blank_intervals:falseBlankIntervals,capture_latency_ms:capture?(capture.published_ns-first[clock])/1e6:null,capture_frame_id:capture?.frame_id??null,sufficient,pass:sufficient ? ratio>=0.9 && longest<=500e6 && !!capture : null};
  }
  function maxima(items) {
    const groups=new Map();
    const seen=new Set();
    for(const {run,result} of items) { if(seen.has(run.run_id)) continue; seen.add(run.run_id); const c=run.conditions, s=run.scenario; const key=JSON.stringify([run.mode,s.target_width_px,run.photo,c,s.width,s.height,s.max_speed_px_s,s.laps]); const g=groups.get(key)||{mode:run.mode,size_px:s.target_width_px,conditions:c,levels:new Map()}; const a=s.acceleration_px_s2, level=g.levels.get(a)||[]; level.push(result); g.levels.set(a,level); groups.set(key,g); }
    return [...groups.values()].map(g=>({mode:g.mode,size_px:g.size_px,conditions:g.conditions,max_acceleration_px_s2:Math.max(0,...[...g.levels].filter(([,r])=>r.length>=2 && r.every(x=>x.pass===true)).map(([a])=>a))||null}));
  }
  return {homography,iou,analyze,maxima,MAX_GAP_NS,MIN_COVERAGE};
});

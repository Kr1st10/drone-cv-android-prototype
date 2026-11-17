(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motion-report.js'),require('./motion-timeline.js'));
  else root.MotionReportV4 = factory(root.MotionReport,root.MotionTimeline);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (legacy,Timeline) {
  'use strict';
  const moving = s => ['accelerate', 'cruise', 'brake', 'turn'].includes(s.phase);
  const unavailable = reason => ({ status: 'unavailable', lower_ms: null, upper_ms: null, reason });
  function analyze(run, journal, points) {
    if (!['dronecv-motion-run-2','dronecv-motion-run-3'].includes(run?.schema) || run.scenario?.version !== 'simple-motion-v1') throw Error('Неподдерживаемая версия простого сценария: '+run?.schema);
    const independent=run.schema==='dronecv-motion-run-3';
    const trajectory=independent?Timeline.ordered(run):run.samples;
    const intervals=independent?run.sync_intervals:null;
    // Keep the legacy denominator adapter; independent code intervals only
    // replace clock constraints, never trajectory coordinates.
    const adapt = predicate => ({ ...run, schema: 'dronecv-motion-run-1', samples: trajectory.map(s => ({ ...s,
      phase: s.phase === 'calibration' ? 'blank_before' : s.visible ? predicate(s) ? 'cruise' : 'turn' : s.phase })) });
    const visible = legacy.analyze(adapt(() => true), journal, points, intervals);
    const subset = predicate => {
      const r = legacy.analyze(adapt(predicate), journal, points, intervals);
      return { expected_ms: r.expected_ms, good_ms: r.good_ms, bad_ms: r.bad_ms, unknown_ms: r.unknown_ms,
        coverage: r.coverage, good_fraction_lower: r.expected_ms ? r.good_fraction_lower : null,
        good_fraction_upper: r.expected_ms ? r.good_fraction_upper : null };
    };
    const stationary = subset(s => s.phase === 'stationary'), movement = subset(moving);
    const ordered = trajectory.slice().sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    const frames = journal.frames.filter(f => Number.isFinite(f.capture_ns)).sort((a,b) => a.capture_ns-b.capture_ns);
    const frameById = new Map(journal.frames.map(f => [f.frame_id,f]));
    const samples = new Map((independent?intervals:ordered).map(s => [s.step_id,s]));
    const pubs = journal.publications.slice().sort((a,b) => a.published_ns-b.published_ns);
    const project = legacy.homography(run.calibration_points, points);
    const polygon = box => [[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]].map(project);
    const lo = visible.offset_lower_ms, hi = visible.offset_upper_ms;
    const timed = visible.timing_status === 'compatible' && !visible.marker_order_invalid;
    const full = journal.complete && !journal.truncated && run.complete;
    const firstVisible = ordered.find(s => s.visible)?.elapsed_ms;
    const hiddenIndex = ordered.findIndex((s,i) => i > 0 && ordered[i-1].visible && s.phase === 'disappearance');
    const hide = hiddenIndex < 0 ? null : ordered[hiddenIndex].elapsed_ms;
    const returned = hiddenIndex < 0 ? null : ordered.slice(hiddenIndex+1).find(s => s.visible)?.elapsed_ms ?? null;
    const finalHidden = ordered.find(s => s.phase === 'blank_after')?.elapsed_ms ?? run.duration_ms;
    const runEnd=independent?(run.end_ms??ordered.at(-1)?.elapsed_ms):run.duration_ms;
    const endObserved = timed && frames.length ? Math.min(runEnd, frames.at(-1).capture_ns/1e6-hi) : null;
    const matched = f => f?.marker?.run_id === run.run_id ? samples.get(f.marker.step_id) : null;
    function sampleAt(time) {
      let l=0, r=ordered.length;
      while(l<r) { const m=(l+r)>>>1; if(ordered[m].elapsed_ms<=time) l=m+1; else r=m; }
      return Math.max(0,l-1);
    }
    function candidates(a,b){
      const possible=[];
      for(let i=sampleAt(a);i+1<ordered.length&&ordered[i].elapsed_ms<b;i++){
        if(ordered[i+1].elapsed_ms>a)possible.push(ordered[i]);
      }
      return possible;
    }
    function exposure(p){
      const f=frameById.get(p.frame_id);
      if(!timed||!matched(f)||!Number.isFinite(f?.capture_ns))return null;
      const a=f.capture_ns/1e6-hi,b=f.capture_ns/1e6-lo;
      const possible=candidates(a,b);
      if(a<ordered[0].elapsed_ms||b>runEnd)return {a,b,possible,covered:false};
      return {a,b,possible,covered:possible.length>0&&possible.every(s=>{
        const i=s.step_id;return ordered[i+1].elapsed_ms-s.elapsed_ms<=250;
      })};
    }
    const freshFrame = (p, start, definite) => {
      const f = frameById.get(p.frame_id), s = matched(f);
      if(independent){
        const e=exposure(p);
        if(!e||p.published_ns<f.capture_ns||p.state_known===false||p.initial_snapshot||!p.bbox)return false;
        // Missing trajectory coverage permits, but never proves, a fresh box.
        // The exposure interval [a,b) must still reach into this episode.
        if(!e.covered)return !definite&&e.b>start;
        const good=s=>s.visible&&s.elapsed_ms>=start&&legacy.iou(polygon(s.bbox_screen_px),p.bbox)>=.5;
        return definite?e.a>=start&&e.possible.every(good):e.b>=start&&e.possible.some(good);
      }
      return !!s?.visible && Number.isFinite(f.capture_ns) && p.published_ns >= f.capture_ns &&
        f.capture_ns/1e6 - (definite ? hi : lo) >= start && p.state_known !== false && !p.initial_snapshot &&
        !!p.bbox && legacy.iou(polygon(s.bbox_screen_px), p.bbox) >= .5;
    };
    function correctAtPublication(p, start, definite) {
      if (!freshFrame(p,start,definite)) return false;
      const a = p.published_ns/1e6-hi, b = p.published_ns/1e6-lo;
      const possible = [];
      for(let i=sampleAt(a); i+1<ordered.length && ordered[i].elapsed_ms<=b; i++) {
        if(ordered[i+1].elapsed_ms>a) possible.push(ordered[i]);
      }
      const good = s => s.visible && s.elapsed_ms >= start && legacy.iou(polygon(s.bbox_screen_px),p.bbox) >= .5;
      return definite ? possible.length > 0 && possible.every(good) && a >= start : possible.some(good) && b >= start;
    }
    function eventBounds(candidates, start, limit, kind) {
      if (!timed) return unavailable('Недостаточная или несовместимая синхронизация.');
      if (!full) return unavailable('Неполная запись или незавершённый эталон.');
      if (endObserved <= start) return unavailable('Запись не охватывает начало оцениваемой фазы.');
      if(kind === 'capture') {
        const a=(start+lo)*1e6,b=(start+hi)*1e6;
        // Imported clocks are relative to header.start_ns. A historical
        // initial_snapshot cannot extend recorded state coverage before zero.
        const recordedFrom=journal.source_schema==='dronecv-session-timeline-1'?0:-Infinity;
        const prior=pubs.filter(p=>p.published_ns<=a).at(-1);
        const during=pubs.filter(p=>p.published_ns>a&&p.published_ns<=b);
        if(!frames.length||Math.max(recordedFrom,frames[0].capture_ns)>a||!prior||
          [prior,...during].some(p=>p.state_known===false)) {
          return unavailable('Запись состояния не охватывает начало видимой фазы для всех смещений часов; более ранний захват не исключён.');
        }
      }
      const mayBeInPhase = p => p.published_ns/1e6-lo >= start && p.published_ns/1e6-hi < limit;
      const potential = candidates.filter(mayBeInPhase);
      const possible = kind === 'clear' ? potential : potential.filter(p => correctAtPublication(p,start,false));
      const certain = kind === 'clear' ? potential.filter(p => p.published_ns/1e6-hi >= start && p.published_ns/1e6-lo < limit) : potential.filter(p => correctAtPublication(p,start,true));
      let lower = possible.length ? Math.max(0,possible[0].published_ns/1e6-hi-start) : Math.max(0,Math.min(limit,endObserved)-start);
      // A box with unknown source exposure may have been an earlier fresh
      // acquisition. It cannot prove an event, or a later lower bound.
      if(kind !== 'clear') for(const p of potential) {
        const f=frameById.get(p.frame_id);
        if(p.state_known===false || p.bbox && (!matched(f) || !Number.isFinite(f?.capture_ns))) {
          lower=Math.min(lower,Math.max(0,p.published_ns/1e6-hi-start));
        }
      }
      // Unknown coordinate state may conceal an earlier removal, regardless
      // of the serialized box value. Only a later known clear proves an upper
      // bound; the unknown publication itself never proves absence.
      if(kind === 'clear') for(const p of pubs) {
        if(p.state_known === false && mayBeInPhase(p)) lower=Math.min(lower,Math.max(0,p.published_ns/1e6-hi-start));
      }
      const upper = certain.length ? Math.max(0,certain[0].published_ns/1e6-lo-start) : null;
      return { status: upper === null ? 'right_censored' : 'bounded', lower_ms: lower, upper_ms: upper,
        reason: upper === null ? 'Событие не подтверждено до конца доступного интервала наблюдения.' : 'Границы учитывают все совместимые смещения часов; это публикация координат, не показ рамки дисплеем.' };
    }
    const capture = firstVisible === undefined ? unavailable('Нет видимой цели.') : eventBounds(pubs,firstVisible,hide ?? run.duration_ms,'capture');
    const missingReturn = () => unavailable('Повторное появление не было зафиксировано в фактических шагах эталона.');
    let cleanup = unavailable('Нет эпизода исчезновения.'), reacquisition = missingReturn();
    if (hide !== null && timed && full) {
      // All possible disappearance instants must have a known existing box.
      const a = (hide+lo)*1e6, b = (hide+hi)*1e6;
      const prior = pubs.filter(p => p.published_ns <= a).at(-1);
      const during = pubs.filter(p => p.published_ns > a && p.published_ns <= b);
      const state = [prior,...during];
      const inCoverage = frames.length && frames[0].capture_ns <= a && frames.at(-1).capture_ns >= b;
      const existed = inCoverage && state.every(p => p && p.bbox && p.state_known !== false);
      const absent = inCoverage && state.every(p => p && !p.bbox && p.state_known !== false);
      const clears = pubs.filter(p => p.source === 'clear' && p.bbox === null && p.state_known !== false &&
        p.published_ns/1e6-hi >= hide);
      cleanup = existed ? eventBounds(clears,hide,finalHidden,'clear') :
        absent ? { status:'not_applicable',lower_ms:null,upper_ms:null,reason:'До исчезновения координат не было; очистка не измеряется.' } :
          unavailable('Наличие рамки перед исчезновением не подтверждено для всех смещений часов.');
      if (returned !== null) {
        // A clear publication remains the known coordinate state until the
        // next publication. Choose a witness inside that interval after even
        // the latest possible disappearance, for every compatible offset.
        let absenceWitness = null;
        for(let i=0;i<pubs.length;i++) {
          const p=pubs[i];
          if(p.bbox !== null || p.state_known === false) continue;
          const end=i+1<pubs.length ? pubs[i+1].published_ns : journal.stop_ns;
          const witness=Math.max(p.published_ns,b);
          if(witness<end && witness<(finalHidden+lo)*1e6) {absenceWitness=witness;break;}
        }
        reacquisition = absenceWitness !== null ? eventBounds(pubs.filter(p => p.published_ns > absenceWitness),returned,finalHidden,'correct') :
          { status:'no_confirmed_absence',lower_ms:null,upper_ms:null,reason:'Отсутствие координат после исчезновения не подтверждено; сохранившаяся рамка не является повторным захватом.' };
      }
    } else if (hide !== null) {
      cleanup = unavailable(!timed ? 'Недостаточная или несовместимая синхронизация.' : 'Неполная запись или незавершённый эталон.');
      reacquisition = full && returned === null ? missingReturn() : { ...cleanup };
    }
    const result = { ...visible, criterion_version:independent?'motion-scenario-v5':'motion-scenario-v4', denominator:'all_visible_time_including_stationary_and_turns',
      stationary, movement, capture, cleanup, reacquisition };
    if(independent){
      result.sync_period_ms=run.sync_period_ms;
      result.frame_evaluations=pubs.filter(p=>p.source!=='clear').map(p=>{
        const e=exposure(p),valid=e?.covered&&!journal.truncated&&!visible.marker_order_invalid&&p.state_known!==false&&p.published_ns>=frameById.get(p.frame_id).capture_ns;
        const values=valid?e.possible.map(s=>s.visible?legacy.iou(polygon(s.bbox_screen_px),p.bbox):0):[];
        const lower=values.length?Math.min(...values):0,upper=values.length?Math.max(...values):1;
        return {frame_id:p.frame_id,published_ns:p.published_ns,capture_elapsed_lower_ms:e?.a??null,capture_elapsed_upper_ms:e?.b??null,
          sample_ids:e?.possible.map(s=>s.sample_id)??[],iou_lower:lower,iou_upper:upper,
          status:!values.length?'unknown':lower>=.5?'good':upper<.5?'bad':'unknown'};
      });
    }
    result.center_error={...visible.center_error,domain:'all_visible_time_including_stationary_and_turns'};
    // v3 acceptance thresholds belong to their historical movement denominator.
    delete result.pass; delete result.sufficient; delete result.capture_latency_ms; delete result.capture_frame_id;
    result.decision_reason = 'Временные границы сценария '+(independent?'v5':'v4')+'; критерий приёмки motion-retention-v3 к этому знаменателю не применяется.';
    return result;
  }
  return { analyze };
});

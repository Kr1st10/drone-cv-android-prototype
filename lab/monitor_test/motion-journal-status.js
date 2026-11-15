(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.MotionJournalStatus=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const finite=Number.isFinite;
  function framesOf(journal){
    if(journal?.schema!=='dronecv-motion-android-1'||!Array.isArray(journal.frames))throw Error('Неподдерживаемый журнал Android.');
    return journal.frames;
  }
  function completeness(journal){
    const truncated=journal.truncated===true;
    const experiment_complete=journal.complete===true;
    const recording_complete=typeof journal.recording_complete==='boolean'?journal.recording_complete:experiment_complete&&!truncated;
    const reasons=[];
    if(truncated)reasons.push('Журнал усечён или содержит пропуски.');
    else if(!recording_complete)reasons.push('Запись журнала неполная.');
    if(!experiment_complete)reasons.push('Опыт прерван или не завершён.');
    return {recording_complete,experiment_complete,truncated,completeness_reason:reasons.join(' ')||null};
  }
  function codeReadability(journal){
    const frames=framesOf(journal),read=frames.filter(f=>f.marker!=null);
    return {total_frames:frames.length,read_frames:read.length,missing_markers:frames.length-read.length,
      run_ids:[...new Set(read.map(f=>f.marker.run_id).filter(id=>typeof id==='string'))].sort(),...completeness(journal)};
  }
  function timing(run,journal){
    const allFrames=framesOf(journal);
    if(!['dronecv-motion-run-1','dronecv-motion-run-2'].includes(run?.schema)||!Array.isArray(run.samples))throw Error('Неподдерживаемый эталон движения.');
    const samples=new Map();
    for(const s of run.samples){
      if(s.run_id!==run.run_id||!Number.isInteger(s.step_id)||samples.has(s.step_id)||!finite(s.elapsed_ms))throw Error('Некорректный run_id или повтор step_id эталона.');
      samples.set(s.step_id,s);
    }
    const ordered=run.samples.slice().sort((a,b)=>a.elapsed_ms-b.elapsed_ms);
    if(ordered.some((s,i)=>i&&(s.elapsed_ms<=ordered[i-1].elapsed_ms||s.step_id<=ordered[i-1].step_id)))throw Error('Некорректный порядок эталона.');
    if(!finite(journal.stop_ns)||journal.stop_ns<0)throw Error('Некорректное время остановки журнала.');
    if(allFrames.some(f=>!Number.isInteger(f.frame_id)||(finite(f.capture_ns)&&f.capture_ns>journal.stop_ns)||(finite(f.analyzer_ns)&&f.analyzer_ns>journal.stop_ns))||new Set(allFrames.map(f=>f.frame_id)).size!==allFrames.length)throw Error('Некорректные времена или номера кадров.');
    const frames=allFrames.filter(f=>finite(f.capture_ns)).sort((a,b)=>a.capture_ns-b.capture_ns);
    if(frames.some((f,i)=>i&&(f.capture_ns<=frames[i-1].capture_ns||f.frame_id<=frames[i-1].frame_id)))throw Error('Некорректные времена или номера кадров.');
    const matched=f=>f.marker?.run_id===run.run_id?samples.get(f.marker.step_id):null;
    let matched_frames=0,unknown_step_frames=0,foreign_run_frames=0,missing_markers=0;
    for(const f of allFrames){
      if(f.marker==null)missing_markers++;
      else if(f.marker.run_id!==run.run_id)foreign_run_frames++;
      else if(!samples.has(f.marker.step_id))unknown_step_frames++;
      else matched_frames++;
    }
    let order_violations=0,last=-Infinity;
    const windows=new Map(),sampleIndex=new Map(ordered.map((s,i)=>[s.step_id,i]));
    let lo=-Infinity,hi=Infinity,matched_timed_frames=0;
    for(const f of frames){
      const s=matched(f);if(!s)continue;
      matched_timed_frames++;
      if(s.step_id<last)order_violations++;
      last=s.step_id;
      const window=windows.get(s.step_id);
      if(window)window.last=f.capture_ns;else windows.set(s.step_id,{first:f.capture_ns,last:f.capture_ns});
      const i=sampleIndex.get(s.step_id);
      // A read code constrains one common camera-minus-browser offset over
      // the actual displayed step. The last step has no finite lower bound.
      lo=Math.max(lo,i+1<ordered.length?f.capture_ns-ordered[i+1].elapsed_ms*1e6:-Infinity);
      hi=Math.min(hi,f.capture_ns-s.elapsed_ms*1e6);
    }
    const stalled_step_ids=[];
    for(let i=0;i+1<ordered.length;i++){
      const w=windows.get(ordered[i].step_id);
      if(w&&w.last-w.first>(ordered[i+1].elapsed_ms-ordered[i].elapsed_ms)*1e6+.001)stalled_step_ids.push(ordered[i].step_id);
    }
    const timing_status=lo>=hi?'incompatible':finite(lo)&&finite(hi)?'compatible':'insufficient_capture';
    const reason=timing_status==='incompatible'?'Метки несовместимы с единым постоянным смещением часов.':
      timing_status==='insufficient_capture'?'Недостаточно сопоставленных меток экспозиции для ограниченного интервала смещения.':
        order_violations?'Интервал смещения найден, но порядок кодов сценария нарушен.':'Найден совместимый интервал общего смещения; читаемость кода не подтверждает пространственную калибровку.';
    const details=completeness(journal),reference_complete=run.complete===true;
    const completeness_reason=[details.completeness_reason,!reference_complete?'Эталон не завершён.':null].filter(Boolean).join(' ')||null;
    return {matched_frames,unknown_step_frames,foreign_run_frames,missing_markers,matched_timed_frames,
      untimed_frames:allFrames.length-frames.length,marker_order_invalid:order_violations>0,order_violations,stalled_step_ids,
      offset_lower_ms:finite(lo)?lo/1e6:null,offset_upper_ms:finite(hi)?hi/1e6:null,
      offset_uncertainty_ms:timing_status==='compatible'?(hi-lo)/1e6:null,timing_status,reason,
      ...details,reference_complete,completeness_reason};
  }
  return {codeReadability,timing};
});

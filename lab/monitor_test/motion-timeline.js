(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.MotionTimeline=factory();
})(globalThis,function(){
  'use strict';
  const DEFAULT_PERIOD_MS=100;
  // Commit only after drawing succeeds. A late RAF advances once, at its actual time.
  function nextCode(intervals,elapsed,period=DEFAULT_PERIOD_MS){
    if(!Number.isFinite(period)||period<=0)throw Error('Период sync-кода должен быть положительным.');
    const last=intervals.at(-1);
    return !last ? 0 : elapsed-last.start_ms>=period ? last.step_id+1 : last.step_id;
  }
  function commit(intervals,step_id,elapsed){
    const last=intervals.at(-1);
    if(last?.step_id===step_id)return;
    if(last)last.end_ms=elapsed;
    intervals.push({step_id,start_ms:elapsed,end_ms:null});
  }
  function close(run,elapsed){
    run.end_ms=elapsed;
    const last=run.sync_intervals.at(-1);
    if(last)last.end_ms=elapsed;
  }
  function validate(run){
    if(run?.schema!=='dronecv-motion-run-3')throw Error('Неподдерживаемая версия эталона: '+run?.schema);
    const finite=Number.isFinite,intervals=run.sync_intervals,samples=run.samples;
    if(!finite(run.sync_period_ms)||run.sync_period_ms<=0||!Array.isArray(intervals)||!Array.isArray(samples)||
      !(run.end_ms===null&&!run.complete||finite(run.end_ms)&&run.end_ms>=0))throw Error('Некорректные интервалы или граница эталона v3.');
    if(intervals.length===0&&samples.length===0)return;
    if(!intervals.length||!samples.length||intervals[0].start_ms!==0||samples[0].elapsed_ms!==0)throw Error('Нет первого обновления эталона v3.');
    for(let i=0;i<intervals.length;i++){
      const s=intervals[i],next=intervals[i+1];
      if(s.step_id!==i||!finite(s.start_ms)||!(finite(s.end_ms)||!next&&s.end_ms===null&&run.end_ms===null)||finite(s.end_ms)&&s.end_ms<s.start_ms||
        (next?s.end_ms!==next.start_ms||s.end_ms-s.start_ms<run.sync_period_ms:s.end_ms!==run.end_ms))throw Error('Некорректный интервал sync-кода v3.');
    }
    for(let i=0;i<samples.length;i++){
      const s=samples[i];
      if(s.run_id!==run.run_id||s.sample_id!==i||'step_id' in s||!finite(s.elapsed_ms)||s.elapsed_ms<0||finite(run.end_ms)&&s.elapsed_ms>run.end_ms||
        i&&s.elapsed_ms<=samples[i-1].elapsed_ms)throw Error('Некорректная траектория v3.');
    }
    const times=new Set(samples.map(s=>s.elapsed_ms));
    if(intervals.some(s=>!times.has(s.start_ms)))throw Error('Смена sync-кода без обновления canvas.');
  }
  function ordered(run){
    validate(run);
    const samples=run.samples.map(s=>({...s,step_id:s.sample_id}));
    // This is a removal boundary, never a synthesized display or trajectory update.
    if(samples.length&&run.end_ms>samples.at(-1).elapsed_ms)samples.push({...samples.at(-1),step_id:samples.length,elapsed_ms:run.end_ms});
    return samples;
  }
  return {DEFAULT_PERIOD_MS,nextCode,commit,close,validate,ordered};
});

(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SyncCheck=factory();})(globalThis,function(){
  'use strict';
  /** Compare a separate browser reading check with the existing Android import.
   * Clock bounds use capture timestamps only and actual displayed intervals.
   * Frames crossing a phase boundary for any allowed offset remain unknown.
   */
  function analyze(run,journal){
    if(run?.schema!=null&&run.schema!=='dronecv-sync-check-1')throw Error('Неподдерживаемая версия проверки чтения: '+run.schema);
    const frames=journal.frames,steps=run?.steps||[],expected=new Set(steps.map(s=>s.step_id));
    const read=frames.filter(f=>f.marker!=null),matched=read.filter(f=>f.marker.run_id===run?.run_id&&expected.has(f.marker.step_id));
    const foreign=read.filter(f=>f.marker.run_id!==run?.run_id),unknown=read.filter(f=>f.marker.run_id===run?.run_id&&!expected.has(f.marker.step_id));
    const seen=new Set(matched.map(f=>f.marker.step_id));
    let lo=-Infinity,hi=Infinity,last=-1,order=false;
    const usable=matched.filter(f=>Number.isFinite(f.capture_ns)).sort((a,b)=>a.capture_ns-b.capture_ns);
    for(const f of usable){
      const i=steps.findIndex(s=>s.step_id===f.marker.step_id),s=steps[i],end=steps[i+1]?.elapsed_ms??run.end_ms;
      if(s.step_id<last)order=true;last=s.step_id;
      if(Number.isFinite(end))lo=Math.max(lo,f.capture_ns/1e6-end);
      hi=Math.min(hi,f.capture_ns/1e6-s.elapsed_ms);
    }
    const clocks=frames.filter(f=>Number.isFinite(f.capture_ns)).sort((a,b)=>a.capture_ns-b.capture_ns);
    const invalidClock=clocks.some((f,i)=>i&&(f.capture_ns<=clocks[i-1].capture_ns||f.frame_id<=clocks[i-1].frame_id))||new Set(frames.map(f=>f.frame_id)).size!==frames.length;
    const timing=order||invalidClock||lo>=hi?'incompatible':Number.isFinite(lo)&&Number.isFinite(hi)?'compatible':'insufficient';
    const phase=name=>{
      if(timing!=='compatible')return null;
      const start=name==='static'?steps[0]?.elapsed_ms:steps.find(s=>s.step_id===1)?.elapsed_ms;
      const end=name==='static'?steps.find(s=>s.step_id===1)?.elapsed_ms:run.end_ms;
      if(!Number.isFinite(start)||!Number.isFinite(end))return null;
      const certain=clocks.filter(f=>f.capture_ns/1e6-hi>=start&&f.capture_ns/1e6-lo<=end);
      return certain.length?{frames:certain.length,read:certain.filter(f=>f.marker?.run_id===run.run_id&&expected.has(f.marker.step_id)).length}:null;
    };
    return {total:frames.length,read:read.length,fraction:frames.length?read.length/frames.length:null,matched:matched.length,foreign:foreign.length,unknown:unknown.length,
      run_ids:[...new Set(read.map(f=>f.marker.run_id))],seen:[...seen],missing:[...expected].filter(id=>!seen.has(id)),
      timing,offset_lower_ms:Number.isFinite(lo)?lo:null,offset_upper_ms:Number.isFinite(hi)?hi:null,static:phase('static'),switching:phase('switching')};
  }
  return {analyze};
});

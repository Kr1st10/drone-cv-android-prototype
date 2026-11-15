(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./motion.js'));else root.MotionScenario=factory(root.Motion);})(globalThis,function(Motion){
  'use strict';
  function layout(input) {
    const c=structuredClone(input), w=c.width,h=c.height;
    const a=c.workspace;
    if(!a||![a.x,a.y,a.width,a.height,c.calibration_size_px,c.sync_module_px].every(Number.isFinite)||a.x<0||a.y<0||a.width<=0||a.height<=0||a.x+a.width>w||a.y+a.height>h)throw Error('Рабочая область должна помещаться в canvas.');
    const size=c.calibration_size_px,m=c.sync_module_px,gap=16;
    if(size<24||!Number.isInteger(size)||m<2||!Number.isInteger(m))throw Error('Стороны меток должны быть целыми: угловая метка от 24 px, ячейка sync-кода от 2 px canvas.');
    const markers=[[a.x+gap,a.y+gap],[a.x+a.width-gap-size,a.y+gap],[a.x+a.width-gap-size,a.y+a.height-gap-size],[a.x+gap,a.y+a.height-gap-size]].map(([x,y],id)=>({id,x,y,size}));
    const sync={x:a.x+a.width/2-5*m,y:a.y+gap+2*m,module_px:m};
    const sync_backing=[sync.x-2*m,sync.y-2*m,14*m,12*m];
    if(sync_backing[0]<markers[0].x+size+gap||sync_backing[0]+sync_backing[2]>markers[1].x-gap)throw Error('Метки и sync-код не помещаются по ширине. Увеличьте рабочую область или уменьшите метки.');
    const controlWidth=c.control_width_px||80,controlHeight=c.control_height_px||32,bottomBand=Math.max(size,controlHeight);
    if(controlWidth>a.width-2*size-4*gap)throw Error('Кнопка остановки не помещается между метками.');
    const control_rect=[a.x+a.width/2-controlWidth/2,a.y+a.height-gap-bottomBand+(bottomBand-controlHeight)/2,controlWidth,controlHeight];
    if(a.height < Math.max(size,12*m)+bottomBand+3*gap)throw Error('Метки, sync-код и кнопка остановки не помещаются по высоте. Увеличьте рабочую область.');
    return {marker:sync,sync_backing,control_rect,calibration_markers:markers,calibration_points:markers.map(t=>[t.x+t.size/2,t.y+t.size/2])};
  }
  function plan(input) {
    const geometry=layout(input),c=structuredClone(input),a=c.workspace,size=c.calibration_size_px,m=c.sync_module_px,gap=16;
    const offset=[a.x+size+2*gap,a.y+Math.max(size,12*m)+2*gap];
    const bottomBand=Math.max(size,c.control_height_px||32);
    let base;try{base=Motion.planMotion({...c,width:a.width-2*size-4*gap,height:a.height-Math.max(size,12*m)-bottomBand-4*gap});}catch(e){throw Error('Маршрут не помещается в оставшейся области после размещения меток и sync-кода. Увеличьте рабочую область или измените параметры движения. '+e.message);}
    const movement_ms=Math.max(7000,base.lap_ms*c.laps);
    c.version='simple-motion-v1';c.calibration_ms=2000;c.stationary_ms=1500;c.movement_ms=movement_ms;c.disappearance_ms=1000;
    c.disappearance_start_ms=c.calibration_ms+c.stationary_ms+movement_ms*.35;c.hidden_motion='continue';c.final_blank_ms=1500;
    c.route_time_scale=base.lap_ms*c.laps/movement_ms;
    const duration_ms=c.calibration_ms+c.stationary_ms+movement_ms+c.final_blank_ms;
    if(duration_ms>120000)throw Error('Сценарий превышает 120 секунд.');
    return {config:c,base,offset,...geometry,duration_ms};
  }
  function sample(p,elapsed,step,run) {
    const c=p.config,start=c.calibration_ms+c.stationary_ms,end=start+c.movement_ms;
    const local=Math.max(0,elapsed-start), motionEnd=p.base.lap_ms*c.laps;
    // Extend the final stationary observation when the requested route is short.
    const t=Math.min(local*motionEnd/c.movement_ms,Math.max(0,motionEnd-.001));
    const s=Motion.sampleMotion(p.base,1000+t,step,run);
    for(const key of ['bbox_screen_px','image_rect_px'])if(s[key])s[key]=s[key].map((v,i)=>v+p.offset[i%2]);
    s.elapsed_ms=elapsed;
    if(elapsed<c.calibration_ms)s.phase='calibration';
    else if(elapsed<start)s.phase='stationary';
    const rate=motionEnd/c.movement_ms;
    s.velocity_px_s=s.velocity_px_s.map(v=>v*rate);s.acceleration_px_s2=s.acceleration_px_s2.map(v=>v*rate*rate);
    if(elapsed<c.calibration_ms||elapsed>=end||elapsed>=c.disappearance_start_ms&&elapsed<c.disappearance_start_ms+c.disappearance_ms){
      s.phase=elapsed<c.calibration_ms?'calibration':elapsed>=end?'blank_after':'disappearance';s.visible=false;s.bbox_screen_px=null;s.image_rect_px=null;
    }
    if(s.phase==='stationary'){s.velocity_px_s=[0,0];s.acceleration_px_s2=[0,0];}
    return s;
  }
  return {layout,plan,sample};
});

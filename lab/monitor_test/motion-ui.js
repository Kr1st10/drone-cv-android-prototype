(function () {
  'use strict';
  const $ = id => document.getElementById(id), stage = $('motionStage'), canvas = $('motionCanvas'), ctx = canvas.getContext('2d');
  const parameters = ['motionWidth', 'motionSpeed', 'motionAcceleration', 'motionLaps','motionAreaX','motionAreaY','motionAreaWidth','motionAreaHeight','motionTagSize','motionSyncSize'];
  const inputs = ['motionPhoto', ...parameters, 'motionSetup', 'motionZoom', 'motionOrientation', 'motionCamera', 'motionDistance'];
  const maxRuns = 20, maxSamples = 40000, maxSeriesSamples = 120000;
  const saved = MotionGallery.load('motion_settings', {});
  let selectedId = typeof saved?.photo_id === 'string' ? saved.photo_id : null;
  parameters.forEach(key => { if (typeof saved?.[key] === 'string') $(key).value = saved[key]; });
  let runs = [], lastLocalRun = null, lastScenario = null, active = null, attempt = null, finishing = false, refreshVersion = 0;
  let seriesId = id(), ready=false, saveFailure=null;
  function id() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0].toString(16).padStart(8, '0'); }
  function freshRunId() { let x; do { x = id(); } while (runs.some(r => r.run_id === x) || SyncCheckUI.hasId(x)); return x; }
  function sampleCount() { return runs.reduce((n, r) => n + r.samples.length, 0); }
  function status(message) { $('motionStatus').textContent = message; }
  function rememberLocalRun(run){runs.push(run);lastLocalRun=run;$('motionHistoryStatus').textContent='Последний локальный запуск: '+run.run_id;}
  function persist() {
    if(!MotionGallery.save('motion_settings', { photo_id: selectedId, ...Object.fromEntries(parameters.map(key => [key, $(key).value])) })) status('Не удалось сохранить настройки. Освободите место и повторите.');
    const m=Number($('motionSyncSize').value);$('syncSizeStatus').textContent=Number.isInteger(m)&&m>=2?`Код с белым полем: ${12*m} × ${10*m} px canvas; чёрная подложка: ${14*m} × ${12*m} px canvas. Читаемость камерой ещё не подтверждена. Размер в кадре камеры отличается.`:'Введите целую сторону ячейки не меньше 2 px canvas.';
    const p=$('motionAreaPreview'),c=p.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,p.width,p.height);c.strokeStyle='#111';c.lineWidth=2;
    const [x,y,w,h]=['motionAreaX','motionAreaY','motionAreaWidth','motionAreaHeight'].map(k=>Number($(k).value));c.strokeRect(x*p.width/100,y*p.height/100,w*p.width/100,h*p.height/100);c.fillStyle='#111';c.font='16px sans-serif';c.fillText('Рабочая область (без sync-кода)',12,22);
  }
  function update() {
    const busy = !!attempt || !!active || finishing, limit = runs.length >= maxRuns || sampleCount() >= maxSeriesSamples;
    $('syncCheckStart').disabled=busy;
    document.querySelectorAll('[data-sync-size]').forEach(b=>b.disabled=busy);
    $('motionStart').disabled = busy || limit || !ready;
    $('motionRepeat').disabled = busy || limit || !lastScenario || !ready;
    $('motionNewSeries').disabled = busy;
    $('motionExport').disabled = !runs.length;
    $('motionExportLast').disabled = !lastLocalRun;
    inputs.forEach(key => $(key).disabled = busy);
    $('motionUpload').disabled = busy;
    $('motionBounds').disabled = busy || !MotionGallery.images().some(m => m.id === selectedId);
    if (limit) status('Достигнут предел серии. Экспортируйте записи и начните новую серию.');
    window.MotionABUI?.render();
  }
  async function refresh(selected) {
    const version = ++refreshVersion, select = $('motionPhoto');
    selectedId = selected || selectedId;
    select.replaceChildren();
    for (const m of MotionGallery.images()) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.id} — ${m.label || ''}`; select.append(o); }
    if (!selectedId) selectedId = select.value;
    const m = MotionGallery.images().find(x => x.id === selectedId);
    if (!m && selectedId) { const o = document.createElement('option'); o.value = selectedId; o.textContent = `${selectedId} — сохранённое фото недоступно`; select.append(o); }
    select.value = selectedId || '';
    persist(); update();
    $('motionPhotoStatus').textContent = m && MotionGallery.bounds(m) ? 'Границы подтверждены.' : 'Выберите снимок и подтвердите границы объекта.';
    $('motionPhotoPreview').hidden=true;$('motionPhotoPreview').removeAttribute('src');
    if (!m) { $('motionPhotoStatus').textContent = 'Сохранённая фотография недоступна. Выберите или загрузите фото заново.'; return; }
    try { const image=await MotionGallery.imageLoaded(m.file); if(version===refreshVersion){const p=$('motionPhotoPreview');p.src=image.src;p.width=m.width;p.height=m.height;p.hidden=false;} }
    catch (_) { if (version === refreshVersion) $('motionPhotoStatus').textContent = 'Выбранная фотография недоступна. Восстановите файл или выберите другое фото.'; }
  }
  function values() {
    const m = MotionGallery.images().find(x => x.id === selectedId), bbox = m && MotionGallery.bounds(m);
    if (!m) throw Error('Сохранённая фотография недоступна. Выберите или загрузите фото заново.');
    if (!bbox) throw Error('Подтвердите границы объекта на выбранном снимке.');
    const distance = $('motionDistance').value.trim();
    const conditions = { setup_id: $('motionSetup').value.trim() || null, zoom: $('motionZoom').value.trim() || null, orientation: $('motionOrientation').value.trim() || null, camera_config: $('motionCamera').value.trim() || null, distance_cm: distance && Number(distance)>0 && Number.isFinite(Number(distance)) ? Number(distance) : null };
    return { m: { ...m }, bbox: bbox.slice(), conditions, area: ['motionAreaX','motionAreaY','motionAreaWidth','motionAreaHeight'].map(k=>Number($(k).value)), calibration_size_px:Number($('motionTagSize').value),sync_module_px:Number($('motionSyncSize').value), target_width_px: Number($('motionWidth').value), max_speed_px_s: Number($('motionSpeed').value), acceleration_px_s2: Number($('motionAcceleration').value), laps: Number($('motionLaps').value) };
  }
  function viewport() { const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; return { width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr), css_width: rect.width, css_height: rect.height, dpr,screen:{width:screen.width,height:screen.height,left:screen.availLeft??0,top:screen.availTop??0} }; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function draw(sample, plan, image) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (sample.visible) { const [x, y, r, b] = sample.image_rect_px; ctx.drawImage(image, x, y, r - x, b - y); }
    plan.calibration_markers.forEach(tag=>MotionCalibration.draw(ctx,tag));
    const { x, y, module_px: m } = plan.marker, bits = Motion.markerBits(sample.run_id, sample.step_id);
    ctx.fillStyle = '#000';ctx.fillRect(...plan.sync_backing);
    ctx.fillStyle = '#fff'; ctx.fillRect(x - m, y - m, 12 * m, 10 * m);
    ctx.fillStyle = '#000'; bits.forEach((bit, i) => { if (bit) ctx.fillRect(x + (i % 10) * m, y + Math.floor(i / 10) * m, m, m); });
  }
  async function returnToSettings() {
    try {
      // Attempt fullscreen exit even if painting the blank scene fails.
      try { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      finally { if (document.fullscreenElement === stage) await document.exitFullscreen(); }
    } finally {
      canvas.width = canvas.height = 0;
      stage.classList.add('hidden');
      try { MotionGallery.settings(); }
      finally { $('settings').classList.remove('hidden'); }
    }
  }
  async function finish(reason) {
    if (finishing || (!active && !attempt)) return;
    finishing = true;
    try {
    if (attempt) { attempt.cancelled = true; }
    if (active) {
      const current = active; active = null; cancelAnimationFrame(current.raf);
      current.run.complete = !reason; current.run.abort_reason = reason || null;
      if(current.check){
        attempt=null;
        SyncCheckUI.retain(current.run);
        canvas.width=0;
        // The reset removes the code; timestamp it before storage, analysis or awaits.
        current.run.end_ms=current.start===null?null:Math.max(0,performance.now()-current.start);
        let cleanupError=null;
        try { await returnToSettings(); } catch(e) { cleanupError=e.message; }
        const result=SyncCheckUI.save(current.run);if(!result.saved)saveFailure=Error('Не удалось сохранить проверку чтения');
        status((reason?'Проверка прервана: '+reason:'Проверка завершена')+'. '+(result.saved?'Запись проверки сохранена отдельно от движения.':'Не удалось сохранить в браузере. Экспортируйте проверку до закрытия страницы.')+(cleanupError?' Ошибка очистки: '+cleanupError:'')+(result.displayError?' Ошибка отображения: '+result.displayError:''));return;
      }
      canvas.width=0;
      MotionTimeline.close(current.run,current.start===null?null:Math.max(current.run.samples.at(-1)?.elapsed_ms??0,performance.now()-current.start));
      rememberLocalRun(current.run);
      if(current.run.pair_index)MotionABUI.finished(current.run);
      flush(current);
      current.writes=current.writes.then(()=>current.run.pair_index?MotionABUI.write(()=>MotionStore.end(current.key,current.run,MotionABUI.finished(current.run))):MotionStore.end(current.key,current.run)).then(()=>window.MotionABUI?.render());
      current.finalWrite=current.writes.catch(e=>{saveFailure=e;if(current.run.pair_index){current.run.complete=false;current.run.abort_reason='ошибка сохранения: '+e.message;MotionABUI.finished(current.run);}});
      attempt=null;
      finishing=current;
    }
    update();
    await returnToSettings();
    if(finishing.finalWrite)await finishing.finalWrite;
    status(saveFailure?`Ошибка сохранения: ${saveFailure.message}. Экспортируйте эталон до закрытия страницы.`:reason ? `Запуск прерван: ${reason}. Эталон сохранён как неполный.` : 'Запуск завершён. Эталон сохранён в браузере.');
    } catch(e) {
      let message='Ошибка завершения: '+e.message;
      try { await returnToSettings(); } catch(cleanup) { message+='; ошибка очистки: '+cleanup.message; }
      status(message);
    } finally { finishing=false;update(); }
  }
  function flush(current){const samples=current.run.samples.slice(current.saved);if(!samples.length)return;const index=current.saved;current.saved+=samples.length;const metadata=structuredClone({...current.run,complete:false,abort_reason:current.run.abort_reason||'не завершён',samples:[]});current.writes=current.writes.then(()=>MotionStore.append(current.key,index,samples,metadata));current.writes.catch(e=>{saveFailure=e;if(active===current)finish('ошибка сохранения');});}
  async function startCheck(){
    if(attempt||active||finishing)return;
    const pending={cancelled:false};attempt=pending;update();
    try{
      saveFailure=null;persist();stage.classList.remove('hidden');await stage.requestFullscreen();
      if(pending.cancelled){await returnToSettings();return;}
      if(document.hidden||document.fullscreenElement!==stage)throw Error('Страница скрыта или полный экран закрыт.');
      const vp=viewport();canvas.width=vp.width;canvas.height=vp.height;
      const [x,y,w,h]=['motionAreaX','motionAreaY','motionAreaWidth','motionAreaHeight'].map(k=>Number($(k).value));
      const button=$('motionStop').getBoundingClientRect();
      const plan=MotionScenario.layout({width:vp.width,height:vp.height,workspace:{x:x*vp.width/100,y:y*vp.height/100,width:w*vp.width/100,height:h*vp.height/100},calibration_size_px:Number($('motionTagSize').value),sync_module_px:Number($('motionSyncSize').value),control_width_px:button.width*vp.dpr,control_height_px:button.height*vp.dpr});
      $('motionStop').style.left=plan.control_rect[0]/vp.dpr+'px';$('motionStop').style.top=plan.control_rect[1]/vp.dpr+'px';$('motionStop').style.right='auto';
      const run={schema:'dronecv-sync-check-1',run_id:freshRunId(),viewport:vp,...plan,complete:false,steps:[],end_ms:null};
      $('settings').classList.add('hidden');
      const current={check:true,run,plan,viewport:vp,start:null,raf:0,lastElapsed:0};active=current;
      const frame=now=>{
        if(active!==current)return;
        if(document.hidden||document.fullscreenElement!==stage||!same(viewport(),vp)){finish('экран, видимость или размер окна изменились');return;}
        if(current.start===null)current.start=now;
        const elapsed=now-current.start;current.lastElapsed=elapsed;
        const last=run.steps.at(-1);
        if(last&&elapsed-last.elapsed_ms>=(last.step_id===0?10000:1000)){
          if(last.step_id===5){finish(null);return;}
        }else if(last){current.raf=requestAnimationFrame(frame);return;}
        const step_id=last?last.step_id+1:0;
        try{draw({run_id:run.run_id,step_id,visible:false},plan,null);}catch(e){finish('ошибка отрисовки: '+e.message);return;}
        run.steps.push({step_id,elapsed_ms:elapsed,browser_time_ms:now});
        current.raf=requestAnimationFrame(frame);
      };
      current.raf=requestAnimationFrame(frame);
    }catch(e){if(!pending.cancelled){
      finishing=true;let message='Не удалось начать проверку: '+e.message;
      try { await returnToSettings(); } catch(cleanup) { message+='; ошибка очистки: '+cleanup.message; }
      finally { finishing=false; }
      status(message);
    }}
    finally{if(attempt===pending)attempt=null;update();}
  }
  async function start(repeat = false, ab = null) {
    if (attempt || active || finishing || runs.length >= maxRuns || sampleCount() >= maxSeriesSamples) return;
    const pending = { cancelled: false }; attempt = pending; update();
    let operation='fullscreen';
    try {
      persist();
      const v = ab ? structuredClone(ab.values) : repeat ? structuredClone(lastScenario.values) : values();
      stage.classList.remove('hidden');
      await stage.requestFullscreen();
      if (pending.cancelled) { await returnToSettings(); return; }
      let image;
      try { image = await MotionGallery.imageLoaded(v.m.file); }
      catch (_) { throw Error('Выбранная фотография недоступна. Восстановите файл или выберите другое фото.'); }
      if (pending.cancelled) { await returnToSettings(); return; }
      if (image.naturalWidth !== v.m.width || image.naturalHeight !== v.m.height) throw Error('Размеры файла не совпадают с сохранённым снимком.');
      operation='photo';
      if(!v.m.file.startsWith('data:')){const retained=document.createElement('canvas');retained.width=v.m.width;retained.height=v.m.height;retained.getContext('2d').drawImage(image,0,0);v.m.file=retained.toDataURL('image/png');}
      if (document.hidden || document.fullscreenElement !== stage) throw Error('Страница скрыта или полный экран закрыт.');
      const vp = viewport(); canvas.width = vp.width; canvas.height = vp.height;
      if (repeat && !same(vp, lastScenario.viewport)) throw Error('Размер области движения изменился. Для нового размера нажмите «Старт».');
      const [ax,ay,aw,ah]=v.area;
      const button=$('motionStop').getBoundingClientRect();
      let plan = repeat ? structuredClone(lastScenario.plan) : MotionScenario.plan({ width: vp.width, height: vp.height, control_width_px:button.width*vp.dpr,control_height_px:button.height*vp.dpr,workspace:{x:ax*vp.width/100,y:ay*vp.height/100,width:aw*vp.width/100,height:ah*vp.height/100},calibration_size_px:v.calibration_size_px,sync_module_px:v.sync_module_px, image_width: v.m.width, image_height: v.m.height, bbox: v.bbox, target_width_px: v.target_width_px, max_speed_px_s: v.max_speed_px_s, acceleration_px_s2: v.acceleration_px_s2, laps: v.laps });
      if(ab)plan=MotionABUI.plan(ab,v,vp,plan);
      $('motionStop').style.left=plan.control_rect[0]/vp.dpr+'px';$('motionStop').style.top=plan.control_rect[1]/vp.dpr+'px';$('motionStop').style.right='auto';
      const runId = ab ? ab.run_id : freshRunId();
      const run = { schema: 'dronecv-motion-run-3', run_id: runId, mode: null, series_id: seriesId, photo: { id: v.m.id, sha256: v.m.sha256 || null, width: v.m.width, height: v.m.height, bbox: v.bbox }, conditions: { ...v.conditions, viewport: vp }, scenario: plan.config, calibration_points: plan.calibration_points, calibration_markers:plan.calibration_markers,sync_backing:plan.sync_backing, marker: plan.marker, duration_ms: plan.duration_ms, complete: false, abort_reason: 'не завершён', sync_period_ms: MotionTimeline.DEFAULT_PERIOD_MS, sync_intervals: [], end_ms: null, samples: [] };
      saveFailure=null;
      operation='storage';
      const scenario={values:structuredClone(v),viewport:structuredClone(vp),plan:structuredClone(plan)};
      if(ab)Object.assign(run,{series_id:ab.series_id,pair_index:ab.pair_index,variant:ab.slot,slot:ab.planned_order.indexOf(ab.slot)+1,order:ab.planned_order,attempt:ab.attempt,planned_order:ab.planned_order,actual_order:ab.actual_order,settings_snapshot:structuredClone(scenario)});
      const key=ab?await MotionABUI.write(()=>MotionStore.begin(run,scenario,MotionABUI.started(ab,run))):await MotionStore.begin(run,scenario);
      if(ab)ab.committed=true;
      lastScenario=scenario;
      if(pending.cancelled){
        run.abort_reason='старт отменён';rememberLocalRun(run);
        try{if(ab)await MotionABUI.write(()=>MotionStore.end(key,run,MotionABUI.finished(run)));else await MotionStore.end(key,run);}catch(e){saveFailure=e;}
        await returnToSettings();
        status(saveFailure?`Ошибка сохранения: ${saveFailure.message}. Экспортируйте эталон до закрытия страницы.`:'Запуск прерван до первого кадра. Эталон сохранён как неполный.');
        return;
      }
      $('settings').classList.add('hidden');
      active = { run, plan, image, viewport: vp, start: null, raf: 0,key,saved:0,writes:Promise.resolve() };
      const frame = now => {
        if (!active || active.run !== run) return;
        if (document.hidden || document.fullscreenElement !== stage || !same(viewport(), vp)) { finish('экран, видимость или размер окна изменились'); return; }
        if (run.samples.length >= maxSamples || sampleCount() + run.samples.length >= maxSeriesSamples) { finish('достигнут предел кадров'); return; }
        if (active.start === null) active.start = now;
        let sample;
        try{
          const elapsed=Math.max(0,now-active.start),step=MotionTimeline.nextCode(run.sync_intervals,elapsed,run.sync_period_ms);
          sample=MotionScenario.sample(plan,elapsed,step,runId);
          draw(sample,plan,image);
          MotionTimeline.commit(run.sync_intervals,step,elapsed);
          delete sample.step_id;sample.sample_id=run.samples.length;
          run.samples.push(sample);
        }catch(e){finish('ошибка отрисовки: '+e.message);return;}
        if(run.samples.length-active.saved>=120)flush(active);
        if (sample.elapsed_ms >= plan.duration_ms) active.raf = requestAnimationFrame(() => { if (active?.run === run) finish(null); });
        else active.raf = requestAnimationFrame(frame);
      };
      active.raf = requestAnimationFrame(frame);
    } catch (e) {
      if (!pending.cancelled) {
        finishing = true;
        const reason=e.name==='SecurityError' ? operation==='photo'
          ? 'Браузер запретил чтение пикселей фотографии из локального файла. Откройте стенд через http://localhost или выберите фото кнопкой «Заменить фотографию».'
          : operation==='fullscreen' ? 'Браузер запретил полный экран. Откройте стенд в отдельной вкладке и разрешите полноэкранный режим.'
          : 'Браузер запретил доступ к хранилищу эталонов. Откройте стенд через http://localhost и проверьте настройки хранения данных.' : e.message;
        let message=`Не удалось начать: ${reason}`;
        try { await returnToSettings(); } catch(cleanup) { message+='; ошибка очистки: '+cleanup.message; }
        finally { finishing=false; }
        status(message);
      }
    } finally { if (attempt === pending) attempt = null; update();if(ab)await MotionABUI.settled(ab); }
  }
  $('motionPhoto').onchange = () => { selectedId = $('motionPhoto').value; refresh(); };
  parameters.forEach(key => $(key).addEventListener('input', persist));
  $('motionUpload').onchange = async e => { try { const m = await MotionGallery.upload(e.target.files[0]); refresh(m.id); } catch (err) { status(err.message); } e.target.value = ''; };
  $('motionBounds').onclick = () => MotionGallery.edit(selectedId);
  $('syncCheckStart').onclick=startCheck;
  document.querySelectorAll('[data-sync-size]').forEach(b=>b.onclick=()=>{$('motionSyncSize').value=b.dataset.syncSize;persist();});
  $('motionStart').onclick = () => start();
  $('motionRepeat').onclick = () => start(true);
  $('motionStop').onclick = () => finish('остановлено оператором');
  $('motionNewSeries').onclick = () => { runs = []; seriesId = id(); refresh(); status('Новая серия. Ранее записанные эталоны остаются в IndexedDB.'); };
  $('motionExportLast').onclick = () => { const run = lastLocalRun; if (run) MotionGallery.download(`motion-${run.run_id}.json`, JSON.stringify(run, null, 2), 'application/json'); };
  $('motionExport').onclick = () => { if (runs.length) MotionGallery.download(`motion-series-${seriesId}.json`, JSON.stringify({ schema: 'dronecv-motion-series-1', runs }, null, 2), 'application/json'); };
  document.addEventListener('keydown', e => { if (active || attempt || finishing) { e.stopImmediatePropagation(); if (e.key === 'Escape') { e.preventDefault(); finish('остановлено оператором'); } } }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish('страница скрыта'); });
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement !== stage) finish('выход из полного экрана'); });
  window.addEventListener('resize', () => { if (active && !same(viewport(), active.viewport)) finish('размер окна изменён'); });
  window.addEventListener('beforeunload', e => { if (active || finishing || saveFailure) { e.preventDefault(); e.returnValue = ''; } });
  window.MotionUI = { refresh, values, startAB:ab=>start(false,ab), freshRunId, busy:()=>!!attempt||!!active||!!finishing, runs:()=>runs };
  status('Настройте движение и нажмите «Старт».');
  MotionStore.history().then(history=>{runs=history.runs;lastLocalRun=history.last_local_run;lastScenario=history.last_scenario;ready=true;update();$('motionHistoryStatus').textContent=lastLocalRun?'Последний локальный запуск: '+lastLocalRun.run_id+(lastScenario?'':'. Связанный снимок повторения отсутствует. Начните новый сценарий.'):history.chronology_unknown?'Порядок прежних записей неизвестен. Экспортируйте все записи кнопкой «Экспорт серии»; последний запуск не выбран произвольно.':'Локальных запусков ещё нет. Импорт эталонов не назначает последний запуск.';}).catch(e=>{status('Хранилище эталонов недоступно: '+e.message);});
  refresh();
})();

(function () {
  'use strict';
  const $ = id => document.getElementById(id), canvas = $('motionCanvas'), ctx = canvas.getContext('2d');
  const inputs = ['motionPhoto', 'motionWidth', 'motionSpeed', 'motionAcceleration', 'motionLaps', 'motionSetup', 'motionZoom', 'motionOrientation', 'motionCamera', 'motionDistance'];
  const maxRuns = 20, maxSamples = 40000, maxSeriesSamples = 120000;
  let runs = [], pair = null, pairIndex = 0, active = null, starting = false;
  let seriesId = id();
  function id() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0].toString(16).padStart(8, '0'); }
  function freshRunId() { let x; do { x = id(); } while (runs.some(r => r.run_id === x)); return x; }
  function sampleCount() { return runs.reduce((n, r) => n + r.samples.length, 0); }
  function status(message) { $('motionStatus').textContent = message; }
  function mode() { const order = pairIndex % 2 ? ['yolo_lk', 'yolo'] : ['yolo', 'yolo_lk']; return order[pair?.completed || 0]; }
  function modeLabel(x) { return x === 'yolo' ? 'A = YOLO' : 'B = YOLO + LK'; }
  function update() {
    const count = pair?.completed || 0;
    status(count === 2 ? `Пара ${pairIndex + 1} завершена. Экспортируйте данные или начните следующую пару.` : `Пара ${pairIndex + 1}, запуск ${count + 1}: ${modeLabel(mode())}. Подготовьте на телефоне указанную конфигурацию.`);
    $('motionStart').disabled = starting || !!active || count === 2 || runs.length >= maxRuns || sampleCount() >= maxSeriesSamples;
    $('motionNextPair').disabled = count !== 2 || runs.length >= maxRuns || sampleCount() >= maxSeriesSamples;
    $('motionExport').disabled = !runs.length;
    $('motionExportLast').disabled = !runs.length;
    inputs.forEach(id => $(id).disabled = !!pair || !!active || starting);
    $('motionUpload').disabled = $('motionBounds').disabled = !!pair || !!active || starting;
  }
  function refresh(selected) {
    const select = $('motionPhoto'), value = selected || select.value;
    select.replaceChildren();
    for (const m of MotionGallery.images()) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.id} — ${m.label || ''}`; select.append(o); }
    if ([...select.options].some(o => o.value === value)) select.value = value;
    const m = MotionGallery.images().find(x => x.id === select.value);
    $('motionPhotoStatus').textContent = m && MotionGallery.bounds(m) ? 'Границы подтверждены.' : 'Выберите снимок и подтвердите границы объекта.';
    update();
  }
  function values() {
    const m = MotionGallery.images().find(x => x.id === $('motionPhoto').value), bbox = m && MotionGallery.bounds(m);
    if (!m || !bbox) throw Error('Выберите доступный снимок и подтвердите границы объекта.');
    const distance = $('motionDistance').value.trim();
    if (distance && (!Number.isFinite(Number(distance)) || Number(distance) <= 0)) throw Error('Расстояние должно быть положительным числом.');
    const conditions = { setup_id: $('motionSetup').value.trim(), zoom: $('motionZoom').value.trim(), orientation: $('motionOrientation').value.trim(), camera_config: $('motionCamera').value.trim(), distance_cm: distance ? Number(distance) : null, same_installation_confirmed: true };
    if (!conditions.setup_id || !conditions.zoom || !conditions.orientation || !conditions.camera_config || !$('motionConfirm').checked) throw Error('Заполните условия съёмки и подтвердите неизменность установки.');
    return { m, bbox: bbox.slice(), conditions, target_width_px: Number($('motionWidth').value), max_speed_px_s: Number($('motionSpeed').value), acceleration_px_s2: Number($('motionAcceleration').value), laps: Number($('motionLaps').value) };
  }
  function viewport() { const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; return { width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr), css_width: rect.width, css_height: rect.height, dpr }; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function draw(sample, plan, image) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (sample.visible) { const [x, y, r, b] = sample.image_rect_px; ctx.drawImage(image, x, y, r - x, b - y); }
    const names = ['TL', 'TR', 'BR', 'BL'];
    plan.calibration_points.forEach(([x, y], i) => {
      ctx.fillStyle = '#fff'; ctx.fillRect(x - 12, y - 12, 24, 24);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = i === 1 || i === 2 ? 'right' : 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(names[i], x + (i === 1 || i === 2 ? -16 : 16), y);
    });
    const { x, y, module_px: m } = plan.marker, bits = Motion.markerBits(sample.run_id, sample.step_id);
    ctx.fillStyle = '#fff'; ctx.fillRect(x - m, y - m, 12 * m, 10 * m);
    ctx.fillStyle = '#000'; bits.forEach((bit, i) => { if (bit) ctx.fillRect(x + (i % 10) * m, y + Math.floor(i / 10) * m, m, m); });
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(12, m * 2)}px monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(`${sample.run_id} / ${sample.step_id}`, x + 12 * m, y);
  }
  async function finish(reason) {
    if (!active) return;
    const current = active; active = null; cancelAnimationFrame(current.raf);
    current.run.complete = !reason; current.run.abort_reason = reason || null;
    runs.push(current.run);
    if (!reason) { pair.completed++; $('motionConfirm').checked = false; }
    canvas.classList.add('hidden'); $('settings').classList.remove('hidden');
    if (document.fullscreenElement === canvas) { try { await document.exitFullscreen(); } catch (_) {} }
    update();
    if (reason) status(`Запуск прерван: ${reason}. Слот пары не изменён; запись доступна для экспорта.`);
  }
  async function start() {
    if (starting || active || runs.length >= maxRuns || sampleCount() >= maxSeriesSamples || pair?.completed === 2) return;
    starting = true; update();
    try {
      const v = values();
      canvas.classList.remove('hidden');
      await canvas.requestFullscreen();
      const image = await MotionGallery.imageLoaded(v.m.file);
      if (image.naturalWidth !== v.m.width || image.naturalHeight !== v.m.height) throw Error('Размеры файла не совпадают с сохранённым снимком.');
      if (document.hidden || document.fullscreenElement !== canvas) throw Error('Страница скрыта или полный экран закрыт.');
      const vp = viewport(); canvas.width = vp.width; canvas.height = vp.height;
      const plan = Motion.planMotion({ width: vp.width, height: vp.height, image_width: v.m.width, image_height: v.m.height, bbox: v.bbox, target_width_px: v.target_width_px, max_speed_px_s: v.max_speed_px_s, acceleration_px_s2: v.acceleration_px_s2, laps: v.laps });
      const fingerprint = { photo: { id: v.m.id, sha256: v.m.sha256 || null, width: v.m.width, height: v.m.height, bbox: v.bbox }, source: v.m.file, conditions: v.conditions, scenario: plan.config, viewport: vp };
      if (pair && !same(pair.fingerprint, fingerprint)) throw Error('Условия или размер экрана изменились. Верните прежнюю установку либо начните новую серию.');
      if (!pair) pair = { fingerprint, completed: 0 };
      const runId = freshRunId(), order = pairIndex % 2 ? 'BA' : 'AB';
      const run = { schema: 'dronecv-motion-run-1', run_id: runId, mode: mode(), series_id: seriesId, pair_index: pairIndex + 1, slot: pair.completed + 1, order, photo: fingerprint.photo, conditions: { ...v.conditions, viewport: vp }, scenario: plan.config, calibration_points: plan.calibration_points, marker: plan.marker, duration_ms: plan.duration_ms, complete: false, abort_reason: null, samples: [] };
      $('settings').classList.add('hidden');
      active = { run, plan, image, viewport: vp, start: null, raf: 0 };
      const frame = now => {
        if (!active || active.run !== run) return;
        if (document.hidden || document.fullscreenElement !== canvas || !same(viewport(), vp)) { finish('экран, видимость или размер окна изменились'); return; }
        if (run.samples.length >= maxSamples || sampleCount() + run.samples.length >= maxSeriesSamples) { finish('достигнут предел кадров'); return; }
        if (active.start === null) active.start = now;
        const sample = Motion.sampleMotion(plan, Math.max(0, now - active.start), run.samples.length, runId);
        draw(sample, plan, image); run.samples.push(sample);
        if (sample.elapsed_ms >= plan.duration_ms) active.raf = requestAnimationFrame(() => { if (active?.run === run) finish(null); });
        else active.raf = requestAnimationFrame(frame);
      };
      active.raf = requestAnimationFrame(frame);
    } catch (e) {
      canvas.classList.add('hidden');
      if (document.fullscreenElement === canvas) { try { await document.exitFullscreen(); } catch (_) {} }
      status(`Не удалось начать: ${e.message}`);
    } finally { starting = false; if (active) update(); else { $('motionStart').disabled = pair?.completed === 2 || runs.length >= maxRuns || sampleCount() >= maxSeriesSamples; inputs.forEach(id => $(id).disabled = !!pair); $('motionUpload').disabled = $('motionBounds').disabled = !!pair; } }
  }
  $('motionPhoto').onchange = () => refresh();
  $('motionUpload').onchange = async e => { try { const m = await MotionGallery.upload(e.target.files[0]); refresh(m.id); } catch (err) { status(err.message); } e.target.value = ''; };
  $('motionBounds').onclick = () => MotionGallery.edit($('motionPhoto').value);
  $('motionStart').onclick = start;
  $('motionNextPair').onclick = () => { if (pair?.completed === 2) { pairIndex++; pair = null; $('motionConfirm').checked = false; refresh(); } };
  $('motionNewSeries').onclick = () => { if (runs.length && !confirm('Начать новую серию? Неэкспортированные записи текущей серии будут удалены из памяти.')) return; runs = []; pair = null; pairIndex = 0; seriesId = id(); $('motionConfirm').checked = false; refresh(); };
  $('motionExportLast').onclick = () => { const run = runs.at(-1); if (run) MotionGallery.download(`motion-${run.run_id}.json`, JSON.stringify(run, null, 2), 'application/json'); };
  $('motionExport').onclick = () => { if (runs.length) MotionGallery.download(`motion-series-${seriesId}.json`, JSON.stringify({ schema: 'dronecv-motion-series-1', runs }, null, 2), 'application/json'); };
  document.addEventListener('keydown', e => { if (active || starting) { e.stopImmediatePropagation(); if (e.key === 'Escape' && active) { e.preventDefault(); finish('остановлено оператором'); } } }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) finish('страница скрыта'); });
  document.addEventListener('fullscreenchange', () => { if (active && document.fullscreenElement !== canvas) finish('выход из полного экрана'); });
  window.addEventListener('resize', () => { if (active && !same(viewport(), active.viewport)) finish('размер окна изменён'); });
  window.addEventListener('beforeunload', e => { if (runs.length || active) { e.preventDefault(); e.returnValue = ''; } });
  window.MotionUI = { refresh };
  refresh();
})();

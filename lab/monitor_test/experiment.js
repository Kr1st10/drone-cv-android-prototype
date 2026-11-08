/* Pure analysis of recorded laboratory observations. No sample detections are generated here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LabExperiment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DRONES = new Set(['civil_quadcopter', 'military_uav', 'uav_payload']);
  const NEGATIVES = new Set(['bird', 'aircraft', 'negative']);
  const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const integer = x => Number.isInteger(x) && x >= 0;
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const string = x => typeof x === 'string' && x.trim() ? x.trim() : null;
  const finite = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
  const round = (x, n = 1) => Number.isFinite(x * 10 ** n) ? Math.round(x * 10 ** n) / 10 ** n : x;
  function clean(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'object') return null;
    if (seen.has(value)) throw new TypeError('Циклический объект не является параметрами JSON.');
    seen.add(value);
    const result = Array.isArray(value) ? value.map(x => clean(x, seen)) :
      Object.fromEntries(Object.keys(value).sort().map(k => [k, clean(value[k], seen)]));
    seen.delete(value);
    return result;
  }
  function median(values) {
    const a = values.filter(x => finite(x) !== null).sort((a, b) => a - b), n = a.length;
    return n ? n % 2 ? a[(n - 1) / 2] : a[n / 2 - 1] / 2 + a[n / 2] / 2 : null;
  }
  function wilson(correct, total) {
    if (!integer(total) || !integer(correct) || total < 1 || correct > total) return null;
    const z = 1.959963984540054, p = correct / total, d = 1 + z * z / total;
    const middle = (p + z * z / (2 * total)) / d;
    const delta = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
    return { low: Math.max(0, middle - delta), high: Math.min(1, middle + delta), confidence: 0.95 };
  }
  function kindOf(r) {
    if ((DRONES.has(r.category) || r.kind === 'drone') && ['TP', 'FN'].includes(r.result_class)) return 'drone';
    if ((NEGATIVES.has(r.category) || r.kind === 'negative') && ['FP', 'TN'].includes(r.result_class)) return 'negative';
    return null;
  }
  function levelKey(r, kind) {
    // A nominal level owns all its scored attempts, including misses with missing size.
    // If any attempt lacks independent truth, that whole level is not a confirmed x coordinate.
    const physical = positive(r.screen_object_width_mm) ? round(r.screen_object_width_mm, 3) : null;
    const level = finite(r.size_level);
    const nominal = level !== null ? ['level', level, r.size_level_unit ?? null] :
      ['measured', positive(r.truth_camera_width_px) ? round(r.truth_camera_width_px) : null];
    // Missing geometry must not move a missed observation out of a known level's denominator.
    // Conflicting known geometry within that level is assessed conservatively by pointOf().
    return JSON.stringify(level !== null ? [kind, nominal] : [kind, nominal, physical]);
  }
  function pointOf(rows, kind, condition) {
    const checks = rows.length, correct = rows.filter(r => r.result_class === 'TP').length;
    const misses = rows.filter(r => r.result_class === 'FN').length;
    const falsePositives = rows.filter(r => r.false_alarm === true || r.result_class === 'FP').length;
    const independent = rows.filter(r => r.independent_check === true);
    const independentCorrect = independent.filter(r => r.result_class === 'TP').length;
    const truth = rows.filter(r => r.camera_size_independent === true && positive(r.truth_camera_width_px) &&
      (!positive(condition.analysis_frame_w) || r.truth_camera_width_px <= condition.analysis_frame_w));
    const screenWidths = rows.map(r => r.screen_object_width_mm).filter(positive);
    const displayScales = rows.map(r => r.display_scale).filter(positive);
    const screenRequired = rows[0].size_level_unit === 'screen_cm' || screenWidths.length > 0;
    const scaleRequired = displayScales.length > 0;
    const geometryMissing = rows.filter(r => screenRequired && !positive(r.screen_object_width_mm) || scaleRequired && !positive(r.display_scale)).length;
    const geometryComplete = geometryMissing === 0;
    const geometryConsistent = new Set(screenWidths.map(x => round(x, 3))).size <= 1 &&
      new Set(displayScales.map(x => round(x, 5))).size <= 1;
    const truthComplete = truth.length === checks && geometryComplete && geometryConsistent;
    const widths = truth.map(r => r.truth_camera_width_px);
    const cameraWidth = truthComplete ? round(median(widths)) : null;
    const rate = kind === 'drone' ? correct / checks : null;
    const independentRate = kind === 'drone' && independent.length ? independentCorrect / independent.length : null;
    const eligible = kind === 'drone' && truthComplete && positive(cameraWidth) && independent.length >= 20;
    const conf = rows.filter(r => kind === 'drone' ? r.result_class === 'TP' : r.result_class === 'FP')
      .map(r => finite(r.target_conf_pct) ?? finite(r.max_confidence_pct)).filter(x => x !== null && x >= 0 && x <= 100);
    const interval = wilson(kind === 'drone' ? correct : falsePositives, checks);
    const frameCount = (r, field) => integer(r[field]) &&
      (field === 'checked_frame_count' || !integer(r.checked_frame_count) || r[field] <= r.checked_frame_count) ? r[field] : null;
    const aggregateFrames = field => {
      const values = rows.map(r => frameCount(r, field));
      if (values.some(x => x === null)) return null;
      const total = values.reduce((a, b) => a + b, 0);
      return Number.isSafeInteger(total) ? total : null;
    };
    const first = rows[0];
    return {
      kind, size_level: finite(first.size_level), size_level_unit: first.size_level_unit ?? null,
      screen_object_width_mm: median(rows.map(r => positive(r.screen_object_width_mm) ? r.screen_object_width_mm : null)),
      camera_width_px: cameraWidth, camera_width_px_min: widths.length ? widths.reduce((a, b) => Math.min(a, b)) : null,
      camera_width_px_max: widths.length ? widths.reduce((a, b) => Math.max(a, b)) : null,
      truth_complete: truthComplete, camera_truth_complete: truth.length === checks, missing_truth_checks: checks - truth.length,
      geometry_complete: geometryComplete, geometry_consistent: geometryConsistent, missing_geometry_checks: geometryMissing,
      equivalent_distance_m: geometryComplete && geometryConsistent ? median(rows.map(r => positive(r.equivalent_distance_m) ? r.equivalent_distance_m : null)) : null,
      distance_known_count: rows.filter(r => positive(r.equivalent_distance_m)).length,
      checks, trials: checks, correct, correct_detections: correct, misses, false_positives: falsePositives,
      checked_frame_count: aggregateFrames('checked_frame_count'),
      frames_with_known_count: rows.filter(r => frameCount(r, 'checked_frame_count') !== null).length,
      candidate_frame_count: aggregateFrames('candidate_frame_count'),
      matched_frame_count: aggregateFrames('matched_frame_count'), missed_frame_count: aggregateFrames('missed_frame_count'),
      false_positive_frame_count: aggregateFrames('false_positive_frame_count'),
      rate, detection_rate: rate, false_positive_rate: kind === 'negative' ? falsePositives / checks : null,
      independent_checks: independent.length, independent_correct: independentCorrect, independent_rate: independentRate,
      confidence_median_pct: median(conf), confidence_known_count: conf.length,
      ci95: interval, ci_low: interval?.low ?? null, ci_high: interval?.high ?? null,
      ci_independence_confirmed: independent.length === checks,
      independent_ci95: kind === 'drone' ? wilson(independentCorrect, independent.length) : null,
      eligible, stability_met: eligible ? rate >= 0.9 && independentRate >= 0.9 : null
    };
  }
  function limitOf(points) {
    const positivePoints = points.filter(p => p.kind === 'drone');
    const tested = positivePoints.filter(p => p.eligible).sort((a, b) => a.camera_width_px - b.camera_width_px);
    const unknown = positivePoints.filter(p => !p.eligible);
    const warnings = [];
    if (unknown.length) warnings.push('Есть уровни без полной согласованной геометрии, независимого размера или 20 независимых проверок. Они не исключены из сводки.');
    const base = { status: 'empty', min_px: null, max_equivalent_distance_m: null, rate: null, n: null,
      min_independent_checks: 20, required_detection_rate: 0.9, stable_max_px: null, stable_min_px_tested: null,
      stable_max_distance_m_tested: null, smaller_failing_px: null, uncertainty: true, warnings };
    if (!positivePoints.length) return base;
    if (!tested.length) return { ...base, status: 'insufficient' };
    const stable = tested.filter(p => p.stability_met), failing = tested.filter(p => !p.stability_met);
    if (stable.length) {
      base.stable_min_px_tested = stable[0].camera_width_px;
      base.stable_max_px = Math.max(...stable.map(p => p.camera_width_px));
      const distances = stable.map(p => p.equivalent_distance_m).filter(positive);
      base.stable_max_distance_m_tested = distances.length ? Math.max(...distances) : null;
    }
    if (!failing.length) return { ...base, status: 'all_pass', warnings: warnings.concat('Все достаточно проверенные размеры устойчивы. Нужно испытать меньшие размеры; предел не установлен.') };
    if (!stable.length) return { ...base, status: 'all_fail', warnings: warnings.concat('Все достаточно проверенные размеры не достигли критерия. Нужно испытать большие размеры; предел не установлен.') };
    if (stable.some(s => failing.some(f => f.camera_width_px >= s.camera_width_px)))
      return { ...base, status: 'contradictory', warnings: warnings.concat('Наблюдается инверсия: меньший объект устойчив, а больший нет. Единственный порог не установлен.') };
    const boundary = stable[0];
    const lower = failing.filter(p => p.camera_width_px < boundary.camera_width_px).at(-1);
    if (!lower) return { ...base, status: 'insufficient' };
    return { ...base, status: 'bracketed', min_px: boundary.camera_width_px,
      max_equivalent_distance_m: base.stable_max_distance_m_tested, rate: boundary.rate, n: boundary.checks,
      independent_checks: boundary.independent_checks, smaller_failing_px: lower.camera_width_px,
      uncertainty: unknown.length > 0,
      warnings: warnings.concat('Граница относится только к испытанным размерам. Интервал между соседними уровнями не проверен; полевой предел не доказан.') };
  }
  function analysis(records) {
    if (!Array.isArray(records)) throw new TypeError('Результаты эксперимента должны быть массивом.');
    const datasets = new Map();
    records.forEach((r, index) => {
      if (!object(r) || r.experiment_kind !== 'limit' || !string(r.run_id)) return;
      const kind = kindOf(r); if (!kind) return;
      const condition = clean(object(r.experiment_condition) ? r.experiment_condition : {});
      const signature = JSON.stringify(condition), key = JSON.stringify([r.run_id, signature]);
      if (!datasets.has(key)) datasets.set(key, { id: r.run_id, key, condition, groups: new Map(), have: new Set(), duplicate_count: 0 });
      const dataset = datasets.get(key);
      const recordId = integer(r.step) ? `step:${r.step}` : string(r.observation_id) ? `observation:${r.observation_id}` : `row:${index}`;
      if (dataset.have.has(recordId)) { dataset.duplicate_count++; return; }
      dataset.have.add(recordId);
      const level = levelKey(r, kind); if (!dataset.groups.has(level)) dataset.groups.set(level, { kind, rows: [] });
      dataset.groups.get(level).rows.push(r);
    });
    return [...datasets.values()].map(d => {
      const points = [...d.groups.values()].map(g => pointOf(g.rows, g.kind, d.condition)).sort((a, b) =>
        a.kind.localeCompare(b.kind) || (a.camera_width_px ?? Infinity) - (b.camera_width_px ?? Infinity));
      const limit = limitOf(points), warnings = limit.warnings.slice();
      if (d.duplicate_count) warnings.push(`Повторные ключи записи не посчитаны повторными испытаниями: ${d.duplicate_count}.`);
      return { id: d.id, key: d.key, condition: d.condition, points, limit, warnings,
        total_checks: points.reduce((n, p) => n + p.checks, 0), duplicate_count: d.duplicate_count };
    });
  }
  function compatibility(savedCondition, currentCondition) {
    const saved = object(savedCondition) ? savedCondition : {}, current = object(currentCondition) ? currentCondition : {};
    const fields = ['phone', 'camera_zoom', 'analysis_frame_w', 'analysis_frame_h', 'model_name', 'model_sha256', 'confidence_pct', 'nms_iou', 'camera_id'];
    const reasons = [], missing = [], mismatches = [];
    const known = (field, x) => {
      if (field === 'analysis_frame_w' || field === 'analysis_frame_h') return integer(x) && x > 0;
      if (field === 'confidence_pct') return finite(x) !== null && x >= 0 && x <= 100;
      if (field === 'nms_iou') return finite(x) !== null && x >= 0 && x <= 1;
      if (field === 'camera_zoom') return x === '1x' || x === '5x';
      if (field === 'model_sha256') return typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x);
      return string(x) !== null;
    };
    for (const field of fields) {
      const a = saved[field], b = current[field];
      if (!known(field, a) || !known(field, b)) missing.push(field);
      else if (a !== b) mismatches.push(field);
    }
    if (saved.scene_conditions && current.scene_conditions && JSON.stringify(clean(saved.scene_conditions)) !== JSON.stringify(clean(current.scene_conditions))) mismatches.push('scene_conditions');
    if (mismatches.length) reasons.push('Различаются условия: ' + mismatches.join(', '));
    if (missing.length) reasons.push('Неизвестны условия: ' + missing.join(', '));
    return { status: mismatches.length ? 'mismatch' : missing.length ? 'unknown' : 'match', reasons, mismatches, missing };
  }
  function classifySize(dataset, currentPx, currentCondition) {
    const compatible = compatibility(dataset?.condition, currentCondition);
    const result = { status: 'unknown', compatibility: compatible, limit_px: dataset?.limit?.min_px ?? null, guarantee_detection: false };
    if (!positive(currentPx) || dataset?.limit?.status !== 'bracketed' || compatible.status !== 'match') return result;
    // Absorb floating-point arithmetic noise only; do not extend the tested range by a size bin.
    const epsilon = 1e-9;
    if (currentPx < dataset.limit.min_px - epsilon) return { ...result, status: 'below' };
    if (!positive(dataset.limit.stable_max_px) || currentPx > dataset.limit.stable_max_px + epsilon) return { ...result, status: 'above' };
    return { ...result, status: 'inside_tested_range' };
  }
  function parseAndroid(report) {
    if (!object(report) || report.schema_version !== 1 || !Array.isArray(report.frames))
      throw new TypeError('Нужен диагностический JSON Android schema_version=1 с массивом frames.');
    const model = object(report.model) ? report.model : {}, warnings = [];
    if (object(report.tracking)) warnings.push('Раздел сопровождения LK не участвует в подсчёте обнаружений YOLO.');
    const framePairs = new Set();
    let candidates = 0, noTarget = 0, unknown = 0, countOnly = 0;
    const frames = report.frames.map((row, index) => {
      const raw = object(row) ? row : {}, s = object(raw.target_signal) ? raw.target_signal : null;
      const version = s?.schema_version ?? report.target_signal_schema_version;
      const knownVersion = s !== null && (version === 1 || version === 2);
      const pixelSpace = knownVersion && (s.coordinate_space == null || s.coordinate_space === 'upright_crop_pixels');
      const width = pixelSpace && integer(s.width) && s.width > 0 ? s.width : null;
      const height = pixelSpace && integer(s.height) && s.height > 0 ? s.height : null;
      if (width && height) framePairs.add(JSON.stringify([width, height]));
      const count = s === null && integer(raw.detection_count) && raw.detection_count >= 0 ? raw.detection_count : null;
      if (count !== null) countOnly++;
      const detected = count !== null ? count > 0 :
        knownVersion && (s.status === 'detected' || version === 1 && s.status === 'observed');
      const missing = count !== null ? count === 0 :
        knownVersion && (s.status === 'no_target' || version === 1 && s.status === 'lost');
      const status = detected ? 'detected' : missing ? 'no_target' : 'unknown';
      if (detected) candidates++; else if (missing) noTarget++; else unknown++;
      const confidence = detected && s !== null && finite(s.confidence) !== null && s.confidence >= 0 && s.confidence <= 1 ? s.confidence * 100 : null;
      const rawCenter = s?.center ?? (version === 1 ? s?.observed : null);
      const center = object(rawCenter) && finite(rawCenter.x) !== null && finite(rawCenter.y) !== null && width && height &&
        rawCenter.x >= 0 && rawCenter.x <= width - 1 && rawCenter.y >= 0 && rawCenter.y <= height - 1 ? { x: rawCenter.x, y: rawCenter.y } : null;
      return { index, frame_id: s && integer(s.frame_id) ? s.frame_id : null,
        offset_ms: finite(raw.offset_ms), status, analysis_frame_w: width, analysis_frame_h: height,
        confidence_pct: confidence, center, detector_bbox_camera_px: null, object_width_px: null, object_height_px: null,
        result_class: null, independent_check: false };
    });
    const pair = framePairs.size === 1 ? JSON.parse([...framePairs][0]) : [null, null];
    if (framePairs.size > 1) warnings.push('В файле несколько размеров кадра; единственный размер анализа не подставлен.');
    if (unknown) warnings.push(`Неизвестен сигнал детектора для кадров: ${unknown}.`);
    if (!frames.length) warnings.push('В файле нет сохранённых кадров.');
    if (countOnly) warnings.push(`Кадров с числом кандидатов YOLO без координат и размера анализа: ${countOnly}.`);
    warnings.push('Размеры эталонного коптера не измерены. Импорт не использует рамку LK как результат YOLO.');
    warnings.push('Наличие сигнала detected не доказывает правильное обнаружение эталона. TP/FP требует разметки или ручного подтверждения.');
    warnings.push('Последовательные кадры одного файла не считаются независимыми испытаниями.');
    const confidence = finite(model.confidence);
    const metadata = {
      phone: string(report.device), app_version: string(report.app_version), model_name: string(model.name),
      model_sha256: typeof model.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(model.sha256) ? model.sha256.toLowerCase() : null,
      model_asset: string(model.asset), confidence_pct: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence * 100 : null,
      nms_iou: finite(model.nms_iou) !== null && model.nms_iou >= 0 && model.nms_iou <= 1 ? model.nms_iou : null,
      analysis_frame_w: pair[0], analysis_frame_h: pair[1], camera_zoom: null, camera_id: null,
      model_input_width: positive(model.input_width) ? model.input_width : null, model_input_height: positive(model.input_height) ? model.input_height : null,
      execution_provider: string(model.execution_provider), intra_op_threads: integer(model.intra_op_threads) && model.intra_op_threads > 0 ? model.intra_op_threads : null,
      started_epoch_ms: positive(report.started_epoch_ms) ? report.started_epoch_ms : null,
      completed_frames: integer(report.completed_frames) ? report.completed_frames : null, unstored_frames: integer(report.unstored_frames) ? report.unstored_frames : null
    };
    return { metadata, frames, frame_count: frames.length, candidate_count: candidates, detected_frames: candidates,
      no_target_count: noTarget, unknown_signal_count: unknown, bbox_available: false,
      correct_detection_count: null, miss_count: null, false_positive_count: null,
      warning: warnings.join(' '), warnings };
  }
  return { analysis, compatibility, classifySize, parseAndroid, wilson, median };
});

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PilotComparison = factory();
})(globalThis, function () {
  'use strict';

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === b.length && a.every(id => b.includes(id));
  const detections = ['box_on_object', 'box_elsewhere', 'no_box'];
  const known = value => value != null && value !== '';
  const positive = value => Number.isFinite(value) && value > 0;
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 5, useGrouping: false });
  const round = (value, decimals) => Number.isFinite(value) ? +value.toFixed(decimals) : value;

  function scaleMismatch(record, display, settings, step, image, confirmed) {
    const { width, height, category } = image;
    const box = confirmed ?? image.object_bbox;
    const side = box && Math.max(box[2] - box[0], box[3] - box[1]);
    const dpr = display?.dpr;
    const fit = [display?.width, display?.height, dpr, width, height].every(positive)
      ? Math.min(display.width / width, display.height / height) * dpr : null;
    const level = step?.level;
    const pixelRatio = positive(dpr) ? dpr : 1;
    const cssScale = monitorPixels => monitorPixels / side / pixelRatio;
    const monitorSize = monitorPixels => positive(side) ? side * cssScale(monitorPixels) * pixelRatio : monitorPixels;
    let coefficient = fit;
    const sizes = [];
    switch (settings.scaleMode) {
      case 'native':
        coefficient = settings.scaleFactor / pixelRatio * pixelRatio;
        break;
      case 'monitor':
        if (!positive(level)) break;
        if (positive(side)) coefficient = cssScale(level) * pixelRatio;
        sizes.push([monitorSize(level), 'object_monitor_px', 'px монитора', 1]);
        break;
      case 'camera': {
        const k = settings.k;
        if (!positive(level) || !positive(k)) break;
        const monitorPixels = level / k;
        if (positive(side)) coefficient = cssScale(monitorPixels) * pixelRatio;
        const monitorWidth = monitorSize(monitorPixels);
        sizes.push([round(monitorWidth, 1) * k, 'object_camera_px_expected', 'px кадра анализа', 1],
          [monitorWidth, 'object_monitor_px', 'px монитора', 1]);
        break;
      }
      case 'physical':
        if (category === 'negative' || !positive(level)) break;
        coefficient = null;
        if (confirmed && positive(dpr) && positive(settings.screen_calibration?.mm_per_css_px)) {
          coefficient = level * 10 / settings.screen_calibration.mm_per_css_px / (confirmed[2] - confirmed[0]) * dpr;
        }
        sizes.push([level * 10, 'screen_object_width_mm_calculated', 'мм', 2]);
        break;
    }
    const difference = ([expected, field, unit, decimals]) => {
      const actual = record[field];
      if (!positive(expected) || !Number.isFinite(actual) || round(expected, decimals) === round(actual, decimals)) return null;
      return `${field}: план ${number.format(round(expected, decimals))} ${unit}, запись ${number.format(round(actual, decimals))} ${unit}`;
    };
    return sizes.map(difference).find(Boolean) ?? difference([coefficient, 'display_scale', 'px монитора / px снимка', 5]);
  }

  function extraBoxConflict(record) {
    if (record?.detection !== 'no_box') return null;
    const fields = [
      record.fp_count > 0 && 'fp_count',
      known(record.fp_max_conf_pct) && 'fp_max_conf_pct',
      record.extra_box_observed === true && 'extra_box_observed',
      record.false_alarm === true && 'false_alarm',
      record.false_positive_frame_count > 0 && 'false_positive_frame_count',
    ].filter(Boolean);
    return fields.length ? '«Рамок нет» противоречит отметкам о лишних рамках (' + fields.join(', ') + ').' : null;
  }

  function outcomes(record, drone, extraConflict) {
    const detection = record?.detection;
    if (!detections.includes(detection)) return { correct: null, extra: null, missed: null };
    const correct = drone && detection === 'box_on_object';
    const count = record.fp_count;
    let extra = typeof record.extra_box_observed === 'boolean' ? record.extra_box_observed : null;
    if (detection === 'no_box' || count === 0) extra = false;
    if (detection === 'box_elsewhere' || !drone && detection === 'box_on_object' ||
        Number.isInteger(count) && count > 0 || record.false_alarm === true) extra = true;
    return { correct: drone ? correct : null, extra: extraConflict ? null : extra, missed: drone ? !correct : null };
  }

  function conditionsAgainstPlan(record, trial, settings, run, step, image, confirmed) {
    const snapshot = trial?.pilot_condition ?? {};
    const profile = settings.device_profile ?? {};
    const camera = {
      phone: snapshot.phone ?? profile.phone ?? settings.phone ?? run.phone,
      camera_zoom: snapshot.camera_zoom ?? settings.zoom ?? run.zoom,
      screen_distance_cm: snapshot.screen_distance_cm ?? settings.distance_cm ?? run.distance_cm,
      camera_id: snapshot.camera_id ?? settings.camera_id,
      model_name: snapshot.model_name ?? profile.model_name,
      model_sha256: snapshot.model_sha256 ?? settings.model_sha256 ?? profile.model_sha256,
      confidence_pct: snapshot.confidence_pct ?? profile.confidence_pct ?? settings.app_conf_pct,
      nms_iou: snapshot.nms_iou ?? profile.nms_iou,
      analysis_frame_w: snapshot.analysis_frame_w ?? profile.analysis_frame_w ?? settings.frame_w,
      analysis_frame_h: snapshot.analysis_frame_h ?? profile.analysis_frame_h ?? settings.frame_h,
      scene_conditions: snapshot.scene_conditions ?? settings.scene_conditions,
      screen_label: snapshot.screen_label ?? settings.screen_calibration?.label,
      observation_unit: snapshot.observation_unit ?? settings.observation_unit ?? 'window',
    };
    const facts = {
      phone: camera.phone, camera_zoom: camera.camera_zoom, distance_cm: camera.screen_distance_cm,
      test_mode: settings.mode ?? run.mode, scale_mode: settings.scaleMode, size_level: step?.level,
      attempt: step?.attempt ?? 1, observation_unit: camera.observation_unit, calibration_k: settings.k,
      analysis_frame_w: camera.analysis_frame_w, analysis_frame_h: camera.analysis_frame_h,
      yolo_input_px: settings.yolo_input, app_conf_threshold_pct: camera.confidence_pct,
    };
    const diff = (observed, expected, prefix = '') => Object.entries(expected)
      .filter(([key, value]) => known(value) && known(observed?.[key]) && !same(value, observed[key]))
      .map(([key, value]) => `${prefix}${key}: план ${JSON.stringify(value)}, запись ${JSON.stringify(observed[key])}`);
    const mismatches = [...diff(record, facts), ...diff(record.experiment_condition, camera, 'experiment_condition.')];
    const scale = scaleMismatch(record, trial?.pilot_display, settings, step, image, confirmed);
    if (scale) mismatches.push(scale);
    return mismatches;
  }

  function compare({ runs, records, images, manifest, confirmedBounds = () => null }) {
    const issues = [];
    const conditionIssues = [];
    const ids = images.map(image => image.id);
    if (ids.length !== 20 || new Set(ids).size !== 20) return { issues: ['В манифесте нет полного набора пилота.'] };
    if (runs.length !== 2 || !runs[0] || !runs[1] || runs[0].run_id === runs[1].run_id) {
      return { issues: ['Выберите два разных прогона пилота.'] };
    }

    const check = (label, a, b, required = false) => {
      if (a == null || a === '' || b == null || b === '') {
        if (required || (a ?? '') !== (b ?? '')) issues.push('Не подтверждено: ' + label);
      } else if (!same(a, b)) issues.push(`Различается ${label} · A: ${JSON.stringify(a)} · B: ${JSON.stringify(b)}`);
    };
    const [a, b] = runs.map((run, i) => {
      const trial = run.trial;
      const slot = i ? 'B' : 'A';
      const plan = Array.isArray(trial?.order) ? trial.order : [];
      if (trial?.run_id !== run.run_id || !sameSet(trial?.sample_ids, ids) ||
          !sameSet(plan.map(step => step?.id), ids) || plan.some(step => (step.attempt ?? 1) !== 1)) {
        issues.push(slot + ': требуется план с одним показом каждого из 20 снимков пилота.');
      }
      if (trial?.manifest_version !== manifest.version || (trial?.manifest_sha256 ?? null) !== manifest.sha256) {
        issues.push(slot + ': версия или SHA-256 манифеста отличается от открытой галереи.');
      }
      const settings = trial?.settings ?? {};
      if ((settings.experiment_kind ?? 'gallery') !== 'gallery') issues.push(slot + ': требуется статический прогон галереи.');
      const steps = new Map(plan.filter(Boolean).map(step => [step.id, step]));
      const byImage = new Map();
      for (const record of records.filter(row => row.run_id === run.run_id)) {
        const image = images.find(item => item.id === record.image_id);
        if (!image || byImage.has(record.image_id) || image.category !== record.category ||
            !detections.includes(record.detection) || (record.experiment_kind ?? 'gallery') !== 'gallery') {
          issues.push(slot + ': неоднозначная или несовместимая запись снимка ' + record.image_id);
          continue;
        }
        byImage.set(record.image_id, record);
        for (const mismatch of conditionsAgainstPlan(record, trial, settings, run, steps.get(image.id), image, confirmedBounds(image, settings))) {
          const message = `${slot} · ${image.id} · ${mismatch}`;
          issues.push(message);
          conditionIssues.push({ id: image.id, message });
        }
      }
      return { settings, trial, byImage, run, plan };
    });

    for (const [key, label, required] of [
      ['phone', 'телефон', true], ['zoom', 'зум', true], ['distance_cm', 'расстояние, см', true],
      ['mode', 'правила записи', true], ['scaleMode', 'режим масштаба', true],
      ['bg', 'фон'], ['center', 'центрирование'], ['camera_id', 'камера'], ['scene_conditions', 'условия сцены'],
      ['model_sha256', 'SHA-256 модели'], ['app_conf_pct', 'порог confidence'], ['frame_w', 'ширина кадра анализа'],
      ['frame_h', 'высота кадра анализа'], ['yolo_input', 'вход YOLO'],
    ]) {
      const values = [a, b].map(side => side.settings[key] ?? side.run[key]);
      if (key === 'distance_cm') check(label, ...values.map(value => Number.isFinite(value) && value > 0 ? value : null), required);
      else check(label, ...values, required);
    }
    check('единица наблюдения', a.settings.observation_unit ?? 'window', b.settings.observation_unit ?? 'window');
    if (a.trial?.pilot_display && b.trial?.pilot_display) {
      for (const key of ['width', 'height', 'dpr']) check('окно показа / ' + key, a.trial.pilot_display[key], b.trial.pilot_display[key], true);
    }
    if (a.settings.scaleMode === b.settings.scaleMode) {
      if (a.settings.scaleMode === 'native') check('коэффициент показа', round(a.settings.scaleFactor, 5), round(b.settings.scaleFactor, 5), true);
      if (a.settings.scaleMode === 'camera') check('коэффициент калибровки', a.settings.k, b.settings.k, true);
      if (a.settings.scaleMode === 'physical') check('масштаб калибровки',
        a.settings.screen_calibration?.mm_per_css_px, b.settings.screen_calibration?.mm_per_css_px, true);
    }
    for (const key of ['phone', 'camera_zoom', 'screen_distance_cm', 'camera_id', 'model_name', 'model_sha256',
      'confidence_pct', 'nms_iou', 'analysis_frame_w', 'analysis_frame_h', 'scene_conditions', 'screen_label', 'observation_unit']) {
      const values = [a, b].map((side, index) => {
        const observations = [side.trial?.pilot_condition?.[key], ...[...side.byImage.values()].map(row => row.experiment_condition?.[key])];
        const known = [...new Set(observations.filter(value => value != null && value !== ''))];
        if (known.length > 1) issues.push(`${index ? 'B' : 'A'} · Условия изменились: ${key} (${known.join(', ')}).`);
        return known[0];
      });
      if (values.every(value => value !== undefined)) check(key, ...values);
    }
    const plannedLevels = side => new Map(side.plan.filter(Boolean).map(step => [step.id, step.level ?? null]));
    const levelsA = plannedLevels(a), levelsB = plannedLevels(b);
    for (const id of ids) {
      if (levelsA.get(id) !== levelsB.get(id)) issues.push('Различается запланированный масштаб снимка ' + id);
      const A = a.byImage.get(id), B = b.byImage.get(id);
      if (!A || !B) continue;
      check('фактический масштаб / ' + id, round(A.display_scale, 5), round(B.display_scale, 5));
      for (const [key, label] of [['observation_unit', 'единица наблюдения'],
        ['test_mode', 'правила записи'], ['phone', 'телефон'], ['distance_cm', 'расстояние'], ['camera_zoom', 'зум']]) {
        check(label + ' / ' + id, A[key], B[key]);
      }
      for (const key of ['camera_id', 'model_name', 'model_sha256', 'confidence_pct', 'nms_iou', 'analysis_frame_w', 'analysis_frame_h', 'scene_conditions']) {
        check(key + ' / ' + id, A.experiment_condition?.[key], B.experiment_condition?.[key]);
      }
    }
    if (issues.length) return { issues: [...new Set(issues)], conditionIssues };

    const rows = images.map(({ id, drone }) => {
      const A = a.byImage.get(id), B = b.byImage.get(id);
      const extraConflicts = { A: extraBoxConflict(A), B: extraBoxConflict(B) };
      return { id, drone, A: outcomes(A, drone, extraConflicts.A), B: outcomes(B, drone, extraConflicts.B),
        extraConflicts, recorded: { A: !!A, B: !!B } };
    });
    const metrics = ['correct', 'extra', 'missed'].map(key => {
      const eligible = rows.filter(row => key === 'extra' || row.drone);
      const count = (list, slot) => list.filter(row => row[slot][key] === true).length;
      const paired = eligible.filter(row => row.A[key] !== null && row.B[key] !== null);
      return { key, eligible: eligible.length, paired: paired.length,
        ...Object.fromEntries(['A', 'B'].map(slot => [slot, {
          count: count(eligible, slot), assessed: eligible.filter(row => row[slot][key] !== null).length,
          paired_count: count(paired, slot),
        }])),
        delta: paired.length ? count(paired, 'B') - count(paired, 'A') : null };
    });
    const recorded = { A: a.byImage.size, B: b.byImage.size };
    return { issues: [], metrics, recorded, total: ids.length,
      rows: rows.filter(row => !same(row.A, row.B) || !row.recorded.A || !row.recorded.B || row.extraConflicts.A || row.extraConflicts.B) };
  }

  return { compare };
});

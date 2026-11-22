(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motion-ab.js'));
  else root.MotionManual = factory(root.MotionAB);
})(globalThis, function (AB) {
  'use strict';

  const VERSION = 'manual-observation-v1';
  const SELECTION_RULE = 'first_completed_per_slot_v1';
  const slots = ['A', 'B'];
  const fields = {
    capture: value => ['before_hide', 'after_return', 'no_capture'].includes(value),
    drops: value => Number.isSafeInteger(value) && value >= 0,
    before_hide: value => typeof value === 'boolean',
    after_return: value => typeof value === 'boolean',
  };
  const isLap = value => ['clean', 'violation'].includes(value);
  const unanswered = () => ({ status: 'unanswered' });
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;

  function answer(input, valid, label, statuses = ['uncertain', 'not_applicable']) {
    if (input?.status === 'unanswered') return unanswered();
    if (input?.status === 'known' && valid(input.value)) return { status: 'known', value: input.value };
    if (statuses.includes(input?.status) && text(input.reason)) {
      return { status: input.status, reason: input.reason.trim() };
    }
    throw Error('Некорректный ручной ответ: ' + label);
  }

  function member(series, run) {
    if (!text(series?.id) || !/^[0-9a-f]{8}$/i.test(run?.run_id ?? '')) throw Error('Некорректный ID серии или запуска.');
    const matches = series.attempts.filter(attempt => attempt.run_id === run.run_id);
    if (matches.length !== 1 || (!series.retrospective && run.series_id !== series.id)) {
      throw Error('Запуск не принадлежит серии или его ID неоднозначен.');
    }
    return matches[0];
  }

  function versionReason(saved) {
    return 'Неподдерживаемая версия ручной оценки: ' + (saved.version ?? 'не указана') + '.';
  }

  function savedFor(observations, series, run) {
    return observations.find(item => item.series_id === series.id && item.run_id === run.run_id);
  }

  const noCaptureReason = 'Правильного захвата не было.';

  function checkObservation(entry, run, attempt) {
    const derived = (key, status, reason, source = 'scenario') => {
      (entry.answer_sources ??= {})[key] = source;
      return { status, reason };
    };
    const coverage = entry.coverage ?? {};
    const scenario = run.scenario;
    const motionStart = scenario.calibration_ms + scenario.stationary_ms;
    const hide = scenario.disappearance_start_ms;
    const start = hide + scenario.disappearance_ms;
    const end = motionStart + scenario.movement_ms;
    const stop = Number.isFinite(run.end_ms) ? run.end_ms : Infinity;
    const returnNotReached = stop < start || (coverage.after_return === 'not_started' &&
      (!Number.isFinite(stop) || !Number.isFinite(start)));

    if (stop < hide) {
      entry.before_hide = derived('before_hide', 'not_applicable', 'Прогон закончился до скрытия.');
    }
    if (returnNotReached) {
      const source = stop < start ? 'scenario' : 'protocol';
      entry.after_return = derived('after_return', 'not_applicable', 'Прогон закончился до повторного появления.', source);
      if (entry.capture.value === 'after_return' || entry.capture.reason === 'Окно после появления не началось.') {
        entry.capture = derived('capture', 'uncertain', 'Окно после появления не началось.', source);
      }
    } else if ((entry.after_return.value === false ||
        entry.after_return.reason === 'Полный просмотр окна после появления не подтверждён.') &&
        (coverage.after_return !== 'complete' || stop < end)) {
      entry.after_return = derived('after_return', 'uncertain', 'Полный просмотр окна после появления не подтверждён.',
        stop < end ? 'scenario' : 'protocol');
    }
    if (entry.capture.value === 'no_capture' &&
        (coverage.scenario_complete !== true || run.complete !== true || attempt.complete !== true || stop < end)) {
      entry.capture = derived('capture', 'uncertain', 'Полный просмотр сценария не подтверждён.',
        stop < end ? 'scenario' : 'protocol');
    }
    if (stop < scenario.calibration_ms) {
      entry.capture = derived('capture', 'uncertain', 'Прогон закончился до первого показа цели.');
      entry.drops = derived('drops', 'not_applicable', 'Цель ещё не показывали.');
    }
    if (Number.isFinite(motionStart) && Number.isFinite(end) && scenario.movement_ms > 0 && stop < end) {
      const lapDuration = scenario.movement_ms / scenario.laps;
      entry.laps = entry.laps.map((lap, index) => {
        const lapStart = motionStart + lapDuration * index;
        const lapEnd = index + 1 === scenario.laps ? end : motionStart + lapDuration * (index + 1);
        const key = 'lap_' + (index + 1);
        if (stop < lapStart) return derived(key, 'not_applicable', 'Круг ещё не начался.');
        if (stop < lapEnd && lap.value !== 'violation' &&
            (lap.status !== 'uncertain' || lap.reason === 'Прогон прервался до конца круга.')) {
          return derived(key, 'uncertain', 'Прогон прервался до конца круга.');
        }
        return lap;
      });
    }
  }

  function lateCaptureConflict(entry, run) {
    if (entry.capture.value !== 'after_return') return null;
    const { calibration_ms, stationary_ms, movement_ms, laps, disappearance_start_ms, disappearance_ms } = run.scenario;
    const motionStart = calibration_ms + stationary_ms;
    const returnAt = disappearance_start_ms + disappearance_ms;
    if (![motionStart, movement_ms, returnAt].every(Number.isFinite) || movement_ms <= 0) return null;
    const index = entry.laps.findIndex((lap, i) => lap.value === 'clean' &&
      motionStart + movement_ms / laps * (i + 1) <= returnAt);
    return index < 0 ? null : `Круг ${index + 1} закончился до возможного первого захвата после появления (запуск ${run.run_id}). Проверьте оценку круга и время первого захвата.`;
  }

  function loadEntry(observations, series, run, attempt) {
    const count = run.scenario?.laps;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw Error('Нужно число запланированных кругов от 1 до 20.');
    const saved = savedFor(observations, series, run);
    if (saved && saved.version !== VERSION) throw Error(versionReason(saved));
    if (saved && saved.laps.length !== count) throw Error('План кругов для запуска изменился.');
    const setup = attempt.manual_setup;
    const entry = saved ? structuredClone(saved) : {
      version: VERSION, series_id: series.id, run_id: run.run_id,
      ...Object.fromEntries(Object.keys(fields).map(key => [key, unanswered()])),
      laps: Array.from({ length: count }, unanswered),
      operator: structuredClone({ ...setup?.operator, ...(setup?.deviations ? { deviations: setup.deviations } : {}) }),
      coverage: {}, notes: '',
    };
    if (entry.capture.value === 'no_capture' && entry.drops.status === 'not_applicable' &&
        entry.drops.reason === noCaptureReason && entry.drops_source !== 'operator') {
      entry.drops = unanswered();
    }
    return entry;
  }

  function read(observations, series, run) {
    const attempt = member(series, run);
    const { drops_source, ...entry } = loadEntry(observations, series, run, attempt);
    checkObservation(entry, run, attempt);
    if (entry.capture.value === 'no_capture' && entry.drops.status !== 'not_applicable') {
      entry.drops = { status: 'not_applicable', reason: noCaptureReason };
      (entry.answer_sources ??= {}).drops = 'protocol';
    }
    return {
      ...entry,
      run_complete: run.complete === true,
      attempt_complete: attempt.complete === true,
      observation_complete: [...Object.keys(fields).map(key => entry[key]), ...entry.laps]
        .every(item => item.status !== 'unanswered'),
    };
  }

  function save(observations, series, run, patch) {
    const attempt = member(series, run);
    const next = loadEntry(observations, series, run, attempt);
    if (!record(patch) || Object.keys(patch).some(key => !Object.hasOwn(fields, key) && !['laps', 'operator', 'coverage', 'notes'].includes(key))) {
      throw Error('Неизвестное поле ручной оценки.');
    }
    for (const [key, valid] of Object.entries(fields)) {
      if (Object.hasOwn(patch, key)) {
        next[key] = answer(patch[key], valid, key, key === 'capture' ? ['uncertain'] : undefined);
        if (next.answer_sources) delete next.answer_sources[key];
      }
    }
    if (Object.hasOwn(patch, 'drops')) next.drops_source = 'operator';
    if (Object.hasOwn(patch, 'laps')) {
      if (!Array.isArray(patch.laps) || patch.laps.length !== next.laps.length) throw Error('Нужен ответ для каждого запланированного круга.');
      next.laps = Array.from(patch.laps, (value, index) => {
        const lap = answer(value, isLap, 'круг ' + (index + 1));
        if (next.answer_sources && AB.canonical(lap) !== AB.canonical(next.laps[index])) {
          delete next.answer_sources['lap_' + (index + 1)];
        }
        return lap;
      });
    }
    if (Object.hasOwn(patch, 'notes')) {
      if (typeof patch.notes !== 'string') throw Error('Примечание должно быть строкой.');
      next.notes = patch.notes;
    }
    if (Object.hasOwn(patch, 'operator')) {
      if (!record(patch.operator)) throw Error('Подтверждения оператора должны быть объектом.');
      next.operator = structuredClone(patch.operator);
    }
    if (Object.hasOwn(patch, 'coverage')) {
      const coverage = patch.coverage;
      if (!record(coverage) || Object.keys(coverage).some(key => !['scenario_complete', 'after_return'].includes(key)) ||
          (Object.hasOwn(coverage, 'scenario_complete') && typeof coverage.scenario_complete !== 'boolean') ||
          (Object.hasOwn(coverage, 'after_return') && !['complete', 'partial', 'not_started'].includes(coverage.after_return))) {
        throw Error('Некорректная полнота ручного наблюдения.');
      }
      next.coverage = { ...coverage };
    }
    checkObservation(next, run, attempt);
    if (next.capture.value === 'no_capture' &&
        (next.drops.status === 'known' || next.before_hide.value === true || next.after_return.value === true ||
          next.laps.some(lap => lap.value === 'clean'))) {
      throw Error('Ответы противоречат подтверждённому отсутствию захвата.');
    }
    if (next.capture.value === 'after_return' && (next.before_hide.value === true || next.after_return.value === false)) {
      throw Error('Ответы противоречат первому захвату после появления.');
    }
    const conflict = lateCaptureConflict(next, run);
    if (conflict) throw Error(conflict);
    if (next.answer_sources && !Object.keys(next.answer_sources).length) delete next.answer_sources;
    const index = observations.findIndex(item => item.series_id === series.id && item.run_id === run.run_id);
    observations.splice(index < 0 ? observations.length : index, index < 0 ? 0 : 1, next);
    return read(observations, series, run);
  }

  function factorValues(series) {
    return slots.map(slot => {
      const value = series.variants?.[slot]?.value;
      if (['speed', 'acceleration'].includes(series.factor)) return Number(value);
      if (series.factor === 'build' && typeof value === 'string' && value.trim().startsWith('{')) return JSON.parse(value);
      return value;
    });
  }

  function planWithoutTempo(plan, factor) {
    if (!Array.isArray(plan?.base?.legs) || !plan.base.legs.length) return null;
    const omitted = AB.motionFactorFields(factor);
    const config = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !omitted.has(key)));
    const { duration_ms, base, ...geometry } = plan;
    const { duration_ms: baseDuration, lap_ms, legs, ...baseGeometry } = base;
    return {
      ...geometry, config: config(plan.config),
      base: {
        ...baseGeometry, config: config(base.config),
        legs: legs.map(({ from, to, distance }) => ({ from, to, distance })),
      },
    };
  }

  function compareConditions(series, runs, entries) {
    const expected = factorValues(series);
    const aa = AB.compareKnown(...expected) === 'equal';
    const factor = aa ? null : series.factor;
    const check = (key, A, B, state = AB.compareKnown(A, B)) => ({
      key, A, B, state: [A, B].some(value => typeof value === 'string' && !text(value)) ? 'unknown' : state,
    });
    const checks = [];
    const add = (key, values) => checks.push(check(key, ...values));
    const motionKey = AB.motionFactorKey(series.factor);
    const scenario = runs.map(run => run.scenario);
    const operator = entries.map(entry => entry.operator);
    const profiles = series.factor === 'build' && expected.every(record);
    const profileKeys = profiles ? Object.keys(expected[0]) : [];
    const omitted = AB.motionFactorFields(factor);
    for (const key of ['sha256', 'width', 'height', 'bbox']) add('photo.' + key, runs.map(run => run.photo?.[key]));
    add('conditions.viewport', runs.map(run => run.conditions?.viewport));
    for (const key of ['setup_id', 'zoom', 'orientation', 'camera_config', 'distance_cm']) {
      const values = runs.map((run, i) => operator[i][key] ?? run.conditions?.[key]);
      add('conditions.' + key, key === 'distance_cm'
        ? values.map(value => Number.isFinite(value) && value > 0 ? value : null) : values);
    }
    for (const key of new Set(['version', 'target_width_px', 'max_speed_px_s', 'acceleration_px_s2', 'laps', 'workspace',
      'calibration_size_px', 'sync_module_px', ...Object.keys(scenario[0]), ...Object.keys(scenario[1])])) {
      if (!omitted.has(key)) add('scenario.' + key, scenario.map(value => value[key]));
    }
    const plans = runs.map((run, index) => run.settings_snapshot?.plan ??
      (series.retrospective ? undefined : series.snapshots?.[slots[index]]?.plan));
    if (plans.some(Boolean)) {
      const comparablePlans = AB.motionFactorKey(factor) ? plans.map(plan => planWithoutTempo(plan, factor)) : plans;
      checks.push(check('settings_snapshot.plan', ...comparablePlans, AB.compareKnown(...comparablePlans, 'plan')));
    }
    const profileField = key => key === 'git_sha' ? 'build_id' : key;
    const variantFields = new Set(factor === 'mode' ? ['mode'] :
      factor === 'build' ? (profiles ? profileKeys.map(profileField) : ['build_id']) : []);
    for (const key of ['device', 'build_id', 'mode', 'model_sha256']) {
      if (!variantFields.has(key)) add('operator.' + key, operator.map(value => text(value[key]) ? value[key] : null));
    }
    for (const key of new Set(operator.flatMap(value => Object.keys(value.settings ?? {})))) {
      if (!AB.isModeDerivedField(factor, key) && (!factor || !profileKeys.includes(key))) add('operator.settings.' + key, operator.map(value => value.settings?.[key]));
    }
    if (operator.some(value => !record(value.settings) || !Object.keys(value.settings).length)) add('operator.settings', [null, null]);
    const route = operator.map(value => value.route_visible);
    checks.push(check('operator.route_visible', ...route, route.every(value => value === true) ? 'equal' : 'unknown'));

    for (const [index, slot] of slots.entries()) {
      const actual = operator[index];
      const expect = (key, value, observed) => checks.push(check('variant.' + slot + '.' + key, value, observed));
      if (motionKey) expect(motionKey, expected[index], scenario[index][motionKey]);
      if (series.factor === 'mode') expect('mode', expected[index], actual.mode);
      if (series.factor === 'build' && !profiles) expect('build_id', expected[index], text(actual.build_id) ? actual.build_id : null);
      if (profiles) for (const [key, value] of Object.entries(expected[index])) {
        const field = profileField(key);
        expect(key, value, ['build_id', 'model_sha256'].includes(field) ? actual[field] : actual.settings?.[key]);
      }
    }
    const state = checks.some(item => item.state === 'different') ? 'incomparable'
      : checks.some(item => item.state === 'unknown') ? 'unconfirmed' : 'comparable';
    return { kind: aa ? 'aa' : 'ab', state, checks, reasons: checks.filter(item => item.state !== 'equal')
      .map(item => (item.state === 'different' ? 'Различается: ' : 'Не подтверждено: ') + item.key) };
  }

  function selectionsFor(series) {
    if (series.manual_selection_rule !== SELECTION_RULE) return series.selections;
    const selections = {};
    for (const attempt of series.attempts.filter(row => row.complete === true).sort((a, b) => a.actual_order - b.actual_order)) {
      selections[attempt.pair_index + ':' + attempt.slot] ??= attempt.run_id;
    }
    return selections;
  }

  function compare(observations, series, pairIndex, runs) {
    const run_ids = Object.fromEntries(slots.map(slot => [slot, series.selections[pairIndex + ':' + slot] ?? null]));
    const entries = slots.map(slot => {
      const id = run_ids[slot];
      if (!id) return null;
      const attempts = series.attempts.filter(attempt => attempt.run_id === id);
      if (attempts.length !== 1 || attempts[0].slot !== slot || attempts[0].pair_index !== pairIndex) return null;
      const matches = runs.filter(run => run.run_id === id);
      return matches.length === 1 && (series.retrospective || matches[0].series_id === series.id) ? matches[0] : null;
    });
    const saved = entries.map(run => run && savedFor(observations, series, run));
    const versionIssues = saved.flatMap((entry, index) => entry && entry.version !== VERSION
      ? [slots[index] + ': ' + versionReason(entry)] : []);
    if (saved.every(Boolean) && saved[0].version !== saved[1].version) {
      versionIssues.push('Версии ручных оценок A и B различаются.');
    }
    const missing = entries.some(run => !run) || run_ids.A === run_ids.B;
    const readingIssues = [];
    const answers = entries.map((run, index) => {
      if (!run || saved[index] && saved[index].version !== VERSION) return null;
      try {
        return read(observations, series, run);
      } catch (error) {
        readingIssues.push(slots[index] + ': ' + error.message);
        return null;
      }
    });
    const [A, B] = answers;
    const conditions = !missing && A && B ? compareConditions(series, entries, answers) : null;
    const interrupted = answers.flatMap(entry => {
      if (!entry) return [];
      if (entry.run_complete !== entry.attempt_complete) {
        return ['Завершённость попытки и эталона различается: ' + entry.run_id];
      }
      return entry.run_complete ? [] : ['Прогон не завершён: ' + entry.run_id];
    });
    const conflicts = answers.flatMap((entry, index) => {
      const conflict = entry && lateCaptureConflict(entry, entries[index]);
      return conflict ? [slots[index] + ': ' + conflict] : [];
    });
    const reasons = [...interrupted, ...versionIssues, ...readingIssues, ...conflicts, ...(conditions?.reasons ?? [])];
    if (missing) reasons.push('Нужны две разные, однозначно выбранные попытки этой пары.');
    const rows = [];
    const add = (key, a, b) => {
      a ??= unanswered();
      b ??= unanswered();
      const unavailable = [a, b].flatMap((item, i) => item.status === 'known' ? [] : [slots[i] + ': ' + (item.reason ?? 'нет ответа')]);
      const delta = reasons.length || unavailable.length
        ? { status: 'unavailable', reasons: [...reasons, ...unavailable] }
        : { status: 'known', value: key === 'drops' ? b.value - a.value : a.value === b.value ? 'same' : 'changed' };
      rows.push({ key, A: a, B: b, delta });
    };
    add('capture', A?.capture, B?.capture);
    for (let i = 0; i < Math.max(A?.laps.length ?? 0, B?.laps.length ?? 0); i++) {
      const absent = { status: 'not_applicable', reason: 'Круг не был запланирован.' };
      add('lap_' + (i + 1), A && (A.laps[i] ?? absent), B && (B.laps[i] ?? absent));
    }
    for (const key of ['drops', 'before_hide', 'after_return']) add(key, A?.[key], B?.[key]);
    const available = rows.filter(row => row.delta.status === 'known').length;
    const result_state = !available ? 'insufficient_data' : available < rows.length ? 'partial' : 'complete';
    if (!available) reasons.push('Недостаточно данных для расчёта разностей.');
    const state = missing ? 'awaiting_attempt' : !conditions ? 'incomparable' : interrupted.length ? 'interrupted'
      : conflicts.length ? 'incomparable'
      : conditions.state === 'comparable' && !available ? 'insufficient_data' : conditions.state;
    return { pair_index: pairIndex, run_ids, attempts: { A, B }, rows, conditions, reasons, state, result_state };
  }

  return { VERSION, SELECTION_RULE, selectionsFor, read, save, compare };
});

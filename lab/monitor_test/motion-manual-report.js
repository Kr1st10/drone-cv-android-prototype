(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./motion-ab.js'), require('./motion-manual.js'), require('./motion-report.js'));
  } else root.MotionManualReport = factory(root.MotionAB, root.MotionManual, root.MotionReport);
})(globalThis, function (AB, Manual, Report) {
  'use strict';

  const POLICY = Manual.SELECTION_RULE;
  const rule = series => series.manual_selection_rule === POLICY
    ? 'В каждом варианте берётся первая завершённая попытка по фактическому порядку. Оценки и наличие журнала на выбор не влияют.'
    : 'Для этой серии правило до запуска не зафиксировано. Используется сохранённый ручной выбор.';

  function reference(series, runs, id) {
    const matches = runs.filter(run => run.run_id === id);
    return matches.length === 1 && (series.retrospective || matches[0].series_id === series.id) ? matches[0] : null;
  }

  function assessment(observations, series, run, saved) {
    if (!saved) return 'Не оценено';
    if (!run) return 'Эталон недоступен';
    try {
      return Manual.read(observations, series, run).observation_complete ? 'Форма заполнена' : 'Форма заполнена частично';
    } catch (error) {
      return 'Оценка недоступна. ' + error.message;
    }
  }

  function journalEvidence(series, run, entry) {
    if (!run) return { status: 'Эталон недоступен', conflicts: [] };
    const id = run?.run_id;
    const hash = series.bindings?.[id];
    const journal = series.journals?.find(row => row.run_id === id && row.hash === hash)?.data;
    const result = series.analyses?.findLast(row => row.run_id === id && row.source_hash === hash)?.result;
    if (!journal && !result) return { status: 'Журнал отсутствует', conflicts: [] };

    const metadata = journal ? Report.reportMetadata(run, journal, null).android : result.provenance?.android;
    const conflicts = Object.entries(metadata?.conflicts ?? {}).map(([key, values]) =>
      ({ key, journal: values.map(item => item.value), reason: 'Противоречивые метаданные журнала' }));
    const fields = metadata?.fields ?? {};
    const operator = entry?.operator ?? {};
    const check = (key, a, b) => {
      if (AB.compareKnown(a, b) === 'different') conflicts.push({ key, operator: a, journal: b });
    };
    for (const key of ['device', 'mode', 'model_sha256']) {
      check(key, operator[key], fields[key] ?? (key === 'mode' ? result?.mode : undefined));
    }
    const limitations = [];
    const build = typeof operator.build_id === 'string' ? operator.build_id.trim() : '';
    const apk = /^(?:sha-?256\s*:\s*)?([0-9a-f]{64})$/i.exec(build)?.[1];
    const git = /^(?:git\s*:\s*)?([0-9a-f]{40})$/i.exec(build)?.[1];
    if (apk && !/^[0-9a-f]{64}$/i.test(fields.apk_sha256 ?? '')) {
      limitations.push({ operator: operator.build_id, reason: 'Журнал не подтверждает идентичность APK: SHA-256 APK в журнале недоступен.' });
    } else if (apk && apk.toLowerCase() !== fields.apk_sha256.toLowerCase()) {
      conflicts.push({ key: 'build_id', operator: operator.build_id, journal: fields.apk_sha256 });
    } else if (git && /^[0-9a-f]{40}$/i.test(fields.git_sha ?? '') && git.toLowerCase() !== fields.git_sha.toLowerCase()) {
      conflicts.push({ key: 'build_id', operator: operator.build_id, journal: fields.git_sha });
    }
    const zoom = value => typeof value === 'string' ? Number(value.trim().replace(/[×x]$/i, '')) || value : value;
    check('zoom', zoom(operator.zoom), zoom(fields.camera_context?.confirmed_zoom));
    for (const [key, value] of Object.entries(operator.settings ?? {})) check(key, value, fields[key]);

    const timing = result?.timing_status;
    if (timing === 'compatible' && !series.analysis_errors?.[id] && (!journal || journal.complete === true && !journal.truncated)) {
      if (result.capture?.status === 'bounded' && ['no_capture', 'after_return'].includes(entry?.capture.value)) {
        conflicts.push({ key: 'capture', operator: entry.capture.value, journal: 'Подтверждена публикация правильных координат до скрытия' });
      }
      if (result.cleanup?.status === 'not_applicable' && entry?.before_hide.value === true) {
        conflicts.push({ key: 'before_hide', operator: true, journal: 'Перед скрытием координаты отсутствовали' });
      }
      if (result.reacquisition?.status === 'bounded' && entry?.after_return.value === false) {
        conflicts.push({ key: 'after_return', operator: false, journal: 'Подтверждена публикация правильных координат после появления' });
      }
    }
    const status = series.analysis_errors?.[id] ?? ({ compatible: 'Временное сопоставление доступно',
      incompatible: 'Несовместимая синхронизация', insufficient_capture: 'Недостаточно меток для синхронизации' })[timing]
      ?? 'Журнал привязан, анализ недоступен';
    return { status, conflicts, limitations };
  }

  function compare(series, pairIndex, runs) {
    const observations = series.manual_observations ?? [];
    const attempts = series.attempts.filter(row => row.pair_index === pairIndex);
    const fixed = series.manual_selection_rule === POLICY;
    const selections = Manual.selectionsFor(series);
    const pair = Manual.compare(observations, { ...series, selections }, pairIndex, runs);
    return {
      ...pair,
      kind: pair.conditions?.kind ?? (AB.compareKnown(series.variants.A.value, series.variants.B.value) === 'equal' ? 'aa' : 'ab'),
      history: attempts.map(attempt => {
        const selected = pair.run_ids[attempt.slot] === attempt.run_id;
        const run = reference(series, runs, attempt.run_id);
        const saved = observations.find(row => row.series_id === series.id && row.run_id === attempt.run_id);
        const excluded = selected ? null : !run ? 'Нет однозначного эталона'
          : !attempt.complete || !run.complete ? 'Прогон прерван'
            : fixed ? 'Ранее завершилась другая попытка варианта' : 'Попытка не выбрана';
        return {
          ...attempt, selected, excluded, reference_available: !!run,
          assessment: assessment(observations, series, run, saved),
          deviations: saved?.operator?.deviations ?? attempt.manual_setup?.deviations,
          notes: saved?.notes,
        };
      }),
      journals: Object.fromEntries(['A', 'B'].filter(slot => pair.run_ids[slot]).map(slot => {
        try {
          return [slot, journalEvidence(series, reference(series, runs, pair.run_ids[slot]), pair.attempts[slot])];
        } catch (error) {
          return [slot, { status: 'Проверка журнала недоступна. ' + error.message, conflicts: [] }];
        }
      })),
    };
  }

  return { POLICY, rule, compare };
});

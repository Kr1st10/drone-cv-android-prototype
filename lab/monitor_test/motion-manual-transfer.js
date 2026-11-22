(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./motion-ab.js'), require('./motion-manual.js'));
  else root.MotionManualTransfer = factory(root.MotionAB, root.MotionManual);
})(globalThis, function (AB, Manual) {
  'use strict';

  const FORMAT = 'dronecv-motion-manual-bundle-1';
  const isID = value => typeof value === 'string' && /^[0-9a-f]{8}$/i.test(value);

  function validate(series, runs) {
    const attemptIDs = new Set(series.attempts.map(item => item.run_id));
    const byID = new Map(runs.map(run => [run.run_id, run]));
    if (attemptIDs.size !== series.attempts.length || byID.size !== runs.length ||
        [...attemptIDs].some(id => !isID(id)) ||
        runs.some(run => !Array.isArray(run.samples) || !attemptIDs.has(run.run_id) ||
          (!series.retrospective && run.series_id !== series.id))) {
      throw Error('Неоднозначные ID или чужой эталон в комплекте.');
    }
    const entries = series.manual_observations ?? [];
    if (!Array.isArray(entries)) throw Error('Ручные оценки должны быть списком.');
    const observed = new Set();
    for (const entry of entries) {
      if (!entry || entry.series_id !== series.id || observed.has(entry.run_id) || !byID.has(entry.run_id) ||
          entry.version !== Manual.VERSION) throw Error('Повреждена привязка или версия ручной оценки.');
      const { series_id, run_id, version, drops_source, answer_sources, ...patch } = entry;
      const required = ['capture', 'laps', 'drops', 'before_hide', 'after_return', 'operator', 'notes'];
      if (required.some(key => !Object.hasOwn(patch, key)) || (drops_source != null && drops_source !== 'operator')) {
        throw Error('Неполная исходная запись ручной оценки.');
      }
      if (answer_sources !== undefined && (!answer_sources || Array.isArray(answer_sources) ||
          typeof answer_sources !== 'object' || Object.entries(answer_sources).some(([key, source]) =>
            !(required.includes(key) || /^lap_([1-9]|1[0-9]|20)$/.test(key)) || !['scenario', 'protocol'].includes(source)))) {
        throw Error('Некорректный источник ручного ответа.');
      }
      Manual.save([], series, byID.get(run_id), patch);
      observed.add(run_id);
    }
  }

  function comparisons(series, runs) {
    return Array.from({ length: series.pair_count }, (_, index) => {
      const { pair_index, run_ids, state, reasons, rows } = Manual.compare(series.manual_observations ?? [], series, index + 1, runs);
      return { pair_index, run_ids, state, reasons, rows };
    });
  }

  async function exportBundle(series, runs) {
    const base = await AB.exportBundle(series, runs);
    validate(base.series, base.runs);
    const bundle = { schema: FORMAT, observation_version: Manual.VERSION, base,
      comparisons: comparisons(base.series, base.runs) };
    return { ...bundle, integrity: await AB.sha256(AB.canonical(bundle)) };
  }

  async function importBundle(bundle) {
    const manual = bundle?.schema === FORMAT;
    if (manual) {
      const { integrity, ...body } = bundle;
      if (bundle.observation_version !== Manual.VERSION || await AB.sha256(AB.canonical(body)) !== integrity) {
        throw Error('Версия или контрольная сумма ручного комплекта не совпала.');
      }
    }
    const restored = await AB.importBundle(manual ? bundle.base : bundle);
    validate(restored.series, restored.runs);
    restored.series.manual_observations ??= [];
    if (manual && AB.canonical(comparisons(restored.series, restored.runs)) !== AB.canonical(bundle.comparisons)) {
      throw Error('Причины и исходы ручной оценки не воспроизводятся.');
    }
    return restored;
  }

  function csv(series, runs) {
    const lines = [['series_id', 'run_id', 'pair', 'slot', 'attempt', 'metric', 'status', 'value', 'reason', 'notes', 'selected', 'provenance']];
    for (const attempt of series.attempts) {
      const run = runs.find(item => item.run_id === attempt.run_id);
      if (!run) continue;
      const entry = Manual.read(series.manual_observations ?? [], series, run);
      const answers = { capture: entry.capture, ...Object.fromEntries(entry.laps.map((lap, index) => ['lap_' + (index + 1), lap])),
        drops: entry.drops, before_hide: entry.before_hide, after_return: entry.after_return };
      for (const [metric, answer] of Object.entries(answers)) {
        lines.push([series.id, run.run_id, attempt.pair_index, attempt.slot, attempt.attempt, metric,
          answer.status, answer.value, answer.reason, entry.notes,
          series.selections[attempt.pair_index + ':' + attempt.slot] === run.run_id,
          entry.answer_sources?.[metric] ?? (answer.status === 'unanswered' ? '' : 'operator')]);
      }
    }
    const quote = value => {
      let text = String(value ?? '');
      if (typeof value === 'string' && /^\s*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    return lines.map(line => line.map(quote).join(',')).join('\r\n');
  }

  return { FORMAT, exportBundle, importBundle, csv };
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import AB from '../motion-ab.js';
import Manual from '../motion-manual.js';
import MotionScenario from '../motion-scenario.js';

const known = value => ({ status: 'known', value });
const gap = (status, reason) => ({ status, reason });
const blank = { status: 'unanswered' };

function fixture(factor = 'mode', a = 'yolo_lk', b = a) {
  const series = AB.create({ id: '69977f88', factor, pair_count: 1, variants: { A: { value: a }, B: { value: b } } });
  const runs = ['74ede0d5', '6529690c'].map((run_id, index) => {
    const slot = index ? 'B' : 'A';
    AB.begin(series, { run_id, slot, pair_index: 1 }).complete = true;
    AB.select(series, 1, slot, run_id);
    return {
      run_id, series_id: series.id, complete: true,
      scenario: { version: 'simple-motion-v1', laps: 3, target_width_px: 75, max_speed_px_s: 150,
        acceleration_px_s2: 500, workspace: { x: 0, y: 0, width: 900, height: 700 }, calibration_size_px: 48, sync_module_px: 18 },
      photo: { sha256: 'test-photo', width: 800, height: 600, bbox: [100, 100, 200, 200] },
      conditions: { viewport: { width: 900, height: 700 } },
    };
  });
  return { series, runs, observations: [] };
}

const setup = {
  device: 'test-phone', mode: 'yolo_lk', build_id: 'test-build', model_sha256: 'test-model',
  zoom: '1×', orientation: 'landscape', camera_config: 'rear', setup_id: 'tripod', distance_cm: 70,
  route_visible: true, settings: { confidence: 0.5 },
};

function byKey(result, key) {
  return result.rows.find(row => row.key === key);
}

// Operator marks from the worked examples in MANUAL_PROTOCOL.md.
const protocolExamples = [
  {
    name: 'full observation without a correct box',
    capture: 'no_capture', laps: ['violation', 'violation', 'violation'], drops: blank,
    before: false, after: known(false),
  },
  {
    name: 'first capture after the pause does not count the preceding absence as a drop',
    capture: 'after_return', laps: ['violation', 'violation', 'clean'], drops: known(0),
    before: false, after: known(true),
  },
  {
    name: 'a box absent only during the planned pause leaves zero drops and three clean laps',
    capture: 'before_hide', laps: ['clean', 'clean', 'clean'], drops: known(0),
    before: true, after: known(true), pause_ms: 1_400,
    notes: 'Рамки не было только во время планового скрытия.',
  },
  {
    name: 'one confirmed drop before the pause and a correct box on return',
    capture: 'before_hide', laps: ['clean', 'violation', 'clean'], drops: known(1),
    before: false, after: known(true),
  },
  {
    name: 'a box on the background in lap three counts as a violation and a drop',
    capture: 'before_hide', laps: ['clean', 'clean', 'violation'], drops: known(1),
    before: true, after: known(true), notes: 'Рамка была на фоне больше секунды.',
  },
  {
    name: 'a missed part of lap one leaves that lap and the drop total uncertain',
    capture: 'before_hide', laps: [gap('uncertain', 'Пропущена часть круга.'), 'clean', 'clean'],
    drops: gap('uncertain', 'Не весь маршрут просмотрен.'), before: true, after: known(true),
    partial: true,
  },
  {
    name: 'stop inside the return window retains the violation and leaves the final lap unstarted',
    capture: 'before_hide', laps: ['clean', 'violation', blank],
    drops: gap('uncertain', 'Прогон остановлен до порога срыва.'), before: true, after: known(false),
    stop: 7_200,
  },
];

for (const example of protocolExamples) test('manual protocol: ' + example.name, () => {
  const { series, runs: [run], observations } = fixture();
  Object.assign(run.scenario, {
    calibration_ms: 1_000, stationary_ms: 1_000, movement_ms: 12_000,
    disappearance_start_ms: 6_500, disappearance_ms: example.pause_ms ?? 500,
  });
  run.end_ms = example.stop ?? 14_000;
  if (example.stop) run.complete = series.attempts[0].complete = false;
  const partial = example.partial || !!example.stop;
  const laps = example.laps.map(lap => typeof lap === 'string' ? known(lap) : lap);
  const patch = {
    capture: known(example.capture), laps, drops: example.drops,
    before_hide: known(example.before), after_return: example.after,
    coverage: { scenario_complete: !partial, after_return: example.stop ? 'partial' : 'complete' },
    notes: example.notes ?? '',
  };
  const result = Manual.save(observations, series, run, patch);
  assert.deepEqual(result.capture, patch.capture);
  assert.deepEqual(result.before_hide, patch.before_hide);
  assert.deepEqual(result.laps.slice(0, 2), laps.slice(0, 2));
  assert.deepEqual(result.laps[2], example.stop ? gap('not_applicable', 'Круг ещё не начался.') : laps[2]);
  assert.deepEqual(result.after_return, example.stop
    ? gap('uncertain', 'Полный просмотр окна после появления не подтверждён.') : patch.after_return);
  assert.deepEqual(result.drops, example.capture === 'no_capture'
    ? gap('not_applicable', 'Правильного захвата не было.') : patch.drops);
  assert.equal(result.notes, patch.notes);
  assert.equal(result.observation_complete, true);
  assert.deepEqual(Manual.read(JSON.parse(JSON.stringify(observations)), series, run), result);
});

test('pilot observations preserve zero, a third-lap violation and unanswered marks', () => {
  const { series, runs, observations } = fixture();
  const [a, b] = runs;
  Manual.save(observations, series, a, { laps: Array(3).fill(known('clean')), drops: known(0) });
  Manual.save(observations, series, b, {
    laps: [blank, blank, known('violation')], drops: known(1), notes: 'Срыв на третьем круге.',
  });
  const result = Manual.compare(observations, series, 1, runs);
  assert.equal(result.state, 'unconfirmed');
  assert.deepEqual(byKey(result, 'drops').A, known(0));
  assert.deepEqual(byKey(result, 'drops').B, known(1));
  assert.deepEqual(byKey(result, 'lap_3').B, known('violation'));
  for (const key of ['capture', 'before_hide', 'after_return']) {
    assert.deepEqual([byKey(result, key).A, byKey(result, key).B], [blank, blank]);
  }
  assert.equal(result.attempts.A.run_complete, true);
  assert.equal(result.attempts.A.observation_complete, false);
  assert.match(byKey(result, 'drops').delta.reasons.join(), /operator\.build_id/);
});

test('explicit selection controls repeats and a save edits only the same attempt', () => {
  const { series, runs, observations } = fixture();
  const [a] = runs;
  Manual.save(observations, series, a, { drops: known(0) });
  const repeat = { ...a, run_id: 'bead833e', complete: false };
  AB.begin(series, { run_id: repeat.run_id, slot: 'A', pair_index: 1 });
  runs.push(repeat);
  assert.deepEqual(Manual.read(observations, series, repeat).drops, blank);
  assert.equal(Manual.compare(observations, series, 1, runs).run_ids.A, a.run_id);
  Manual.save(observations, series, a, { drops: known(2) });
  assert.equal(observations.length, 1);
  assert.deepEqual(Manual.read(observations, series, a).drops, known(2));
  AB.select(series, 1, 'A', repeat.run_id);
  const result = Manual.compare(observations, series, 1, runs);
  assert.equal(result.state, 'interrupted');
  assert.deepEqual(byKey(result, 'drops').A, blank);
  assert.equal(result.attempts.A.run_complete, false);
  assert.throws(() => Manual.save(observations, series, { ...a, run_id: 'deadbeef' }, {}), /не принадлежит/);
  assert.throws(() => Manual.save(observations, series, { ...a, series_id: 'foreign' }, {}), /не принадлежит/);
  series.selections['1:A'] = runs[1].run_id;
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'awaiting_attempt');
});

test('validates outcomes and keeps run completion independent of observation completion', () => {
  const { series, runs, observations } = fixture();
  const run = { ...runs[0], complete: false };
  const patch = {
    capture: known('before_hide'), drops: known(0), before_hide: known(false),
    after_return: gap('not_applicable', 'Прервано до появления'),
    laps: [known('violation'), gap('uncertain', 'Дрон вышел за кадр'), gap('not_applicable', 'Круг не начался')],
  };
  const saved = Manual.save(observations, series, run, patch);
  assert.equal(saved.run_complete, false);
  assert.equal(saved.observation_complete, true);
  assert.deepEqual(saved.before_hide, known(false));
  assert.deepEqual(saved.laps, patch.laps);
  assert.deepEqual(saved.after_return, patch.after_return);
  assert.throws(() => Manual.save(observations, series, run, { drops: known(-1) }), /некорректный/i);
  assert.throws(() => Manual.save(observations, series, run, { before_hide: gap('uncertain', ' ') }), /некорректный/i);
  assert.throws(() => Manual.save(observations, series, run, { laps: [blank] }), /запланированного/);
  assert.deepEqual(Manual.read(observations, series, run), saved);
  assert.equal(Manual.save(observations, series, run, { capture: known('no_capture') }).capture.status, 'uncertain');
  assert.deepEqual(Manual.read(observations, series, run).drops, known(0));

  const fullRun = runs[0];
  const coverage = { scenario_complete: true, after_return: 'complete' };
  assert.throws(() => Manual.save(observations, series, fullRun, { coverage, capture: known('no_capture') }), /противоречат/);
  const noCapture = Manual.save(observations, series, fullRun, { coverage, capture: known('no_capture'), drops: blank, after_return: known(false) });
  assert.deepEqual(noCapture.capture, known('no_capture'));
  assert.equal(noCapture.drops.status, 'not_applicable');
  assert.deepEqual(noCapture.after_return, known(false));
  assert.deepEqual(Manual.save(observations, series, fullRun, { capture: blank }).drops, blank);
});

test('A/A compares confirmed values without journals and ignores incompatible sync', () => {
  const { series, runs, observations } = fixture();
  runs.forEach((run, i) => Manual.save(observations, series, run, { operator: setup, drops: known(i), before_hide: known(false) }));
  const result = Manual.compare(observations, series, 1, runs);
  assert.equal(result.conditions.kind, 'aa');
  assert.equal(result.result_state, 'partial');
  assert.equal(result.state, 'comparable');
  assert.deepEqual(byKey(result, 'drops').delta, known(1));
  assert.deepEqual(byKey(result, 'before_hide').delta, known('same'));
  assert.deepEqual(byKey(result, 'capture').delta.reasons, ['A: нет ответа', 'B: нет ответа']);
  series.analyses.push({ run_id: runs[0].run_id, result: { timing_status: 'incompatible' } });
  assert.deepEqual(Manual.compare(observations, series, 1, runs), result);
  Manual.save(observations, series, runs[1], { operator: { ...setup, distance_cm: 80 } });
  const mismatch = Manual.compare(observations, series, 1, runs);
  assert.equal(mismatch.state, 'incomparable');
  assert.match(byKey(mismatch, 'drops').delta.reasons.join(), /distance_cm/);
});

test('A/B permits one declared factor and checks its actual settings', () => {
  const { series, runs, observations } = fixture('speed', '150', '300');
  runs[0].scenario.movement_ms = 20_000;
  Object.assign(runs[1].scenario, { max_speed_px_s: 300, movement_ms: 10_000 });
  runs.forEach(run => Manual.save(observations, series, run, { operator: setup, drops: known(0) }));
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'comparable');
  runs[1].scenario.max_speed_px_s = 280;
  assert.match(Manual.compare(observations, series, 1, runs).reasons.join(), /variant\.B\.max_speed_px_s/);
  runs[1].scenario.max_speed_px_s = 300;
  runs[1].scenario.acceleration_px_s2 = 400;
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'incomparable');
});

test('mode and profile differences are limited to the declared variant values', () => {
  const mode = fixture('mode', 'yolo', 'yolo_lk');
  const profile = fixture('build', '{"confidence":0.4}', { confidence: 0.5 });
  for (const { series, runs, observations } of [mode, profile]) {
    const first = series.factor === 'mode' ? { ...setup, mode: 'yolo', settings: { ...setup.settings, yolo_period_ns: 70_000_000 } } : { ...setup, settings: { confidence: 0.4 } };
    Manual.save(observations, series, runs[0], { operator: first, drops: known(0) });
    const second = series.factor === 'mode' ? { ...setup, settings: { ...setup.settings, yolo_period_ns: 200_000_000 } } : setup;
    Manual.save(observations, series, runs[1], { operator: second, drops: known(0) });
    assert.equal(Manual.compare(observations, series, 1, runs).state, 'comparable');
    Manual.save(observations, series, runs[1], { operator: { ...setup, model_sha256: 'other-model' } });
    assert.equal(Manual.compare(observations, series, 1, runs).state, 'incomparable');
  }
});

test('build variants also work for explicitly attached retrospective runs', () => {
  const { series, runs, observations } = fixture('build', 'build-a', 'build-b');
  series.retrospective = true;
  runs.forEach((run, index) => {
    run.series_id = 'original-series';
    Manual.save(observations, series, run, { operator: { ...setup, build_id: index ? 'build-b' : 'build-a' }, drops: known(0) });
  });
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'comparable');
  assert.equal(Manual.compare(observations, series, 1, runs.concat(runs[1])).state, 'awaiting_attempt');
});

test('negative results require observation coverage and respect the interrupted timeline', () => {
  const { series, runs, observations } = fixture();
  const [run] = runs;
  Object.assign(run.scenario, { calibration_ms: 2_000, stationary_ms: 1_500, movement_ms: 6_500,
    disappearance_start_ms: 6_000, disappearance_ms: 1_000 });
  const negative = { capture: known('no_capture'), after_return: known(false) };
  const partial = Manual.save(observations, series, run, { ...negative, coverage: { after_return: 'partial' } });
  assert.equal(partial.capture.status, 'uncertain');
  assert.equal(partial.after_return.status, 'uncertain');

  run.complete = false;
  series.attempts[0].complete = false;
  const coverage = { scenario_complete: true, after_return: 'complete' };
  run.end_ms = 6_999;
  assert.equal(Manual.save(observations, series, run, { ...negative, coverage }).after_return.status, 'not_applicable');
  run.end_ms = 8_000;
  assert.equal(Manual.save(observations, series, run, { ...negative, coverage }).after_return.status, 'uncertain');
  const observed = Manual.save(observations, series, run, { capture: known('before_hide'), after_return: known(true) });
  assert.deepEqual(observed.after_return, known(true));
  assert.deepEqual(observed.capture, known('before_hide'));
  run.end_ms = 10_100;
  const afterWindow = Manual.save(observations, series, run, { ...negative, coverage });
  assert.equal(afterWindow.capture.status, 'uncertain');
  assert.deepEqual(afterWindow.after_return, known(false));
});

test('completion conflict retains observed values and blocks deltas', () => {
  const { series, runs, observations } = fixture();
  runs.forEach(run => Manual.save(observations, series, run, { operator: setup, drops: known(0) }));
  series.attempts[0].complete = false;
  const result = Manual.compare(observations, series, 1, runs);
  assert.equal(result.state, 'interrupted');
  assert.equal(result.attempts.A.run_complete, true);
  assert.equal(result.attempts.A.attempt_complete, false);
  assert.deepEqual(byKey(result, 'drops').A, known(0));
  assert.match(byKey(result, 'drops').delta.reasons.join(), /Завершённость попытки и эталона различается/);
});

test('A/A, mode and build comparisons check the saved route independently of scenario', () => {
  for (const { series, runs, observations } of [fixture(), fixture('mode', 'yolo', 'yolo_lk'), fixture('build', 'a', 'b')]) {
    for (const [i, run] of runs.entries()) {
      const value = series.variants[i ? 'B' : 'A'].value;
      const operator = series.factor === 'mode' ? { ...setup, mode: value } : { ...setup, build_id: value };
      run.settings_snapshot = { plan: { base: { marker: null, start: [0, 0] } } };
      Manual.save(observations, series, run, { operator, drops: known(0) });
    }
    assert.equal(Manual.compare(observations, series, 1, runs).state, 'comparable');
    runs[1].settings_snapshot.plan.base.start[0] = 1;
    assert.match(byKey(Manual.compare(observations, series, 1, runs), 'drops').delta.reasons.join(), /settings_snapshot\.plan/);
    delete runs[1].settings_snapshot;
    assert.equal(Manual.compare(observations, series, 1, runs).state, 'unconfirmed');
  }
});

test('unknown build identity and unsupported or mixed rule versions block the result', () => {
  const { series, runs, observations } = fixture();
  runs.forEach(run => Manual.save(observations, series, run, { operator: { ...setup, build_id: '  ' }, drops: known(0) }));
  const missingBuild = Manual.compare(observations, series, 1, runs);
  assert.equal(missingBuild.state, 'unconfirmed');
  assert.match(byKey(missingBuild, 'drops').delta.reasons.join(), /operator\.build_id/);
  observations[0].version = 'future';
  assert.match(Manual.compare(observations, series, 1, runs).reasons.join(), /версии ручных оценок A и B различаются/i);
  observations[1].version = 'future';
  assert.match(Manual.compare(observations, series, 1, runs).reasons.join(), /Неподдерживаемая версия ручной оценки: future/);
  assert.throws(() => Manual.save(observations, series, runs[0], { drops: known(1) }), /Неподдерживаемая версия/);
});

test('matching conditions without known paired indicators produce insufficient data', () => {
  const { series, runs, observations } = fixture();
  runs.forEach(run => Manual.save(observations, series, run, { operator: setup }));
  const result = Manual.compare(observations, series, 1, runs);
  assert.equal(result.conditions.state, 'comparable');
  assert.equal(result.state, 'insufficient_data');
  assert.equal(result.result_state, 'insufficient_data');
  assert.match(result.reasons.join(), /Недостаточно данных/);
  assert.ok(result.rows.every(row => row.delta.status === 'unavailable' && row.delta.reasons.length === 2));
});

test('acceleration comparison allows only its derived changes', () => {
  const { series, runs, observations } = fixture('acceleration', '500', '800');
  runs[0].scenario.movement_ms = 20_000;
  Object.assign(runs[1].scenario, { acceleration_px_s2: 800, movement_ms: 19_000 });
  runs.forEach(run => Manual.save(observations, series, run, { operator: setup, drops: known(0) }));
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'comparable');
  runs[1].scenario.max_speed_px_s = 300;
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'incomparable');
});

test('stop time determines which phase answers are applicable', () => {
  const { series, runs, observations } = fixture();
  const [run] = runs;
  Object.assign(run.scenario, { calibration_ms: 2_000, stationary_ms: 1_500, movement_ms: 6_500,
    disappearance_start_ms: 6_000, disappearance_ms: 1_000 });
  run.complete = false;
  series.attempts[0].complete = false;
  const answers = { before_hide: known(true), after_return: known(true), capture: known('after_return') };

  run.end_ms = 5_999;
  const beforeHide = Manual.save(observations, series, run, answers);
  assert.equal(beforeHide.before_hide.status, 'not_applicable');
  assert.equal(beforeHide.after_return.status, 'not_applicable');
  assert.equal(beforeHide.capture.status, 'uncertain');

  run.end_ms = 6_000;
  const hidden = Manual.save(observations, series, run, answers);
  assert.deepEqual(hidden.before_hide, known(true));
  assert.equal(hidden.after_return.status, 'not_applicable');
  assert.equal(hidden.capture.status, 'uncertain');

  run.end_ms = 7_000;
  const returned = Manual.save(observations, series, run, { ...answers, before_hide: known(false) });
  assert.deepEqual(returned.before_hide, known(false));
  assert.deepEqual(returned.after_return, known(true));
  assert.deepEqual(returned.capture, known('after_return'));
  assert.equal(returned.run_complete, false);
});

test('real MotionScenario plans may differ in tempo but must preserve route geometry', () => {
  for (const [factor, field, a, b] of [
    ['speed', 'max_speed_px_s', 150, 300],
    ['acceleration', 'acceleration_px_s2', 500, 800],
  ]) {
    const { series, runs, observations } = fixture(factor, a, b);
    for (const [index, run] of runs.entries()) {
      const plan = MotionScenario.plan({
        width: 1280, height: 800, workspace: { x: 64, y: 40, width: 1152, height: 720 },
        calibration_size_px: 48, sync_module_px: 18, image_width: 800, image_height: 600,
        bbox: [200, 100, 600, 500], target_width_px: 75, max_speed_px_s: 150,
        acceleration_px_s2: 500, laps: 3, [field]: index ? b : a,
      });
      run.scenario = structuredClone(plan.config);
      run.settings_snapshot = { plan };
      Manual.save(observations, series, run, { operator: setup, drops: known(index) });
    }
    const [first, second] = runs.map(run => run.settings_snapshot.plan);
    assert.notEqual(first.duration_ms, second.duration_ms);
    assert.deepEqual(byKey(Manual.compare(observations, series, 1, runs), 'drops').delta, known(1));

    second.offset[0] += 80;
    const moved = Manual.compare(observations, series, 1, runs);
    assert.equal(moved.state, 'incomparable');
    assert.match(byKey(moved, 'drops').delta.reasons.join(), /settings_snapshot\.plan/);
    second.offset[0] -= 80;
    second.base.legs[0].from[0] += 80;
    assert.equal(Manual.compare(observations, series, 1, runs).state, 'incomparable');
  }
});

test('losing confirmed no capture recalculates inferred drops and preserves operator answers', () => {
  const { series, runs, observations } = fixture();
  const [run] = runs;
  const noCapture = { capture: known('no_capture'), coverage: { scenario_complete: true } };
  const save = patch => Manual.save(observations, series, run, patch);
  const read = () => Manual.read(observations, series, run);
  const inferred = save(noCapture).drops;
  assert.equal(inferred.status, 'not_applicable');
  observations[0].drops = inferred;
  run.complete = false;
  assert.equal(read().capture.status, 'uncertain');
  assert.deepEqual(read().drops, blank);
  assert.deepEqual(save({ notes: 'Добавлено после прогона' }).drops, blank);
  assert.deepEqual(read().drops, blank);

  run.complete = true;
  const independent = gap('uncertain', 'Оператор пропустил часть эпизода');
  assert.deepEqual(save({ ...noCapture, drops: independent }).drops, inferred);
  assert.deepEqual(save({ coverage: { scenario_complete: false } }).drops, independent);
  assert.deepEqual(save({ notes: 'Ответ оператора остаётся' }).drops, independent);

  assert.deepEqual(save({ ...noCapture, drops: inferred }).drops, inferred);
  run.complete = false;
  assert.deepEqual(read().drops, inferred);
  assert.deepEqual(save({ notes: 'Неприменимость указал оператор' }).drops, inferred);
});

test('only a positive finite numeric distance confirms camera placement', () => {
  const { series, runs, observations } = fixture();
  for (const distance_cm of [0, -1, Infinity, NaN, '70']) {
    runs.forEach(run => Manual.save(observations, series, run, { operator: { ...setup, distance_cm }, drops: known(0) }));
    const result = Manual.compare(observations, series, 1, runs);
    assert.equal(result.state, 'unconfirmed');
    assert.match(byKey(result, 'drops').delta.reasons.join(), /Не подтверждено: conditions\.distance_cm/);
  }
  runs.forEach(run => Manual.save(observations, series, run, { operator: setup }));
  assert.equal(Manual.compare(observations, series, 1, runs).state, 'comparable');
});

function interruptedScenario() {
  const { series, runs: [run], observations } = fixture();
  const plan = MotionScenario.plan({
    width: 1280, height: 800, workspace: { x: 64, y: 40, width: 1152, height: 720 },
    calibration_size_px: 48, sync_module_px: 18, image_width: 800, image_height: 600,
    bbox: [200, 100, 600, 500], target_width_px: 75, max_speed_px_s: 150,
    acceleration_px_s2: 500, laps: 3,
  });
  run.scenario = plan.config;
  run.settings_snapshot = { plan };
  run.complete = false;
  series.attempts[0].complete = false;
  return {
    run, plan,
    save: patch => Manual.save(observations, series, run, patch),
    read: () => Manual.read(observations, series, run),
  };
}

test('a calibration stop leaves capture uncertain and drops and laps inapplicable', () => {
  const { run, plan, read, save } = interruptedScenario();
  const patch = { capture: known('before_hide'), drops: known(0), laps: Array(plan.config.laps).fill(known('clean')) };
  save(patch);
  run.end_ms = plan.config.calibration_ms / 2;
  assert.equal(MotionScenario.sample(plan, run.end_ms, 0, run.run_id).phase, 'calibration');

  const expected = read();
  assert.equal(expected.capture.status, 'uncertain');
  assert.equal(expected.drops.status, 'not_applicable');
  assert.deepEqual(expected.laps.map(lap => lap.status), Array(3).fill('not_applicable'));
  assert.deepEqual(save(patch), expected);
  assert.deepEqual(read(), expected);
  assert.deepEqual(save({ notes: 'Остановка во время калибровки' }), { ...expected, notes: 'Остановка во время калибровки' });
});

test('a stationary-phase stop preserves observed capture while no lap has started', () => {
  const { run, plan, read, save } = interruptedScenario();
  run.end_ms = plan.config.calibration_ms + plan.config.stationary_ms / 2;
  assert.equal(MotionScenario.sample(plan, run.end_ms, 0, run.run_id).phase, 'stationary');

  const expected = save({ capture: known('before_hide'), drops: known(0), laps: Array(3).fill(known('clean')) });
  assert.deepEqual(expected.capture, known('before_hide'));
  assert.deepEqual(expected.drops, known(0));
  assert.deepEqual(expected.laps.map(lap => lap.status), Array(3).fill('not_applicable'));
  assert.deepEqual(read(), expected);
  assert.deepEqual(save({ notes: 'Захват неподвижной цели' }), { ...expected, notes: 'Захват неподвижной цели' });
});

test('a stop inside lap one keeps a confirmed violation and disallows a clean lap', () => {
  const { run, plan, read, save } = interruptedScenario();
  const motionStart = plan.config.calibration_ms + plan.config.stationary_ms;
  const firstLapDuration = plan.base.lap_ms / plan.config.route_time_scale;
  const laps = [known('clean'), known('violation'), blank];
  save({ laps });
  run.end_ms = motionStart + firstLapDuration / 2;
  assert.equal(MotionScenario.sample(plan, run.end_ms, 0, run.run_id).visible, true);

  const interrupted = read();
  assert.deepEqual(interrupted.laps.map(lap => lap.status), ['uncertain', 'not_applicable', 'not_applicable']);
  assert.deepEqual(save({ laps }), interrupted);
  const observed = save({ laps: [known('violation'), ...laps.slice(1)] });
  assert.deepEqual(observed.laps[0], known('violation'));
  assert.deepEqual(observed.laps.slice(1), interrupted.laps.slice(1));
  assert.deepEqual(read(), observed);
  assert.deepEqual(save({ notes: 'Нарушение до остановки' }), { ...observed, notes: 'Нарушение до остановки' });
});

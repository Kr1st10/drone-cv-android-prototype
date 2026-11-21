import assert from 'node:assert/strict';
import { test } from 'node:test';
import AB from '../motion-ab.js';
import Manual from '../motion-manual.js';
import Report from '../motion-manual-report.js';
import Transfer from '../motion-manual-transfer.js';
import Pilot from '../pilot-comparison.js';
import { motionFixture, pilotFixture } from './fixtures/stage4-comparisons.mjs';

const fixture = factor => motionFixture({ AB, Manual, policy: Report.POLICY, factor });
const drops = pair => pair.rows.find(row => row.key === 'drops');

test('A/A without a journal uses the frozen rule and retains every attempt', () => {
  const { series, runs } = fixture('aa');
  const pair = Report.compare(series, 1, runs.slice().reverse());
  assert.equal(pair.kind, 'aa');
  assert.equal(pair.result_state, 'partial');
  assert.deepEqual(pair.run_ids, { A: 'a0000001', B: 'a0000002' });
  assert.equal(drops(pair).A.value, 0);
  assert.equal(drops(pair).B.value, 1);
  assert.equal(drops(pair).delta.value, 1);
  assert.equal(pair.journals.A.status, 'Журнал отсутствует');
  assert.equal(pair.history[2].assessment, 'Не оценено');
  assert.equal(pair.history[2].repeat_reason, 'Проверка повтора');
  assert.match(pair.history[2].excluded, /Ранее завершилась/);
});

test('declared A/B mode difference is allowed and incompatible sync keeps the operator answers', () => {
  const { series, runs } = fixture('ab');
  const run_id = runs[1].run_id, hash = 'synthetic';
  series.bindings = { [run_id]: hash };
  series.journals.push({ run_id, hash, data: { mode: 'yolo', frames: [] } });
  series.analyses.push({ run_id, source_hash: hash, result: { timing_status: 'incompatible' } });
  const pair = Report.compare(series, 1, runs);
  assert.equal(pair.kind, 'ab');
  assert.equal(pair.conditions.state, 'comparable');
  assert.equal(drops(pair).delta.value, 1);
  assert.match(pair.journals.B.status, /Несовместимая/);
  assert.deepEqual(pair.journals.B.conflicts, [{ key: 'mode', operator: 'yolo_lk', journal: 'yolo' }]);

  series.manual_observations[1].operator.distance_cm = 80;
  const different = Report.compare(series, 1, runs);
  assert.equal(different.conditions.state, 'incomparable');
  assert.equal(drops(different).delta.status, 'unavailable');
  assert.match(drops(different).delta.reasons.join(), /conditions.distance_cm/);
});

test('journal evidence compares build identifiers of the same type and preserves the APK mark', () => {
  const { series, runs } = fixture('aa');
  const apk = 'a'.repeat(64), git = 'b'.repeat(40);
  const original = 'SHA-256: ' + apk.toUpperCase();
  for (const entry of series.manual_observations) entry.operator.build_id = original;
  const run_id = runs[0].run_id, hash = 'build-types';
  const metadata = { git_sha: git };
  series.bindings = { [run_id]: hash };
  series.journals.push({ run_id, hash, data: { metadata } });
  const pair = () => Report.compare(series, 1, runs);
  const evidence = () => pair().journals.A;
  assert.deepEqual(evidence().conflicts, []);
  assert.match(evidence().limitations[0].reason, /не подтверждает идентичность APK/);
  assert.equal(evidence().limitations[0].operator, original);
  assert.equal(pair().attempts.A.operator.build_id, original);
  assert.equal(drops(pair()).delta.value, 1);

  metadata.apk_sha256 = apk;
  assert.deepEqual(evidence().limitations, []);
  assert.deepEqual(evidence().conflicts, []);
  metadata.apk_sha256 = 'c'.repeat(64);
  assert.equal(evidence().conflicts[0].journal, metadata.apk_sha256);
  for (const entry of series.manual_observations) entry.operator.build_id = 'd'.repeat(40);
  assert.equal(evidence().conflicts[0].journal, git);
});

test('incomplete BA keeps the selected side and lists the interrupted attempt', () => {
  const { series, runs } = fixture('aa');
  const pair = Report.compare(series, 2, runs);
  assert.deepEqual(pair.run_ids, { A: 'a0000005', B: null });
  assert.equal(pair.state, 'awaiting_attempt');
  assert.equal(drops(pair).A.value, 0);
  assert.equal(drops(pair).B.status, 'unanswered');
  assert.equal(drops(pair).delta.status, 'unavailable');
  assert.match(pair.history[0].abort_reason, /Синтетическая остановка/);
});

test('manual JSON exports the same rule as the report and accepts the historical incomplete summary', async () => {
  const { series, runs } = fixture('aa');
  const bundle = await Transfer.exportBundle(series, runs);
  assert.deepEqual(bundle.comparisons[0].run_ids, { A: 'a0000001', B: 'a0000002' });
  assert.equal(bundle.comparisons[1].rows.find(row => row.key === 'drops').A.value, 0);
  assert.equal((await Transfer.importBundle(bundle)).series.manual_selection_rule, Report.POLICY);
  const withoutReference = Report.compare(series, 1, runs.filter(run => run.run_id !== 'a0000001'));
  assert.equal(withoutReference.run_ids.A, 'a0000001');
  assert.equal(drops(withoutReference).delta.status, 'unavailable');

  delete series.manual_selection_rule;
  const legacy = await Transfer.exportBundle(series, runs);
  assert.deepEqual(legacy.comparisons[0].run_ids, { A: 'a0000003', B: null });
  assert.deepEqual(legacy.comparisons[0].rows, []);
  assert.equal((await Transfer.importBundle(legacy)).series.id, series.id);
});

const manifest = { version: 1, sha256: 'synthetic-manifest' };
const images = Array.from({ length: 20 }, (_, index) => ({
  id: 'photo-' + index, drone: index < 13, category: index < 13 ? 'civil_quadcopter' : 'negative',
}));
const pilot = () => pilotFixture(images, manifest, { sample_id: 'synthetic-sample', name: 'Пилот — 20 фото' });

test('pilot joins by image id, counts extra with a correct box, and keeps omitted observations unknown', () => {
  const report = Pilot.compare(pilot());
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.metrics.map(m => [m.key, m.eligible, m.A.count, m.A.assessed, m.B.count, m.B.assessed, m.paired, m.delta]), [
    ['correct', 13, 2, 3, 2, 3, 2, -1],
    ['extra', 20, 2, 3, 1, 4, 2, -2],
    ['missed', 13, 1, 3, 1, 3, 2, 1],
  ]);
  assert.deepEqual(report.rows[0].A, { correct: true, extra: true, missed: false });
  assert.equal(report.rows[1].A.extra, null);
  assert.equal(report.rows[2].recorded.B, false);
});

test('pilot rejects a different plan, conditions, recording rules or ambiguous rows', () => {
  for (const [change, reason] of [
    [data => data.runs[1].trial.order.pop(), /одним показом/],
    [data => { data.runs[1].trial.manifest_sha256 = 'other'; }, /манифеста/],
    [data => { data.runs[1].trial.settings.zoom = '5x'; }, /зум/],
    [data => { data.runs[1].trial.settings.mode = 'advanced'; }, /правила записи/],
    [data => data.records.push({ ...data.records[0] }), /неоднозначная/],
  ]) {
    const data = pilot();
    change(data);
    const report = Pilot.compare(data);
    assert.match(report.issues.join(' '), reason);
    assert.equal(report.metrics, undefined);
  }
});

test('a legacy no-box conflict removes only the extra-box outcome and explains the missing value', () => {
  const data = pilot();
  Object.assign(data.records[1], { fp_count: 2, fp_max_conf_pct: 50, false_alarm: true });
  const report = Pilot.compare(data);
  const first = report.rows.find(row => row.id === data.records[1].image_id);
  assert.deepEqual(first.A, { correct: true, extra: true, missed: false });
  assert.deepEqual(first.B, { correct: false, extra: null, missed: true });
  assert.match(first.extraConflicts.B, /Рамок нет.*fp_count.*fp_max_conf_pct/);
  assert.equal(data.records[1].fp_count, 2);
  const extra = report.metrics.find(metric => metric.key === 'extra');
  assert.equal(extra.B.assessed, 3);
  assert.equal(extra.B.count, 1);
  assert.equal(extra.paired, 1);
});

test('each pilot answer must match its own plan even if the other run has no answer', () => {
  for (const [answer, field] of [
    [{ phone: 'other-phone' }, 'phone'],
    [{ camera_zoom: '5x' }, 'camera_zoom'],
    [{ distance_cm: 80 }, 'distance_cm'],
    [{ test_mode: 'advanced' }, 'test_mode'],
    [{ scale_mode: 'native' }, 'scale_mode'],
    [{ experiment_condition: { phone: 'other-phone' } }, 'experiment_condition.phone'],
  ]) {
    const data = pilot(), unpaired = data.records[4];
    assert.ok(!data.records.some(row => row.run_id === data.runs[1].run_id && row.image_id === unpaired.image_id));
    Object.assign(unpaired, answer);
    const report = Pilot.compare(data);
    assert.equal(report.metrics, undefined);
    assert.equal(report.conditionIssues.length, 1);
    assert.equal(report.conditionIssues[0].id, unpaired.image_id);
    assert.ok(report.conditionIssues[0].message.includes(' · ' + field + ':'));
  }
  const data = pilot();
  data.runs[0].trial.pilot_condition = { nms_iou: 0.7 };
  data.records[4].experiment_condition = { nms_iou: 0.5 };
  assert.match(Pilot.compare(data).conditionIssues[0].message, /experiment_condition\.nms_iou: план 0\.7, запись 0\.5/);
});

test('pilot rejects 35.2 monitor px against 32 planned px on an unpaired photograph', () => {
  const data = pilot();
  for (const { trial } of data.runs) {
    trial.settings.scaleMode = 'monitor';
    for (const step of trial.order) step.level = 32;
  }
  const unpaired = data.records[4];
  Object.assign(unpaired, { size_level: 32, size_level_unit: 'monitor_px', object_monitor_px: 35.2 });
  const report = Pilot.compare(data);
  assert.deepEqual(report.conditionIssues, [{
    id: unpaired.image_id,
    message: `A · ${unpaired.image_id} · object_monitor_px: план 32 px монитора, запись 35,2 px монитора`,
  }]);
  assert.equal(report.metrics, undefined);
});

test('pilot accepts stored display coefficients rounded to five places', () => {
  const data = pilot();
  for (const { trial } of data.runs) Object.assign(trial.settings, { scaleMode: 'native', scaleFactor: 0.333333 });
  for (const record of data.records) Object.assign(record, { scale_mode: 'native', display_scale: 0.33333 });
  assert.deepEqual(Pilot.compare(data).issues, []);
  assert.ok(Pilot.compare(data).metrics.length);
  data.records[4].display_scale = 0.33334;
  assert.match(Pilot.compare(data).conditionIssues[0].message, /display_scale: план 0,33333.*запись 0,33334/);
});

test('pilot compares camera pixels after the gallery rounds monitor pixels and uses calibrated mm in physical mode', () => {
  const data = pilot(), unpaired = data.records[4];
  for (const { trial } of data.runs) {
    Object.assign(trial.settings, { scaleMode: 'camera', k: 3 });
    for (const step of trial.order) step.level = 32;
  }
  unpaired.object_camera_px_expected = 32.1;
  assert.deepEqual(Pilot.compare(data).issues, []);
  unpaired.object_camera_px_expected = 35.1;
  assert.match(Pilot.compare(data).conditionIssues[0].message, /32,1 px кадра анализа.*35,1 px кадра анализа/);
  for (const { trial } of data.runs) {
    Object.assign(trial.settings, { scaleMode: 'physical', screen_calibration: { mm_per_css_px: 0.25 } });
    for (const step of trial.order) step.level = 3.2;
  }
  Object.assign(unpaired, { screen_object_width_mm: 40, screen_width_source: 'manual', screen_object_width_mm_calculated: 32 });
  assert.deepEqual(Pilot.compare(data).issues, []);
  unpaired.screen_object_width_mm_calculated = 35.2;
  assert.match(Pilot.compare(data).conditionIssues[0].message, /32 мм.*35,2 мм/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import AB from '../motion-ab.js';
import Manual from '../motion-manual.js';
import Transfer from '../motion-manual-transfer.js';

function fixture() {
  const series = AB.create({ id: 'series', factor: 'mode', pair_count: 1,
    variants: { A: { value: 'yolo_lk' }, B: { value: 'yolo_lk' } } });
  const runs = ['abcdef01', 'abcdef02'].map((run_id, index) => {
    const slot = index ? 'B' : 'A';
    AB.begin(series, { run_id, slot, pair_index: 1 }).complete = true;
    AB.select(series, 1, slot, run_id);
    return { run_id, series_id: series.id, complete: true, samples: [], scenario: { laps: 1 } };
  });
  return { series, runs };
}

test('manual JSON preserves raw observations and recomputes limitations without a journal', async () => {
  const { series, runs } = fixture();
  series.attempts[0].manual_setup = { operator: { build_id: 'confirmed' }, deviations: '', provenance: 'operator' };
  assert.equal(Manual.read([], series, runs[0]).operator.build_id, 'confirmed');
  assert.equal(Manual.read([], series, runs[0]).drops.status, 'unanswered');
  series.manual_observations = [];
  Manual.save(series.manual_observations, series, runs[0], {
    drops: { status: 'known', value: 0 }, before_hide: { status: 'known', value: false }, notes: '=текст',
  });
  const bundle = await Transfer.exportBundle(series, runs);
  const result = await Transfer.importBundle(JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(result, { series, runs });
  assert.equal(bundle.comparisons[0].rows.find(row => row.key === 'drops').A.value, 0);
  assert.match(Transfer.csv(series, runs), /"before_hide","known","false"/);
  assert.match(Transfer.csv(series, runs), /"'/);
  bundle.comparisons[0].reasons.push('corruption');
  await assert.rejects(Transfer.importBundle(bundle), /контрольная сумма/);
});

test('legacy bundles restore empty observations and conflicting or foreign IDs fail', async () => {
  const { series, runs } = fixture();
  const legacy = await Transfer.importBundle(await AB.exportBundle(series, runs));
  assert.deepEqual(legacy.series.manual_observations, []);
  await assert.rejects(Transfer.exportBundle(series, [...runs, runs[0]]), /Неоднозначные ID/);
  await assert.rejects(Transfer.exportBundle(series, [{ ...runs[0], series_id: 'other' }, runs[1]]), /чужой эталон/);
  series.manual_observations = [{ series_id: series.id, run_id: 'abcdef00', version: Manual.VERSION }];
  await assert.rejects(Transfer.exportBundle(series, runs), /Повреждена привязка/);
  series.manual_observations[0].run_id = runs[0].run_id;
  await assert.rejects(Transfer.exportBundle(series, runs), /Неполная исходная запись/);
});

test('CSV distinguishes operator responses, phase-derived marks, and unanswered rows', async () => {
  const { series, runs } = fixture();
  const [a, b] = runs;
  Object.assign(a, {
    complete: false, end_ms: 3_800,
    scenario: { laps: 2, calibration_ms: 2_000, stationary_ms: 1_500, movement_ms: 8_000,
      disappearance_start_ms: 6_000, disappearance_ms: 1_000 },
  });
  series.attempts[0].complete = false;
  series.manual_observations = [];
  Manual.save(series.manual_observations, series, a, {
    capture: { status: 'known', value: 'before_hide' },
    laps: [{ status: 'known', value: 'violation' }, { status: 'unanswered' }],
  });
  const imported = await Transfer.importBundle(await Transfer.exportBundle(series, runs));
  const rows = Transfer.csv(imported.series, imported.runs).split('\r\n');
  const row = (run, key) => rows.find(line => line.split(',')[1] === '"' + run.run_id + '"' && line.split(',')[5] === '"' + key + '"');
  assert.match(row(a, 'capture'), /,"operator"$/);
  assert.match(row(a, 'lap_1'), /,"operator"$/);
  assert.match(row(a, 'lap_2'), /"not_applicable".*,"scenario"$/);
  assert.match(row(a, 'before_hide'), /,"scenario"$/);
  assert.match(row(b, 'drops'), /"unanswered".*,""$/);
});

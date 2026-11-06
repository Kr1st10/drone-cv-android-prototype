// Execute the gallery's actual pure functions, without a DOM or downloaded images.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../gallery.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function definition(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = script.indexOf('\nfunction ', start + 1);
  return script.slice(start, end);
}
const ctx = vm.createContext({ R: [], RUNS: [], SAMPLE: null, T: null, S: null,
  window: {}, FORMAT: 'dronecv66-session-2' });
vm.runInContext(script.match(/const DRONE_CATS = .*?;/)[0] + '\n' +
  script.match(/const COLS = \[[\s\S]*?\];/)[0] + '\n' +
  ['positive', 'equivalentDistance', 'normalizeRecord', 'sizeSummary', 'csv', 'sessionJson'].map(definition).join('\n'), ctx);
const call = (fn, ...args) => ctx[fn](...args);
assert.equal(call('equivalentDistance', 60, 150, 60), 15);
for (const invalid of [null, undefined, 0, -1, NaN, Infinity, '', '60']) {
  for (let i = 0; i < 3; i++) {
    const args = [60, 150, 60]; args[i] = invalid;
    assert.equal(call('equivalentDistance', ...args), null, `invalid dimension ${i}: ${invalid}`);
  }
}
const base = { run_id: 'r1', step: 0, category: 'civil_quadcopter', camera_zoom: '1x',
  distance_cm: 150, drone_width_cm: 60, screen_object_width_mm: 60,
  drone_width_source: 'TEST ONLY, width "A", B; C\nnot a real measurement',
  detection: 'box_on_object', result_class: 'TP', false_alarm: false,
  object_camera_px_measured: 16, object_camera_px_expected: 32 };
const row = call('normalizeRecord', base);
assert.equal(row.equivalent_distance_m, 15);
assert.ok(Math.abs(row.object_angular_width_deg - 2.291525676350207) < 1e-10);
const old = call('normalizeRecord', { ...base, drone_width_cm: undefined, screen_object_width_mm: undefined, object_monitor_mm: 60 });
assert.equal(old.drone_width_cm, null);
assert.equal(old.screen_object_width_mm, null);
assert.equal(old.object_angular_width_deg, null);
assert.equal(old.equivalent_distance_m, null); // no fallback to approximate bbox mm
assert.equal(call('normalizeRecord', { ...base, category: 'bird' }).equivalent_distance_m, null);
assert.equal(call('normalizeRecord', { ...base, distance_cm: null }).object_angular_width_deg, null);
assert.equal(call('normalizeRecord', { ...base, detection: 'no_box', max_confidence_pct: 80 }).max_confidence_pct, null);

ctx.R = [row,
  call('normalizeRecord', { ...base, step: 1, detection: 'no_box', result_class: 'FN', drone_width_cm: null }),
  call('normalizeRecord', { ...base, step: 2, object_camera_px_measured: null }),
  call('normalizeRecord', { ...base, run_id: 'r2', camera_zoom: '5x' }),
  call('normalizeRecord', { ...base, step: 3, category: 'bird', result_class: 'FP', false_alarm: true }),
  call('normalizeRecord', { ...base, step: 4, category: 'negative', object_camera_px_measured: null,
    object_camera_px_expected: null, size_level: 16, size_level_unit: 'camera_px', result_class: 'TN' }),
  call('normalizeRecord', { ...base, step: 5, object_camera_px_measured: null, object_camera_px_expected: null })];
const summary = call('sizeSummary', ctx.R);
assert.equal(summary.length, 6);
const measured = summary.find(g => g.run_id === 'r1' && g.kind === 'drone' && g.camera_px_source === 'measured');
assert.equal(measured.camera_px, 16); // measured takes precedence over calibration
assert.equal(measured.checks, 2);
assert.equal(measured.correct_detections, 1);
assert.equal(measured.detection_rate, 0.5);
assert.equal(measured.distance_known_count, 1);
assert.equal(measured.equivalent_distance_min_m, 15);
assert.equal(measured.equivalent_distance_max_m, 15);
assert.equal(summary.find(g => g.camera_px_source === 'calibration').camera_px, 32);
assert.equal(summary.find(g => g.kind === 'negative' && g.camera_px_source === 'measured').false_positive_rate, 1);
assert.equal(summary.find(g => g.camera_px_source === 'control_level').false_positive_rate, 0);
assert.equal(summary.find(g => g.camera_px_source === 'unknown').camera_px, null);
const session = JSON.parse(call('sessionJson'));
assert.equal(session.format, 'dronecv66-session-2');
assert.equal(session.results[0].equivalent_distance_m, 15);
assert.equal(session.size_summary.length, 6);
assert.equal(session.results[1].equivalent_distance_m, null);
const csv = call('csv');
assert.ok(csv.startsWith(fs.readFileSync(new URL('../results_template.csv', import.meta.url), 'utf8').trim() + '\n'));
assert.ok(csv.includes('"TEST ONLY, width ""A"", B; C\nnot a real measurement"'));
assert.ok(csv.includes(',60,"TEST ONLY'));
console.log('range, angle, missing/invalid values, legacy rows, size summary and CSV/JSON: OK');

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
  window: {}, SCREEN_CAL: null, BOUNDS: {}, EXPERIMENTS: [], LOCAL_IMAGES: {}, REFERENCE_IMAGE: null, DEVICE_PROFILE: null, CAMERA_CAL: null, GALLERY_STATE: null, FORMAT: 'dronecv66-session-2' });
vm.runInContext(script.match(/const DRONE_CATS = .*?;/)[0] + '\n' +
  script.match(/const COLS = \[[\s\S]*?\];/)[0] + '\n' +
  ['positive', 'equivalentDistance', 'physicalScale', 'validBounds', 'physicalWidth', 'normalizeRecord', 'sizeSummary', 'median', 'repeatSummary', 'csv', 'sessionJson'].map(definition).join('\n'), ctx);
const call = (fn, ...args) => ctx[fn](...args);
assert.equal(call('equivalentDistance', 60, 150, 60), 15);
assert.equal(call('equivalentDistance', 60, 150, 30), 30);
assert.equal(call('equivalentDistance', 57, 150, 30), 28.5);
assert.equal(call('physicalScale', 400, 100), 0.25);
assert.equal(call('physicalWidth', [100, 50, 400, 200], 1000, 500, 0.4, 0.25), 30); // object, not 1000-px photo
assert.equal(call('physicalWidth', [100, 50, 400, 200], 1000, 500, 0.2, 0.25), 15); // resize, no new ruler reading
for (const invalid of [null, undefined, 0, -1, NaN, Infinity, '', '100']) {
  assert.equal(call('physicalScale', invalid, 100), null);
  assert.equal(call('physicalScale', 400, invalid), null);
  assert.equal(call('physicalWidth', [0, 0, 100, 100], 1000, 500, 1, invalid), null);
}
assert.equal(call('physicalScale', 1e-300, 1e308), null);
for (const b of [null, [], [0, 0, 0, 100], [-1, 0, 100, 100], [0, 0, 1001, 100], [0, 0, 100, 501], [0, 0, NaN, 100]])
  assert.equal(call('physicalWidth', b, 1000, 500, 1, 0.25), null);
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
assert.equal(call('normalizeRecord', { ...base, screen_width_source: 'screen_calibration', screen_calibration_status: 'stale' }).equivalent_distance_m, null);

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
const repeatBase = { ...base, drone_width_source: 'TEST ONLY', screen_object_width_mm: 30, size_level: 3, size_level_unit: 'screen_cm',
  reference_status: 'conditional', max_confidence_pct: 80, stability_threshold_pct: 90, stability_min_attempts: 10, object_camera_width_px_measured: 12 };
const repeated = Array.from({ length: 10 }, (_, i) => call('normalizeRecord', { ...repeatBase, step: i, attempt: i + 1,
  result_class: i < 9 ? 'TP' : 'FN', detection: i < 9 ? 'box_on_object' : 'no_box', max_confidence_pct: i < 9 ? 80 + i : null }));
const rs = call('repeatSummary', repeated);
assert.equal(rs.length, 1);
assert.equal(rs[0].checks, 10); assert.equal(rs[0].detection_rate, 0.9); assert.equal(rs[0].stability_met, true);
assert.equal(rs[0].confidence_median_pct, 84); assert.equal(rs[0].confidence_known_count, 9);
assert.equal(rs[0].equivalent_distance_m, 30); assert.equal(rs[0].reference_status, 'conditional');
assert.equal(rs[0].camera_width_px_measured_median, 12);
assert.equal(call('repeatSummary', repeated.slice(0, 1))[0].stability_met, null);
assert.equal(call('repeatSummary', [...repeated, call('normalizeRecord', { ...repeatBase, app_conf_threshold_pct: 75 })]).length, 2);
assert.equal(call('repeatSummary', [...repeated, call('normalizeRecord', { ...repeatBase, image_id: 'different' })]).length, 2);
console.log('range, angle, missing/invalid values, legacy rows, size summary and CSV/JSON: OK');

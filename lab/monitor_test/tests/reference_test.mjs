// Actual formula and tab geometry with synthetic, explicitly verified axes; no CV/physical acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../reference_drones.js', import.meta.url), 'utf8'), ctx);
const { profiles, measure, estimate } = ctx.DroneReferences;
const html = fs.readFileSync(new URL('../gallery.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
for (const name of ['positive', 'equivalentDistance', 'validBounds', 'physicalWidth']) {
  const start = script.indexOf(`function ${name}(`), end = script.indexOf('\nfunction ', start + 1);
  vm.runInContext(script.slice(start, end), ctx);
}
const geometry = { physicalWidth: ctx.physicalWidth, equivalentDistance: ctx.equivalentDistance };
if (process.argv.includes('--estimate-oracle')) {
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(cases.map(c => estimate(profiles.find(p => p.id === c.model_id), c.render, c.distance_cm, c.mm_per_css_px, geometry))));
  process.exit(0);
}
if (process.argv.includes('--oracle')) {
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(cases.map(c => measure(c.profile, c.render, c.distance_cm, c.mm_per_css_px, geometry))));
  process.exit(0);
}
assert.deepEqual(Array.from(profiles, p => Array.from(p.dimensions_mm)), [[578.5, 528.7, 80.5], [590, 530, 200], [500, 419, 60]]);
assert.equal(new Set(profiles.map(p => p.id)).size, 3);
for (const p of profiles) {
  assert.match(p.source, /^https:\/\//);
  assert.equal(p.photos.length, 3);
  for (const photo of p.photos) {
    assert.equal(photo.axis, null); // no verified physical segment was supplied for these real pictures
    assert.equal(measure(p, { photo_id: photo.id, width: photo.width, height: photo.height, scale: 1, visible: true }, 150, 0.25, geometry).equivalent_distance_m, null);
    if (photo.file) assert.ok(fs.existsSync(new URL('../' + photo.file, import.meta.url)));
  }
}
assert.equal(profiles.flatMap(p => p.photos).filter(p => p.file).length, 6);
const profile = { photos: [{ id: 'fixture', file: 'TEST ONLY', width: 1000, height: 500, bounds_px: [100, 50, 400, 200],
  model_confirmed: true, projection_confirmed: true,
  axis: { from: [100, 100], to: [400, 100], real_cm: 57.85, source: 'SYNTHETIC axis — not a real photograph' } }] };
const render = { width: 1000, height: 500, scale: 57.85 / (300 * 0.25), visible: true };
const calc = (p = profile, r = render, d = 150, k = 0.25) => measure(p, r, d, k, geometry);
assert.ok(Math.abs(calc().display_width_cm - 5.785) < 1e-12);
assert.equal(calc().equivalent_distance_m, 15);
assert.equal(calc(profile, { ...render, scale: render.scale / 2 }).equivalent_distance_m, 30);
assert.equal(calc(profile, render, 300).equivalent_distance_m, 30);
// Actual annotated axis, not file width or even bbox width: a vertical axis has its own physical size.
const vertical = structuredClone(profile);
vertical.photos[0].axis = { from: [200, 50], to: [200, 200], real_cm: 28.925, source: 'TEST' };
assert.equal(calc(vertical).equivalent_distance_m, 15);
for (const bad of [null, 0, -1, NaN, Infinity, '0.25']) {
  assert.equal(calc(profile, render, 150, bad).equivalent_distance_m, null);
  assert.equal(calc(profile, render, bad).equivalent_distance_m, null);
}
for (const patch of [{ visible: false }, { width: 900 }, { height: 400 }, { scale: 0 }, { scale: Infinity }]) {
  assert.equal(calc(profile, { ...render, ...patch }).equivalent_distance_m, null);
}
for (const patch of [{ file: null }, { object_complete: false }, { model_confirmed: false }, { projection_confirmed: false }, { bounds_px: null },
  { bounds_px: [-1, 0, 400, 200] }, { axis: null }, { axis: { ...profile.photos[0].axis, real_cm: null } },
  { axis: { ...profile.photos[0].axis, source: '' } }, { axis: { ...profile.photos[0].axis, from: [0, 100] } },
  { axis: { ...profile.photos[0].axis, to: [100, 100] } }]) {
  assert.equal(calc({ photos: [{ ...profile.photos[0], ...patch }] }).equivalent_distance_m, null);
}
assert.equal(calc(profile, { ...render, photo_id: 'missing' }).equivalent_distance_m, null);
console.log('Reference profiles, verified-axis formula (15 m), scale, distance and unavailable geometry: OK');

// Production images now yield labelled estimates only; strict geometry above is still unavailable.
for (const profile of profiles) for (const p of profile.photos) {
  const r = { photo_id: p.id, width: p.width, height: p.height, scale: 1, visible: true };
  const e = estimate(profile, r, 150, 0.25, geometry);
  if (!p.file) { assert.equal(e.equivalent_distance_m, null); continue; }
  assert.ok(e.equivalent_distance_m > 0);
  assert.ok(e.assumption);
  assert.equal(e.display_width_cm, (p.bounds_px[2] - p.bounds_px[0]) * 0.25 / 10);
  assert.equal(estimate(profile, { ...r, scale: 0.5 }, 150, 0.25, geometry).equivalent_distance_m, e.equivalent_distance_m * 2);
  assert.equal(estimate(profile, r, 300, 0.25, geometry).equivalent_distance_m, e.equivalent_distance_m * 2);
  if (p.object_complete === false) assert.match(e.assumption, /Исходник обрезан/);
  for (const bad of [null, 0, -1, NaN, Infinity, '0.25']) {
    assert.equal(estimate(profile, r, 150, bad, geometry).equivalent_distance_m, null);
    assert.equal(estimate(profile, r, bad, 0.25, geometry).equivalent_distance_m, null);
  }
  for (const patch of [{ visible: false }, { width: 900 }, { height: 400 }, { scale: 0 }, { scale: Infinity }, { photo_id: 'missing' }]) {
    assert.equal(estimate(profile, { ...r, ...patch }, 150, 0.25, geometry).equivalent_distance_m, null);
  }
}
console.log('Six local image estimates, silhouette widths, half/double scale, distance and strict isolation: OK');

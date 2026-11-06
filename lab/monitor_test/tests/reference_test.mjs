// Actual formula and tab geometry with synthetic, explicitly verified axes; no CV/physical acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../reference_drones.js', import.meta.url), 'utf8'), ctx);
const { profiles, measure } = ctx.DroneReferences;
const html = fs.readFileSync(new URL('../gallery.html', import.meta.url), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
for (const name of ['positive', 'equivalentDistance', 'validBounds', 'physicalWidth']) {
  const start = script.indexOf(`function ${name}(`), end = script.indexOf('\nfunction ', start + 1);
  vm.runInContext(script.slice(start, end), ctx);
}
const geometry = { physicalWidth: ctx.physicalWidth, equivalentDistance: ctx.equivalentDistance };
assert.deepEqual(Array.from(profiles, p => Array.from(p.dimensions_mm)), [[578.5, 528.7, 80.5], [590, 530, 200], [500, 419, 60]]);
assert.equal(new Set(profiles.map(p => p.id)).size, 3);
for (const p of profiles) {
  assert.match(p.source, /^https:\/\//);
  assert.equal(p.photo.axis, null); // package supplied no verified physical axes
  assert.equal(measure(p, { width: p.photo.width, height: p.photo.height, scale: 1, visible: true }, 150, 0.25, geometry).equivalent_distance_m, null);
  if (p.photo.file) assert.ok(fs.existsSync(new URL('../' + p.photo.file, import.meta.url)));
}
const profile = { photo: { file: 'TEST ONLY', width: 1000, height: 500, bounds_px: [100, 50, 400, 200],
  model_confirmed: true, projection_confirmed: true,
  axis: { from: [100, 100], to: [400, 100], real_cm: 57.85, source: 'SYNTHETIC axis — not a real photograph' } } };
const render = { width: 1000, height: 500, scale: 57.85 / (300 * 0.25), visible: true };
const calc = (p = profile, r = render, d = 150, k = 0.25) => measure(p, r, d, k, geometry);
assert.ok(Math.abs(calc().display_width_cm - 5.785) < 1e-12);
assert.equal(calc().equivalent_distance_m, 15);
assert.equal(calc(profile, { ...render, scale: render.scale / 2 }).equivalent_distance_m, 30);
assert.equal(calc(profile, render, 300).equivalent_distance_m, 30);
// Actual annotated axis, not file width or even bbox width: a vertical axis has its own physical size.
const vertical = structuredClone(profile);
vertical.photo.axis = { from: [200, 50], to: [200, 200], real_cm: 28.925, source: 'TEST' };
assert.equal(calc(vertical).equivalent_distance_m, 15);
for (const bad of [null, 0, -1, NaN, Infinity, '0.25']) {
  assert.equal(calc(profile, render, 150, bad).equivalent_distance_m, null);
  assert.equal(calc(profile, render, bad).equivalent_distance_m, null);
}
for (const patch of [{ visible: false }, { width: 900 }, { height: 400 }, { scale: 0 }, { scale: Infinity }]) {
  assert.equal(calc(profile, { ...render, ...patch }).equivalent_distance_m, null);
}
for (const patch of [{ file: null }, { model_confirmed: false }, { projection_confirmed: false }, { bounds_px: null },
  { bounds_px: [-1, 0, 400, 200] }, { axis: null }, { axis: { ...profile.photo.axis, real_cm: null } },
  { axis: { ...profile.photo.axis, source: '' } }, { axis: { ...profile.photo.axis, from: [0, 100] } },
  { axis: { ...profile.photo.axis, to: [100, 100] } }]) {
  assert.equal(calc({ photo: { ...profile.photo, ...patch } }).equivalent_distance_m, null);
}
console.log('Reference profiles, verified-axis formula (15 m), scale, distance and unavailable geometry: OK');

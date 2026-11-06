// Synthetic operator inputs exercise geometry and persistence, never detector quality or real screen millimetres.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const dir = path.resolve(process.argv[2]);
const exe = process.env.CHROMIUM || execSync('command -v chromium || command -v chromium-browser').toString().trim();
const browser = await chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files'] });
const errors = [];
let recordShot = false;
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());
const results = () => page.evaluate(() => JSON.parse(sessionJson()));
async function open() {
  await page.goto('file://' + path.join(dir, 'gallery.html'));
  await page.waitForFunction(() => /Изображений: 90/.test(document.getElementById('status').textContent));
  await page.check('input[name=mode][value=advanced]');
}
async function calibrate(mm) {
  await page.click('#screenCalibBtn');
  const line = await page.locator('#screenLine').boundingBox();
  assert.equal(line.width, 400);
  await page.fill('#screenLineMm', '0'); await page.click('#applyScreenCalib');
  assert.match(await page.textContent('#screenCalibResult'), /положительную/);
  await page.fill('#screenLabel', 'TEST DISPLAY — synthetic'); await page.fill('#screenLineMm', String(mm)); await page.click('#applyScreenCalib');
  assert.match(await page.textContent('#screenCalibResult'), /Сохранено/);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_screen_calibration.png' });
  await page.keyboard.press('Escape');
  assert.match(await page.textContent('#screenCalibStatus'), /Подтверждена линейкой/);
}
async function record(det, { manual = '', camW = '', camH = '', confidence = '' } = {}) {
  await page.keyboard.press('r'); await page.click(`.det[data-det=${det}]`);
  await page.fill('#recScreenWidth', manual); await page.fill('#recCamW', camW); await page.fill('#recCamH', camH);
  if (det !== 'no_box') await page.fill('#recMaxConf', confidence);
  if (process.env.SHOT && !recordShot) { await page.screenshot({ path: process.env.SHOT + '_screen_record.png' }); recordShot = true; }
  await page.click('#recSave'); assert.ok(await page.isHidden('#record'));
}
await open();
await page.selectOption('#boundImage', 'civ01'); await page.click('#singleImage');
await page.fill('#distance', '150'); await page.fill('#appConf', '50'); await page.selectOption('#scaleMode', 'physical'); await page.fill('#sizes', '3,1');
await page.click('#start'); assert.ok(await page.isVisible('#settings')); // no calibration
await calibrate(100); // 400 CSS px -> 100 mm, independent of DPR 2
await page.click('#start'); assert.ok(await page.isVisible('#settings')); // no operator-confirmed bbox
await page.click('#editBounds');
await page.waitForFunction(() => document.getElementById('boundsCanvas').width > 300 && document.getElementById('boundsCanvas').getContext('2d'));
// Exercise pointer mapping on an aspect-preserving canvas, then restore the actual manifest proposal for geometry checks.
const canvas = await page.locator('#boundsCanvas').boundingBox();
await page.mouse.move(canvas.x + canvas.width * 0.25, canvas.y + canvas.height * 0.25); await page.mouse.down();
await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5); await page.mouse.up();
const manifest = await page.evaluate(() => window.MANIFEST.images.find(m => m.id === 'civ01'));
assert.ok(Math.abs(Number(await page.inputValue('#boundX1')) - manifest.width * 0.25) < 1);
assert.ok(Math.abs(Number(await page.inputValue('#boundY2')) - manifest.height * 0.5) < 1);
for (const [i, id] of ['boundX1', 'boundY1', 'boundX2', 'boundY2'].entries()) await page.fill('#' + id, String(manifest.object_bbox[i]));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_screen_bounds.png' });
await page.click('#saveBounds');
assert.match(await page.textContent('#boundsStatus'), /Подтверждённая ширина/);
await page.fill('#referenceModel', 'TEST CONDITIONAL MODEL'); await page.fill('#referenceWidth', '60');
await page.selectOption('#referenceStatus', 'conditional'); await page.fill('#referenceSource', 'TEST ONLY, not measured');
await page.fill('#repetitions', '10'); await page.fill('#minAttempts', '10'); await page.fill('#stabilityPct', '90');
await page.fill('#k', ''); await page.click('#start');
let session = await results(); const runId = session.trial.run_id;
assert.equal(session.trial.order.length, 20);
assert.equal(session.trial.order[9].attempt, 10);
assert.equal(session.trial.order[10].level, 1);
assert.match(await page.textContent('#geometry'), /30.00 мм.*30.00 м/);
assert.match(await page.textContent('#geometry'), /УСЛОВНЫЙ ЭТАЛОН/);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_screen_geometry.png' });
// Width is the object bbox horizontal extent, not the full photo or its longer side.
const measuredCss = await page.evaluate(() => { const r = document.getElementById('img').getBoundingClientRect(), m = window.MANIFEST.images.find(m => m.id === 'civ01'); return r.width / m.width * (m.object_bbox[2] - m.object_bbox[0]); });
assert.ok(Math.abs(measuredCss - 120) < 0.02); // browser layout rounds CSS geometry to subpixel increments
for (let i = 0; i < 10; i++) {
  await record(i < 9 ? 'box_on_object' : 'no_box', { camW: '12.5', camH: '14', confidence: String(80 + i) });
  if (i < 9) await page.keyboard.press('ArrowRight');
}
session = await results();
const first = session.results.find(r => r.run_id === runId && r.step === 0);
assert.equal(first.screen_object_width_mm, 30); assert.equal(first.screen_width_source, 'screen_calibration');
assert.equal(first.screen_object_width_mm_measured, null); assert.equal(first.screen_calibration.mm_per_css_px, 0.25);
assert.equal(first.equivalent_distance_m, 30); assert.equal(first.reference_status, 'conditional');
assert.equal(first.object_camera_width_px_measured, 12.5); assert.equal(first.object_camera_height_px_measured, 14);
assert.equal(first.object_camera_width_px_expected, null); assert.equal(first.object_camera_height_px_expected, null);
assert.equal(first.object_camera_px_measured, 14); assert.equal(first.camera_measurement_source, 'manual_screenshot');
const group = session.repeat_summary.find(g => g.run_id === runId);
assert.equal(group.checks, 10); assert.equal(group.correct_detections, 9); assert.equal(group.detection_rate, 0.9);
assert.equal(group.confidence_median_pct, 84); assert.equal(group.confidence_known_count, 9); assert.equal(group.stability_met, true);
await page.keyboard.press('ArrowRight');
assert.match(await page.textContent('#geometry'), /10.00 мм.*90.00 м/);
await record('box_on_object', { manual: '12', confidence: '50' });
session = await results(); const manual = session.results.find(r => r.run_id === runId && r.step === 10);
assert.equal(manual.screen_object_width_mm_calculated, 10); assert.equal(manual.screen_object_width_mm_measured, 12);
assert.equal(manual.screen_object_width_mm, 12); assert.equal(manual.equivalent_distance_m, 75);
assert.equal(session.repeat_summary.find(g => g.size_level === 1).stability_met, null); // one success is not a limit
await page.keyboard.press('ArrowRight'); await record('no_box');
session = await results();
assert.equal(session.results.find(r => r.run_id === runId && r.step === 11).screen_object_width_mm, 10); // no manual carry-over
await page.keyboard.press('s');
if (process.env.SHOT) { await page.locator('#summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SHOT + '_screen_summary.png' }); }
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
const csv = fs.readFileSync(await download.path(), 'utf8');
assert.ok(csv.includes('screen_calibration')); assert.ok(csv.includes('""mm_per_css_px"":0.25'));
if (process.env.SCREEN_CSV) fs.writeFileSync(process.env.SCREEN_CSV, csv);
// Historical snapshots survive edits to the saved bbox. New attempts do not use a silently changed object.
await page.click('#editBounds'); await page.fill('#boundX2', String(manifest.object_bbox[2] - 10)); await page.click('#saveBounds');
assert.deepEqual((await results()).trial.settings.object_bounds.civ01.bbox, manifest.object_bbox);
assert.notDeepEqual((await results()).object_bounds.civ01.bbox, manifest.object_bbox);
// A screen/environment change makes the old scale unusable, even if the window later returns to its original size.
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForFunction(() => /повторный замер/.test(document.getElementById('screenCalibStatus').textContent));
assert.match(await page.textContent('#screenCalibStatus'), /повторный замер/);
await page.setViewportSize({ width: 1280, height: 800 });
assert.match(await page.textContent('#screenCalibStatus'), /повторный замер/);
await page.click('#resume'); assert.ok(await page.isVisible('#settings'));
await calibrate(120); await page.click('#resume'); assert.ok(await page.isVisible('#settings')); // old run cannot adopt a new calibration
await page.reload(); await page.waitForFunction(() => /Изображений: 90/.test(document.getElementById('status').textContent));
assert.match(await page.textContent('#screenCalibStatus'), /повторный замер/);
assert.match(await page.textContent('#boundsStatus'), /Подтверждённая/);
// Transfer to a different DPR/display: imported result snapshots stay intact, but the scale is unconfirmed.
const transfer = '/private/tmp/drone-monitor-screen-session.json'; fs.writeFileSync(transfer, JSON.stringify(session));
const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const other = await otherContext.newPage(); other.on('dialog', d => d.accept()); other.on('pageerror', e => errors.push(String(e)));
await other.goto('file://' + path.join(dir, 'gallery.html'));
await other.setInputFiles('#importJson', transfer);
await other.waitForFunction(() => JSON.parse(localStorage.getItem('dronecv66v2.results') || '[]').length === 12);
assert.match(await other.textContent('#screenCalibStatus'), /повторный замер/);
const imported = await other.evaluate(() => JSON.parse(sessionJson()));
assert.equal(imported.results[0].equivalent_distance_m, 30);
assert.deepEqual(imported.object_bounds.civ01.bbox, manifest.object_bbox);
await other.check('input[name=mode][value=advanced]');
await other.click('#screenCalibBtn'); await other.fill('#screenLineMm', '200'); await other.click('#applyScreenCalib'); await other.keyboard.press('Escape');
assert.match(await other.textContent('#screenCalibStatus'), /0.500000/); // remeasurement, no monitor diagonal assumptions
await other.selectOption('#boundImage', 'civ01'); await other.click('#singleImage'); await other.selectOption('#scaleMode', 'physical');
await other.fill('#sizes', '3'); await other.fill('#distance', '150'); await other.fill('#referenceWidth', '60'); await other.selectOption('#referenceStatus', 'conditional');
await other.click('#start');
assert.match(await other.textContent('#geometry'), /30.00 мм.*30.00 м/);
const otherCss = await other.evaluate(() => { const r = document.getElementById('img').getBoundingClientRect(), m = window.MANIFEST.images.find(m => m.id === 'civ01'); return r.width / m.width * (m.object_bbox[2] - m.object_bbox[0]); });
assert.ok(Math.abs(otherCss - 60) < 0.02); // different CSS/display scale, same measured physical target
// Invalidation first observed by readSettings must still refresh its visible status.
await other.evaluate(() => { Object.defineProperty(window, 'screenX', { value: window.screenX + 100, configurable: true }); readSettings(); });
await other.waitForFunction(() => /повторный замер/.test(document.getElementById('screenCalibStatus').textContent));
await other.keyboard.press('r'); await other.click('.det[data-det=box_on_object]'); await other.click('#recSave');
assert.ok(await other.isVisible('#record'));
assert.match(await other.textContent('#toast'), /Калибровка утратила/);
assert.deepEqual(errors, []);
await otherContext.close(); await context.close(); await browser.close();
console.log('screen calibration, confirmed bbox, widths, conditional reference, repeated trials, CSV/JSON and invalidation: OK');

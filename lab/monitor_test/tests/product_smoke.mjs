// UI regression with synthetic operator responses and a fixture image, never a physical/CV acceptance test.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const dir = path.resolve(process.argv[2]), url = 'file://' + path.join(dir, 'gallery.html');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || execSync('command -v chromium').toString().trim(), args: ['--allow-file-access-from-files'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage(), errors = [], net = [];
page.on('pageerror', e => errors.push(String(e))); page.on('request', r => { if (/^https?:/.test(r.url())) net.push(r.url()); });
let accept = true; page.on('dialog', d => accept ? d.accept() : d.dismiss());
const state = () => page.evaluate(() => JSON.parse(sessionJson()));
async function nav(name) { await page.click(`[data-section=${name}]`); }
async function calibrate(cm) {
  await page.click('#screenCalibBtn'); await page.fill('#screenLineCm', String(cm)); await page.click('#applyScreenCalib');
  await page.keyboard.press('Escape');
}
async function record(det) { await page.keyboard.press('r'); await page.click(`.det[data-det=${det}]`); assert.ok(await page.isHidden('#record')); }
await page.goto(url); await page.waitForFunction(() => /Изображений: 90/.test(document.getElementById('status').textContent));
assert.equal(await page.locator('#mainSetup input[type=number]:visible').count(), 1);
assert.equal(await page.locator('#advanced').evaluate(e => e.open), false);
await nav('results'); assert.match(await page.textContent('#limitStatus'), /Результатов ещё нет/); assert.equal(await page.locator('#limitChart').count(), 0);
await page.click('#helpBtn'); assert.ok(await page.locator('#help').evaluate(e => e.open)); assert.match(await page.textContent('#help'), /Первый запуск/); await page.click('#helpBtn');
await page.setViewportSize({ width: 460, height: 600 }); await page.click('#screenCalibBtn');
const line = await page.locator('#screenLine').boundingBox();
assert.ok(line.x >= 40 && line.x + line.width <= 420 && line.y >= 0 && line.y + line.height <= 600);
assert.equal(await page.locator('#screenLine path').getAttribute('stroke'), '#000');
assert.equal(await page.locator('#screenLine path').getAttribute('d'), 'M0 45H400 M0 12V78 M400 12V78');
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_narrow_line.png' });
await page.fill('#screenLineCm', '10'); await page.click('#applyScreenCalib'); await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForFunction(() => /повторный замер/.test(document.getElementById('screenCalibStatus').textContent));
await calibrate(10); assert.equal((await state()).screen_calibration.mm_per_css_px, 0.25);
await nav('gallery'); await page.fill('#distance', '150'); await page.click('#presetPilot'); await page.click('#start');
const galleryId = (await state()).trial.run_id; await record('no_box'); await page.keyboard.press('s');
await nav('research');
assert.equal(await page.inputValue('#referenceWidth'), '57'); assert.equal(await page.inputValue('#referenceModel'), 'Draganfly Flex FPV 10');
const original = await page.evaluate(() => window.MANIFEST.images.find(m => m.id === 'civ01'));
// The existing fixture is not asserted to depict Flex FPV 10; this tests only the local-upload path.
await page.setInputFiles('#referencePhoto', path.join(dir, original.file));
await page.waitForFunction(() => document.getElementById('referencePhotoStatus').textContent.includes('Сохранён снимок'));
assert.equal(await page.evaluate(() => window.MANIFEST.images.length), 90);
await page.check('#referenceProjection'); await page.click('#prepareReference');
const local = await page.evaluate(() => LOCAL_IMAGES[REFERENCE_IMAGE]);
const bbox = original.object_bbox.map((v, i) => v * (i % 2 ? local.height / original.height : local.width / original.width));
for (const [i, id] of ['boundX1', 'boundY1', 'boundX2', 'boundY2'].entries()) await page.fill('#' + id, String(bbox[i]));
await page.click('#saveBounds');
const report = { schema_version: 1, target_signal_schema_version: 2, device: 'Xiaomi 17 Pro', app_version: 'TEST FIXTURE',
  model: { name: 'YOLO11s', sha256: 'a'.repeat(64), confidence: 0.5, nms_iou: 0.7, input_width: 640, input_height: 640 },
  frames: [{ offset_ms: 0, target_signal: { schema_version: 2, frame_id: 1, status: 'detected', coordinate_space: 'upright_crop_pixels', width: 640, height: 480, center: { x: 320, y: 240 }, confidence: 0.8 } }] };
await page.setInputFiles('#androidSetupJson', { name: 'synthetic-android.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
await page.waitForFunction(() => document.getElementById('androidSetupStatus').textContent.includes('Кадров в файле: 1'));
assert.equal((await state()).results.length, 1); // metadata import cannot fabricate an experiment
await page.locator('#advanced').evaluate(e => e.open = true); await page.fill('#cameraId', 'TEST_BACK_CAMERA');
await page.click('#cameraSetup'); await page.fill('#calibMeasured', '64'); await page.click('#calibApply'); await page.keyboard.press('Escape');
await page.check('#cameraScaleVerified'); await page.check('#independentChecks');
accept = false; await page.click('#startResearch'); assert.equal((await state()).trial.run_id, galleryId); // cancellation respected
accept = true; await page.click('#startResearch');
let session = await state(); const researchId = session.trial.run_id;
assert.notEqual(researchId, galleryId); assert.equal(session.trial.settings.experiment_kind, 'limit'); assert.equal(session.trial.order.length, 120);
assert.equal(session.trial.settings.camera_geometry_verified, true);
assert.match(await page.textContent('#geometry'), /14.25 м/);
// A clipped target and an edited physical reference must not be accepted as this fixed experiment.
await page.evaluate(() => { ui.manual = 100; show(); }); await page.keyboard.press('r'); await page.click('.det[data-det=box_on_object]');
assert.ok(await page.isVisible('#record')); assert.match(await page.textContent('#toast'), /обрезан/); await page.keyboard.press('Escape');
await page.evaluate(() => { ui.manual = 1; show(); }); await page.keyboard.press('r');
await page.locator('#recordAdvanced').evaluate(e => e.open = true); await page.fill('#recDroneWidth', '60'); await page.click('.det[data-det=box_on_object]'); await page.click('#recSave');
assert.match(await page.textContent('#toast'), /Эталон серии зафиксирован/); await page.keyboard.press('Escape'); await page.locator('#recordAdvanced').evaluate(e => e.open = false);
for (let i = 0; i < 40; i++) {
  if (i) await page.keyboard.press('ArrowRight');
  await record(i < 20 ? 'box_on_object' : 'box_elsewhere');
}
session = await state(); let dataset = session.experiments.find(d => d.id === researchId);
assert.equal(dataset.total_checks, 40); assert.equal(dataset.limit.status, 'bracketed'); assert.equal(dataset.limit.min_px, 120);
assert.equal(dataset.limit.max_equivalent_distance_m, 14.25); assert.equal(dataset.limit.n, 20);
assert.equal(dataset.points.find(p => p.size_level === 4).false_positives, 20);
assert.equal(dataset.points.find(p => p.size_level === 6).checked_frame_count, 20); // twenty explicitly confirmed preselected frames, not twenty clips
await page.keyboard.press('s'); await nav('results');
assert.equal(await page.locator('#limitChart circle').count(), 2); assert.match(await page.textContent('#limitStatus'), /120 px/);
assert.equal(await page.locator('#limitChart circle[fill="#f88"]').count(), 1); assert.equal(await page.locator('#limitChart circle[fill="#5db"]').count(), 1);
await page.selectOption('#chartAxis', 'distance'); assert.match(await page.textContent('#limitChart'), /Эквивалентная дальность/);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_result_graph.png' });
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportExperiment')]);
const exported = fs.readFileSync(await download.path(), 'utf8'), exportedData = JSON.parse(exported);
assert.equal(exportedData.results.length, 40); assert.ok(exportedData.experiments[0].chart_camera_svg.includes('<svg'));
assert.ok(Object.keys(exportedData.local_images).length === 1);
// Return to the gallery without losing the physical/camera setup or the saved experiment.
await nav('gallery'); assert.equal((await state()).sample.ids.length, 20);
await page.click('#start');
let current = await page.evaluate(() => byId(T.order[T.index].id));
while (!['civil_quadcopter', 'military_uav', 'uav_payload'].includes(current.category)) { await page.keyboard.press('ArrowRight'); current = await page.evaluate(() => byId(T.order[T.index].id)); }
await page.click('#currentBounds');
for (const [i, id] of ['boundX1', 'boundY1', 'boundX2', 'boundY2'].entries()) await page.fill('#' + id, String(current.object_bbox[i]));
await page.click('#saveBounds');
await page.evaluate(() => { const m = byId(current().id), px = currentTruthWidth(m, T.settings); ui.manual *= 120 / px; show(); });
assert.match(await page.textContent('#geometry'), /считаем коптер шириной 57 см/);
assert.match(await page.textContent('#geometry'), /ранее подтверждённом диапазоне/);
await page.evaluate(() => { ui.manual *= .5; show(); }); assert.match(await page.textContent('#geometry'), /ниже подтверждённого диапазона/);
// Resume/refine research independently of the gallery run; a changed k must not retain independent truth.
await page.keyboard.press('s'); await nav('research'); await page.click('#refineResearch'); // current run is gallery: no mutation
assert.notEqual((await state()).trial.run_id, researchId);
await page.click('#resumeResearch'); await page.keyboard.press('s'); await page.click('#refineResearch');
assert.equal((await state()).trial.order.length, 140); assert.equal((await state()).trial.order.at(-1).level, 5);
await page.keyboard.press('s'); await page.click('#cameraSetup'); await page.fill('#calibMeasured', '32'); await page.click('#calibApply'); await page.keyboard.press('Escape');
await page.click('#resumeResearch');
const clip = { ...report, frames: Array.from({ length: 20 }, (_, i) => ({ offset_ms: i * 100, target_signal: { ...report.frames[0].target_signal, frame_id: i + 1 } })) };
for (let i = 0; i < 2; i++) {
  if (i) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('r'); await page.locator('#diagnosticImport').evaluate(e => e.open = true);
  await page.setInputFiles('#androidJson', { name: 'synthetic-20-correlated-frames.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(clip)) });
  await page.waitForFunction(() => document.getElementById('androidPreview').textContent.includes('Кадров в файле: 20'));
  await page.click('.det[data-det=box_on_object]');
}
const importedCheck = (await state()).results.find(r => r.run_id === researchId && r.step === 120);
assert.equal(importedCheck.camera_size_independent, false); assert.equal(importedCheck.android_frame_count, 20);
assert.equal(importedCheck.checked_frame_count, 1); assert.equal(importedCheck.max_confidence_pct, null);
assert.equal(importedCheck.android_import.raw_confidence_median_pct, 80);
assert.equal((await state()).results.find(r => r.run_id === researchId && r.step === 121).independent_check, false);
await page.keyboard.press('s'); await nav('results'); await page.reload();
await page.waitForFunction(() => /Изображений:/.test(document.getElementById('status').textContent)); await nav('results');
assert.equal(await page.locator('#limitChart circle').count(), 2); assert.match(await page.textContent('#limitStatus'), /120 px/);
// Transfer the independent result set and reference photo into a fresh browser context.
const otherContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const other = await otherContext.newPage(); other.on('dialog', d => d.accept()); other.on('pageerror', e => errors.push(String(e)));
await other.goto(url); await other.setInputFiles('#importJson', { name: 'real-schema-synthetic-results.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
await other.waitForFunction(() => JSON.parse(localStorage.getItem('dronecv66v2.results') || '[]').length === 40);
await other.click('[data-section=results]'); assert.equal(await other.locator('#limitChart circle').count(), 2);
assert.match(await other.textContent('#limitStatus'), /120 px/); assert.equal(await other.evaluate(() => M.filter(m => m.custom).length), 1);
assert.deepEqual(errors, []); assert.deepEqual(net, []);
await otherContext.close(); await ctx.close(); await browser.close();
console.log('product sections, narrow calibration, local reference, 90/20 threshold, persistence, gallery reuse and legacy gallery coexist: OK');

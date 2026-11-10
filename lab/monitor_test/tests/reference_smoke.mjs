// Real browser regressions. Synthetic axis below proves UI arithmetic only, never photo/CV acceptance.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const dir = path.resolve(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || execSync('command -v chromium').toString().trim(), args: ['--allow-file-access-from-files'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await ctx.newPage(), errors = [], requests = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
page.on('dialog', d => d.accept());
const snapshot = () => page.evaluate(() => referenceTab.snapshot());
const session = () => page.evaluate(() => JSON.parse(sessionJson()));
const nav = name => page.click(`[data-section=${name}]`);
async function open() {
  await page.goto('file://' + path.join(dir, 'gallery.html'));
  await page.waitForFunction(() => /Изображений: 90/.test(document.getElementById('status').textContent));
}
await open();
const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(n => n.id));
assert.equal(ids.length, new Set(ids).size, 'new tab must not shadow legacy element IDs');
// Save one real-schema synthetic response first: the new tab must preserve legacy data and exports.
await page.click('#presetPilot'); await page.fill('#distance', '150'); await page.click('#start');
await page.keyboard.press('r'); await page.click('.det[data-det=no_box]'); await page.keyboard.press('s');
const old = await session(); assert.equal(old.results.length, 1); assert.equal(old.sample.ids.length, 20);
await nav('reference');
assert.ok(await page.isVisible('#referenceSection')); assert.ok(await page.isHidden('#advanced'));
assert.ok(await page.isHidden('#zoom')); assert.equal(await page.locator('#referenceDrone option').count(), 4);
assert.equal(await page.locator('#referencePhotoSelect option').count(), 3);
assert.equal(await page.inputValue('#referenceDrone'), 'cabinet_reference');
await page.selectOption('#referenceDrone', 'skydroid_mx330t');
await page.waitForFunction(() => document.getElementById('referenceDisplay').naturalWidth === 416);
assert.equal((await snapshot()).equivalent_distance_m, null);
await page.click('#screenCalibBtn'); await page.fill('#screenLineCm', '10'); await page.click('#applyScreenCalib'); await page.keyboard.press('Escape');
assert.equal((await session()).screen_calibration.mm_per_css_px, 0.25);
assert.equal(await page.inputValue('#referenceRangeMode'), 'approximate');
await page.fill('#referenceScaleNumber', '50');
assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 26.435) < 1e-9);
assert.match(await page.textContent('#referenceReadout'), /≈ 26,44 м/);
assert.match(await page.textContent('#referenceSegmentReadout'), /Номинал не используется/);
assert.ok(Math.abs((await snapshot()).review_segment_display_mm - 23.06309281124342) < 1e-9);
await page.locator('#referenceSegmentReview').evaluate(e => e.open = true);
await page.check('#referenceSegmentToggle');
await page.locator('#settings').evaluate(e => e.scrollTop = 0);
const drawn = await page.locator('#referenceSegmentOverlay line').evaluate(line => {
  const transform = line.getScreenCTM();
  const a = new DOMPoint(Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))).matrixTransform(transform);
  const b = new DOMPoint(Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))).matrixTransform(transform);
  return Math.hypot(b.x - a.x, b.y - a.y);
});
assert.ok(Math.abs(drawn * 0.25 - (await snapshot()).review_segment_display_mm) < 1e-9);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_candidate_motor_segment.png' });
await page.uncheck('#referenceSegmentToggle');
await page.locator('#referenceSegmentReview').evaluate(e => e.open = false);
await page.locator('#settings').evaluate(e => e.scrollTop = 0);

assert.match(await page.textContent('#referenceAssumption'), /не точная дальность/);
await page.click('#referenceHalf');
assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 52.87) < 1e-9);
await page.fill('#distance', '300');
assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 105.74) < 1e-9);
await page.fill('#distance', '150');
for (const id of ['skydroid_mx330t', 'gedz_10_dji', 'unik_sd_10ufp']) {
  await page.selectOption('#referenceDrone', id);
  const photos = await page.locator('#referencePhotoSelect option').evaluateAll(ns => ns.map(n => n.value));
  for (const photo of photos) {
    await page.selectOption('#referencePhotoSelect', photo);
    if (id === 'unik_sd_10ufp') { assert.equal((await snapshot()).equivalent_distance_m, null); continue; }
    await page.waitForFunction(() => { const im = document.getElementById('referenceDisplay'); return im.complete && im.naturalWidth > 0 && !im.classList.contains('hidden'); });
    if (['skydroid_front', 'gedz_oblique', 'gedz_side'].includes(photo)) {
      assert.equal((await snapshot()).equivalent_distance_m, null, photo);
      assert.match(await page.textContent('#referenceAssumption'), /не приравнивается полному габариту/);
    } else {
      assert.ok((await snapshot()).equivalent_distance_m > 0, photo + ': ' + JSON.stringify(await snapshot()) + ' ' + await page.textContent('#referenceIssue'));
      assert.match(await page.textContent('#referenceReadout'), /≈ \d+,\d{2} м/);
    }
  }
}
await page.selectOption('#referenceDrone', 'skydroid_mx330t');
await page.waitForFunction(() => document.getElementById('referenceDisplay').naturalWidth === 416);
await page.selectOption('#referenceRangeMode', 'strict');
assert.equal((await snapshot()).equivalent_distance_m, null);
await page.fill('#referenceScaleNumber', '50');
const width50 = (await snapshot()).display_width_cm; assert.ok(Math.abs(width50 - 3) < 1e-9);
await page.fill('#referenceScaleNumber', '25'); assert.equal((await snapshot()).display_width_cm, width50 / 2);
assert.equal((await snapshot()).equivalent_distance_m, null); // passport size never unlocks uncertain axes
// Every supplied photo has an individual entry. Six are local; all three missing UNIK originals stay explicit.
const expectedModels = [
  ['skydroid_mx330t', '578.5 × 528.7 × 80.5', ['skydroid_top', 'skydroid_front', 'skydroid_oblique_candidate']],
  ['unik_sd_10ufp', '590 × 530 × 200', ['unik_near_top', 'unik_oblique_a', 'unik_oblique_b']],
  ['gedz_10_dji', '500 × 419 × 60', ['gedz_top', 'gedz_oblique', 'gedz_side']]
];
for (const [id, dimensions, photos] of expectedModels) {
  await page.selectOption('#referenceDrone', id);
  assert.match(await page.textContent('#referenceDimensions'), new RegExp(dimensions));
  assert.equal(await page.locator('#referencePhotoSelect option').count(), 3);
  for (const photoId of photos) {
    await page.selectOption('#referencePhotoSelect', photoId);
    const metadata = await page.evaluate(id => DroneReferences.profiles.flatMap(p => p.photos).find(p => p.id === id), photoId);
    if (metadata.file) {
      await page.waitForFunction(({ file, width }) => {
        const im = document.getElementById('referenceDisplay');
        return im.complete && im.currentSrc === new URL(file, document.baseURI).href && im.naturalWidth === width;
      }, metadata);
      assert.ok(await page.isVisible('#referenceDisplay'));
    } else {
      assert.ok(await page.isVisible('#referenceMissing'));
      assert.equal(await page.getAttribute('#referenceDisplay', 'src'), null);
      assert.match(await page.textContent('#referenceIssue'), /525/);
    }
    assert.equal((await snapshot()).photo_id, photoId);
    assert.equal((await snapshot()).equivalent_distance_m, null);
  }
}
await page.selectOption('#referenceDrone', 'gedz_10_dji');
await page.waitForFunction(() => document.getElementById('referenceDisplay').naturalWidth === 800);
assert.match(await page.textContent('#referenceDimensions'), /500 × 419 × 60/);
assert.match(await page.textContent('#referenceIssue'), /размерных линий к фото нет/);
assert.equal((await snapshot()).equivalent_distance_m, null);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_reference_gedz.png' });
await page.selectOption('#referenceDrone', 'unik_sd_10ufp');
assert.ok(await page.isVisible('#referenceMissing')); assert.match(await page.textContent('#referenceIssue'), /525/);
assert.equal((await snapshot()).display_width_cm, null);
assert.match(await page.textContent('#referenceDimensions'), /590 × 530 × 200/);
await page.selectOption('#referenceDrone', 'skydroid_mx330t');
await page.waitForFunction(() => document.getElementById('referenceDisplay').naturalWidth === 416);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_reference_skydroid.png' });
// Only this test temporarily supplies an invented verified axis. Production profiles stay unverified.
await page.evaluate(() => {
  const p = DroneReferences.profiles.find(p => p.id === 'skydroid_mx330t').photos[0];
  p.model_confirmed = p.projection_confirmed = true;
  p.axis = { from: [90, 200], to: [330, 200], real_cm: 57.85, source: 'SYNTHETIC TEST ONLY' };
});
await page.fill('#referenceScaleNumber', String(57.85 / (240 * 0.25) * 100));
assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 15) < 0.002); // actual browser subpixel rounding
await page.click('#referenceHalf'); assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 30) < 0.004);
await page.fill('#distance', '300'); assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 60) < 0.008);
const originalCal = (await snapshot()).calibration_id;
await page.evaluate(() => document.getElementById('invalidateScreen').click());
assert.equal((await snapshot()).equivalent_distance_m, null);
assert.equal((await snapshot()).calibration_id, null);
await page.click('#screenCalibBtn'); await page.fill('#screenLineCm', '20'); await page.click('#applyScreenCalib'); await page.keyboard.press('Escape');
assert.notEqual((await snapshot()).calibration_id, originalCal);
assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 30) < 0.004);
await page.click('#screenCalibBtn'); await page.fill('#screenLineCm', '10'); await page.click('#applyScreenCalib'); await page.keyboard.press('Escape');
assert.ok(Math.abs((await snapshot()).equivalent_distance_m - 60) < 0.008);
// A target clipped by the scroll panel is not fully displayed even if its own viewport is inside the window.
await page.locator('#referenceSection details:not(#referenceSegmentReview)').evaluate(e => e.open = true);
const clipped = await page.evaluate(() => {
  const panel = document.getElementById('settings'), image = document.getElementById('referenceDisplay');
  panel.style.maxHeight = '500px'; // ensure enough scroll range without invalidating the calibrated window
  const p = DroneReferences.profiles.find(p => p.id === 'skydroid_mx330t').photos[0], r = image.getBoundingClientRect(), c = panel.getBoundingClientRect();
  panel.scrollTop += r.top + p.bounds_px[1] * r.width / p.width - (c.top - 5);
  return image.getBoundingClientRect().top + p.bounds_px[1] * r.width / p.width < c.top;
});
assert.ok(clipped); assert.equal((await snapshot()).equivalent_distance_m, null);
await page.locator('#settings').evaluate(e => { e.style.maxHeight = ''; e.scrollTop = 0; });
await page.locator('#referenceSection details:not(#referenceSegmentReview)').evaluate(e => e.open = false);
assert.ok((await snapshot()).equivalent_distance_m > 0);
await page.fill('#distance', ''); assert.equal((await snapshot()).equivalent_distance_m, null);
await page.fill('#distance', '150');
await page.fill('#referenceScaleNumber', '200'); assert.equal((await snapshot()).equivalent_distance_m, null); // clipped object
await page.fill('#referenceScaleNumber', '25');
// Changing photo drops a previously valid fixture immediately; no old metres survive into the other view.
await page.selectOption('#referencePhotoSelect', 'skydroid_front');
assert.equal((await snapshot()).equivalent_distance_m, null);
await page.selectOption('#referencePhotoSelect', 'skydroid_top');
await page.waitForFunction(() => document.getElementById('referenceDisplay').naturalWidth === 416);
assert.ok((await snapshot()).equivalent_distance_m > 0);
const stable = await snapshot(); await page.fill('#referenceScaleNumber', '0');
assert.equal((await snapshot()).scale_percent, stable.scale_percent);
assert.equal(await page.locator('#referenceScaleNumber').evaluate(e => e.validity.valid), false);
await page.fill('#referenceScaleNumber', '25');
// A drawn rectangle is used only in this test to isolate each model's own physical parameter from photo validity.
await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1000; c.height = 500;
  const drawing = c.getContext('2d'); drawing.fillStyle = '#fff'; drawing.fillRect(0, 0, 1000, 500);
  drawing.fillStyle = '#000'; drawing.fillRect(100, 50, 300, 150);
  for (const model of DroneReferences.profiles) {
    const p = model.photos[0];
    Object.assign(p, { file: c.toDataURL('image/png'), width: 1000, height: 500, bounds_px: [100, 50, 400, 200],
      object_complete: true, model_confirmed: true, projection_confirmed: true,
      axis: { from: [100, 100], to: [400, 100], real_cm: model.dimensions_mm[0] / 10, source: 'SYNTHETIC RECTANGLE — TEST ONLY' } });
  }
});
for (const [model, expected] of [['skydroid_mx330t', 14.4625], ['unik_sd_10ufp', 14.75], ['gedz_10_dji', 12.5]]) {
  await page.selectOption('#referenceDrone', model);
  await page.waitForFunction(() => document.getElementById('referenceDisplay').naturalWidth === 1000);
  await page.fill('#referenceScaleNumber', '80');
  assert.ok(Math.abs((await snapshot()).display_axis_cm - 6) < 1e-9);
  assert.ok(Math.abs((await snapshot()).equivalent_distance_m - expected) < 1e-9);
}
await nav('gallery'); assert.deepEqual((await session()).results, old.results); assert.deepEqual((await session()).trial, old.trial);
await page.click('#presetAll'); assert.equal((await session()).sample.ids.length, 90);
await nav('results'); const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), 'utf8')).results, old.results);
await nav('reference'); await page.selectOption('#referenceDrone', 'gedz_10_dji');
await page.selectOption('#referencePhotoSelect', 'gedz_side'); await page.fill('#referenceScaleNumber', '50');
const cal = (await session()).screen_calibration;
await page.reload(); await nav('reference');
assert.equal(await page.inputValue('#distance'), '150'); assert.equal(await page.inputValue('#referenceDrone'), 'gedz_10_dji');
assert.equal(await page.inputValue('#referencePhotoSelect'), 'gedz_side');
assert.equal(await page.inputValue('#referenceRangeMode'), 'strict');
assert.equal(await page.inputValue('#referenceScaleNumber'), '50');
await page.click('#confirmSavedScreen'); assert.equal((await session()).screen_calibration.id, cal.id);
// Both annotated strokes and contrast labels are within the narrow viewport. No detector is involved.
await page.setViewportSize({ width: 460, height: 600 });
assert.equal((await snapshot()).equivalent_distance_m, null);
await page.click('#screenCalibBtn');
for (const selector of ['#screenLine path', '#screenLine text', '#screenLine rect']) {
  for (const node of await page.locator(selector).all()) {
    const r = await node.boundingBox(); assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 460 && r.y + r.height <= 600);
  }
}
assert.deepEqual(await page.locator('#screenLine text').allTextContents(), ['A', 'B']);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_reference_narrow_ticks.png' });
assert.deepEqual(requests, []); assert.deepEqual(errors, []);
await ctx.close(); await browser.close();
console.log('Reference tab: local assets, blocked geometry, 15 m UI fixture, scaling, distance, reload, calibration, legacy results/90/20/export: OK');

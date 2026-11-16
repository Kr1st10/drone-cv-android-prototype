import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = createRequire(resolve(process.cwd(), 'x.js'))('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.context().on('page', p => p.on('pageerror', error => errors.push(String(error))));
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(pathToFileURL(resolve(process.argv[2], 'gallery.html')).href);
  await page.click('[data-section=reference]');
  await page.click('#screenCalibBtn');
  await page.fill('#screenLineCm', '10');
  await page.click('#applyScreenCalib');
  await page.keyboard.press('Escape');
  await page.fill('#distance', '434');
  const snap = () => page.evaluate(() => referenceTab.snapshot());
  const ready = () => page.waitForFunction(() => referenceTab.snapshot().load_state === 'ready');
  const background = () => page.locator('#referenceViewport').evaluate(e => getComputedStyle(e).backgroundColor);
  const captured = url => JSON.parse(new URLSearchParams(new URL(url).hash.slice(1)).get('stimulus'));
  const run = async () => {
    await page.click('#referenceTrial');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
    assert.equal(await background(), 'rgb(128, 128, 128)');
    assert.equal((await snap()).preview_visible, true);
    const href = await page.locator('#referencePilotLink').getAttribute('href');
    assert.equal(captured(href).asset_sha256, (await snap()).asset_sha256);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
    return href;
  };
  assert.equal(await background(), 'rgb(255, 255, 255)');
  let lastRun;
  const runs = new Map();
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...descriptor,
      set(url) {
        const loaded = this.onload;
        this.onload = event => setTimeout(() => loaded?.call(this, event), url.includes('clean_v4_crop') ? 500 : 0);
        descriptor.set.call(this, url);
      }
    });
  });
  for (const number of [2751, 2704, 2755, 2711]) {
    await page.selectOption('#referencePhotoSelect', 'cabinet_img_' + number + '_archive_v4');
    await page.selectOption('#referenceVariant', 'original');
    await ready();
    await page.fill('#referenceTarget', '100');
    await page.click('#referenceApplyTarget');
    const original = await snap();
    assert.equal(await background(), 'rgb(128, 128, 128)');
    const originalRun = await run();
    assert.equal(captured(originalRun).stimulus_variant, 'original');
    runs.set(number + '_original', originalRun);
    await page.selectOption('#referenceVariant', 'clean');
    const loading = await snap();
    assert.equal(loading.load_state, 'loading');
    assert.equal(loading.asset_id, null);
    assert.equal(loading.stimulus_variant, null);
    assert.equal(await page.locator('#referencePilotLink').getAttribute('href'), originalRun);
    await ready();
    const clean = await snap();
    assert.notEqual(clean.asset_sha256, original.asset_sha256);
    assert.equal(clean.source_sha256, original.source_sha256);
    assert.equal(clean.stimulus_variant, 'clean');
    for (const field of ['scale_percent', 'calibration_id', 'image_width_css_px', 'image_height_css_px',
      'review_segment_display_mm', 'equivalent_distance_m', 'background', 'geometry_revision',
      'source_size_px', 'crop_ltrb_px', 'segment_a_source_px', 'segment_b_source_px']) {
      assert.deepEqual(clean[field], original[field], field);
    }
    assert.ok(Math.abs(clean.equivalent_distance_m - 100) < 0.2);
    await page.click('#referenceDouble');
    const double = await snap();
    assert.ok(Math.abs(double.review_segment_display_mm / clean.review_segment_display_mm - 2) < 0.003);
    assert.ok(Math.abs(clean.equivalent_distance_m / double.equivalent_distance_m - 2) < 0.003);
    await page.click('#referenceHalf');
    lastRun = await run();
    assert.equal(captured(lastRun).stimulus_variant, 'clean');
    runs.set(number + '_clean', lastRun);
  }
  // Leave the gallery on the historical geometry. Its saved link must still point at the last actual show.
  await page.selectOption('#referencePhotoSelect', 'cabinet_top');
  assert.equal(await background(), 'rgb(255, 255, 255)');
  assert.equal(await page.locator('#referencePilotLink').getAttribute('href'), lastRun);
  const popup = page.waitForEvent('popup');
  await page.click('#referencePilotLink');
  const pilot = await popup;
  assert.match(await pilot.textContent('#capturedStimulus'), /IMG_2711.*Чистый фон/);
  const frontLink = new URL(runs.get('2751_clean'));
  frontLink.searchParams.set('qa', 'hashchange');
  await pilot.goto(frontLink.href);
  await pilot.waitForFunction(() => document.querySelector('[name=reference]').value === 'IMG_2751');
  const analyze = async () => {
    await pilot.locator('input[name=report]').setInputFiles({
      name: 'synthetic-report.json', mimeType: 'application/json', buffer: Buffer.from('{"schema_version":1,"frames":[]}')
    });
    await pilot.click('button[type=submit]');
    await pilot.waitForFunction(() => !document.querySelector('#result').hidden);
  };
  const download = async id => {
    const event = pilot.waitForEvent('download');
    await pilot.click(id);
    return readFile(await (await event).path(), 'utf8');
  };
  const checkExport = async key => {
    const result = JSON.parse(await download('#json'));
    const expected = captured(runs.get(key));
    assert.equal(expected.asset_revision, 'cabinet_archive_crop_v4');
    assert.equal(expected.projection_confirmed, false);
    assert.equal(expected.geometry_status, 'modelled_approximate');
    assert.ok(expected.stimulus_variant === 'clean' ? expected.mask_revision : expected.mask_revision === null);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(result.conditions[field], value, field);
    const csv = await download('#csv');
    const csvFields = line => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map(cell => cell.replace(/^"|"$/g, '').replaceAll('""', '"'));
    const [headers, cells] = csv.replace(/^\uFEFF/, '').split('\r\n').map(csvFields);
    assert.equal(headers.length, cells.length);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(cells[headers.indexOf(field)], value == null ? '' : Array.isArray(value) ? JSON.stringify(value) : String(value), field);
    }
  };
  await analyze();
  await checkExport('2751_clean');
  for (const key of ['2704_clean', '2755_original', '2755_clean', '2711_original', '2711_clean']) {
    const link = runs.get(key);
    const expected = captured(link);
    await pilot.evaluate(hash => { location.hash = hash; }, new URL(link).hash);
    await pilot.waitForFunction(id => document.querySelector('[name=reference]').value === id &&
      document.querySelector('#result').hidden && !document.querySelector('[name=report]').files.length, expected.reference);
    assert.equal(await pilot.locator('input[name=reference]').getAttribute('readonly'), '');
    await analyze();
    await checkExport(key);
  }
  assert.deepEqual(errors, []);
  console.log('Paired geometry, original/clean decode and fullscreen, hash changes, and captured pilot JSON/CSV: OK');
} finally {
  await browser.close();
}

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
  let pilotRun;
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
  for (const number of [2751, 2704]) {
    await page.selectOption('#referencePhotoSelect', 'cabinet_img_' + number + '_archive_v4');
    await page.selectOption('#referenceVariant', 'original');
    await ready();
    await page.fill('#referenceTarget', '100');
    await page.click('#referenceApplyTarget');
    const original = await snap();
    assert.equal(await background(), 'rgb(128, 128, 128)');
    const originalRun = await run();
    assert.equal(captured(originalRun).stimulus_variant, 'original');
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
    pilotRun = await run();
    assert.equal(captured(pilotRun).stimulus_variant, 'clean');
  }
  for (const [number, roi] of [[2755, '15-03'], [2711, '45-07']]) {
    await page.selectOption('#referencePhotoSelect', 'cabinet_img_' + number + '_archive_v4');
    await ready();
    assert.equal(await page.inputValue('#referenceVariant'), 'original');
    assert.equal(await page.locator('#referenceVariant option[value=clean]').isDisabled(), true);
    assert.match(await page.textContent('#referenceVariantNote'), new RegExp(roi));
  }
  // Switch the live gallery after capture and verify that the saved run exports the prior asset.
  await page.selectOption('#referencePhotoSelect', 'cabinet_top');
  assert.equal(await background(), 'rgb(255, 255, 255)');
  assert.equal(await page.locator('#referencePilotLink').getAttribute('href'), pilotRun);
  const popup = page.waitForEvent('popup');
  await page.click('#referencePilotLink');
  const pilot = await popup;
  assert.match(await pilot.textContent('#capturedStimulus'), /IMG_2704.*Чистый фон/);
  assert.equal(await pilot.locator('input[name=reference]').getAttribute('readonly'), '');
  await pilot.locator('input[name=report]').setInputFiles({
    name: 'synthetic-report.json', mimeType: 'application/json', buffer: Buffer.from('{"schema_version":1,"frames":[]}')
  });
  await pilot.click('button[type=submit]');
  await pilot.waitForFunction(() => !document.querySelector('#result').hidden);
  const download = async id => {
    const event = pilot.waitForEvent('download');
    await pilot.click(id);
    return readFile(await (await event).path(), 'utf8');
  };
  const result = JSON.parse(await download('#json'));
  const expected = captured(pilotRun);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result.conditions[key], value, key);
  const csv = await download('#csv');
  const csvFields = line => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(cell => cell.replace(/^"|"$/g, '').replaceAll('""', '"'));
  const [headers, cells] = csv.replace(/^\uFEFF/, '').split('\r\n').map(csvFields);
  assert.equal(headers.length, cells.length);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(cells[headers.indexOf(key)], value == null ? '' : Array.isArray(value) ? JSON.stringify(value) : String(value), key);
  }
  assert.deepEqual(errors, []);
  console.log('Paired geometry, original/clean decode and fullscreen, unavailable cuts, and captured pilot JSON/CSV: OK');
} finally {
  await browser.close();
}

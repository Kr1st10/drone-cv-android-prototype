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
  const gray = 'neutral_gray_808080_v1';
  const backgrounds = {
    [gray]: { hex: '#808080', rgb: 'rgb(128, 128, 128)' },
    neutral: { hex: '#FFFFFF', rgb: 'rgb(255, 255, 255)' },
    sky: { hex: null, asset: 'reference_assets/sky.svg' }
  };
  const viewport = page.locator('#referenceViewport');
  const selector = page.locator('#referenceBackground');
  const position = () => viewport.evaluate(v => {
    const box = v.getBoundingClientRect();
    const img = v.querySelector('#referenceDisplay').getBoundingClientRect();
    return [img.left - box.left, img.top - box.top];
  });
  const checkBackground = async id => {
    const { color, image } = await viewport.evaluate(v => ({
      color: getComputedStyle(v).backgroundColor, image: getComputedStyle(v).backgroundImage
    }));
    if (id === 'sky') assert.match(image, /reference_assets\/sky\.svg/);
    else assert.deepEqual([color, image], [backgrounds[id].rgb, 'none']);
    const state = await snap();
    assert.equal(state.background, id);
    if (state.source_photo_id) {
      assert.equal(state.background_hex, backgrounds[id].hex);
      assert.equal(state.background_asset, backgrounds[id].asset);
    }
  };
  const pixels = async () => {
    // Sample the transparent margin above the front rotor and a point outside the frame.
    const [x, y] = await position();
    const shot = await viewport.screenshot({ scale: 'css' });
    return page.evaluate(async ({ data, x, y }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [x + 4, x - 4].map(px => Array.from(ctx.getImageData(px, y + 1, 1, 1).data));
    }, { data: shot.toString('base64'), x: Math.floor(x), y: Math.floor(y) });
  };
  const captured = url => JSON.parse(new URLSearchParams(new URL(url).hash.slice(1)).get('stimulus'));
  const currentRun = () => page.locator('#referencePilotLink').getAttribute('href');
  const shows = new Map();
  const run = async (id, sample, key) => {
    await page.click('#referenceTrial');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
    await checkBackground(id);
    assert.equal(await selector.isDisabled(), true);
    assert.equal((await snap()).preview_visible, true);
    if (sample) shows.set(key, await pixels());
    const href = await currentRun();
    const conditions = captured(href);
    assert.equal(conditions.asset_sha256, (await snap()).asset_sha256);
    assert.equal(conditions.background, id);
    assert.equal(conditions.background_hex, backgrounds[id].hex);
    assert.equal(conditions.background_asset, backgrounds[id].asset);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
    assert.equal(await selector.isEnabled(), true);
    return href;
  };
  await checkBackground('neutral');
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
  const previews = new Map();
  for (const number of [2751, 2704, 2755, 2711]) {
    await page.selectOption('#referencePhotoSelect', 'cabinet_img_' + number + '_archive_v4');
    if (number === 2751) {
      assert.equal(await selector.inputValue(), gray);
      assert.equal(await selector.isEnabled(), true);
    }
    await selector.selectOption(gray);
    await page.selectOption('#referenceVariant', 'original');
    await ready();
    await page.fill('#referenceTarget', '100');
    await page.click('#referenceApplyTarget');
    const baseline = await snap();
    const baselinePosition = await position();
    for (const variant of ['original', 'clean']) {
      if (variant === 'clean') {
        await page.selectOption('#referenceVariant', variant);
        const loading = await snap();
        assert.equal(loading.load_state, 'loading');
        assert.equal(loading.asset_id, null);
        assert.equal(loading.stimulus_variant, null);
        assert.equal(await currentRun(), lastRun);
        await ready();
        assert.notEqual((await snap()).asset_sha256, baseline.asset_sha256);
      }
      assert.match(await page.textContent('#referenceBackgroundNote'),
        variant === 'original' ? /только за её краями/ : /в прозрачных областях/);
      for (const id of Object.keys(backgrounds)) {
        const previous = await currentRun();
        await selector.selectOption(id);
        await checkBackground(id);
        assert.equal(await currentRun(), previous);
        const selected = await snap();
        for (const field of ['scale_percent', 'calibration_id', 'image_width_css_px', 'image_height_css_px',
          'review_segment_display_mm', 'equivalent_distance_m', 'geometry_revision', 'source_sha256',
          'source_size_px', 'crop_ltrb_px', 'segment_a_source_px', 'segment_b_source_px']) {
          assert.deepEqual(selected[field], baseline[field], field);
        }
        assert.deepEqual(await position(), baselinePosition);
        assert.ok(Math.abs(selected.equivalent_distance_m - 100) < 0.2);
        const key = number + '_' + variant + '_' + id;
        if (number === 2751) previews.set(key, await pixels());
        lastRun = await run(id, number === 2751, key);
        assert.equal(captured(lastRun).stimulus_variant, variant);
        runs.set(key, lastRun);
      }
    }
    const clean = await snap();
    await page.click('#referenceDouble');
    const double = await snap();
    assert.ok(Math.abs(double.review_segment_display_mm / clean.review_segment_display_mm - 2) < 0.003);
    assert.ok(Math.abs(clean.equivalent_distance_m / double.equivalent_distance_m - 2) < 0.003);
    await page.click('#referenceHalf');
  }
  for (const samples of [previews, shows]) {
    const [original] = samples.get('2751_original_' + gray);
    for (const [id, channel] of [[gray, 128], ['neutral', 255], ['sky', null]]) {
      const [inside, outside] = samples.get('2751_original_' + id);
      const [transparent, around] = samples.get('2751_clean_' + id);
      assert.deepEqual(inside, original);
      assert.deepEqual(around, outside);
      if (channel !== null) assert.deepEqual(transparent, [channel, channel, channel, 255]);
      else assert.ok(transparent[2] > transparent[0], 'visible sky through the clean PNG');
    }
  }
  await page.selectOption('#referencePhotoSelect', 'cabinet_top');
  await checkBackground('neutral');
  assert.equal(await currentRun(), lastRun);
  const popup = page.waitForEvent('popup');
  await page.click('#referencePilotLink');
  const pilot = await popup;
  assert.match(await pilot.textContent('#capturedStimulus'), /IMG_2711.*Чистый фон/);
  const frontLink = new URL(runs.get('2751_clean_' + gray));
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
  await checkExport('2751_clean_' + gray);
  for (const key of ['2704_clean_neutral', '2755_original_sky', '2755_clean_neutral', '2711_original_neutral', '2711_clean_sky']) {
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
  console.log('24 paired shows, rendered backgrounds, frozen conditions and pilot JSON/CSV: OK');
} finally {
  await browser.close();
}

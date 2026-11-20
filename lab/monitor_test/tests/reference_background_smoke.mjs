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
  const forest = 'forest_40_let_pobedy_full_v1';
  const backgrounds = {
    [gray]: { hex: '#808080', rgb: 'rgb(128, 128, 128)' },
    sky: { hex: null, asset: 'reference_assets/sky.svg' },
    neutral: { hex: '#FFFFFF', rgb: 'rgb(255, 255, 255)' },
    [forest]: { hex: null, asset: 'reference_assets/forest_40_let_pobedy_full_v1.jpg' }
  };
  const viewport = page.locator('#referenceViewport');
  const selector = page.locator('#referenceBackground');
  const position = () => viewport.evaluate(v => {
    const box = v.getBoundingClientRect();
    const img = v.querySelector('#referenceDisplay').getBoundingClientRect();
    return [img.left - box.left, img.top - box.top];
  });
  const checkBackground = async id => {
    const { color, image, size } = await viewport.evaluate(v => {
      const style = getComputedStyle(v);
      return { color: style.backgroundColor, image: style.backgroundImage, size: style.backgroundSize };
    });
    if (backgrounds[id].asset) {
      assert.ok(image.includes(backgrounds[id].asset));
      assert.equal(size, id === forest ? 'contain' : 'cover');
    }
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
  const panel = page.locator('#referenceTrialScalePanel');
  const savedTrials = page.locator('#referenceSavedTrials');
  const togglePanel = () => viewport.click({ position: { x: 10, y: 10 } });
  const checkPanelDistance = async state => {
    const distance = state.equivalent_distance_m.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    assert.equal(await panel.locator('#referenceTrialDistance').textContent(), `≈ ${distance} м`);
  };
  const savePoint = async () => {
    await page.click('#referenceTrialSave');
    assert.equal(await page.textContent('#referenceTrialScaleStatus'), 'Сохранено');
    assert.equal((await snap()).trial_phase, 'active');
    return currentRun();
  };
  const checkSummary = async state => {
    const summary = page.locator('#referenceTrialSummary');
    await summary.waitFor({ state: 'visible' });
    const format = n => n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
    assert.equal(await summary.textContent(), `Итог показа · ≈ ${format(state.equivalent_distance_m)} м · масштаб ${format(state.scale_percent)} % · A–B ${format(state.review_segment_display_mm)} мм`);
  };
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
  const photoSize = await page.evaluate(async path => {
    const image = new Image();
    image.src = path;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, backgrounds[forest].asset);
  assert.deepEqual(photoSize, [4000, 3000]);
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
      let white;
      for (const id of Object.keys(backgrounds)) {
        const previous = await currentRun();
        await selector.selectOption(id);
        await checkBackground(id);
        assert.equal(await currentRun(), previous);
        const selected = await snap();
        if (id === 'neutral') white = selected;
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
      await selector.selectOption('neutral');
      await checkBackground('neutral');
      assert.deepEqual(await snap(), white);
      assert.deepEqual(await position(), baselinePosition);
      assert.equal(await currentRun(), lastRun);
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
    for (const [id, channel] of [[gray, 128], ['neutral', 255], ['sky', null], [forest, null]]) {
      const [inside, outside] = samples.get('2751_original_' + id);
      const [transparent, around] = samples.get('2751_clean_' + id);
      assert.deepEqual(inside, original);
      // Subpixel sampling of the photograph can differ by one channel value across screenshots.
      if (id === forest) assert.ok(around.every((value, i) => Math.abs(value - outside[i]) <= 1));
      else assert.deepEqual(around, outside);
      if (channel !== null) assert.deepEqual(transparent, [channel, channel, channel, 255]);
      else if (id === 'sky') assert.ok(transparent[2] > transparent[0], 'visible sky through the clean PNG');
      else {
        assert.notDeepEqual(transparent, [37, 52, 42, 255], 'full forest JPEG visible through clean PNG');
      }
    }
  }
  await selector.selectOption(forest);
  assert.equal(await savedTrials.isHidden(), true);
  await page.click('#referenceTrial');
  await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
  const centeredLink = await currentRun();
  const centeredPosition = await position();
  const centered = await snap();
  for (let press = 0; press < 20; press++) await page.keyboard.press('Shift+ArrowRight');
  const edged = await snap();
  assert.equal(edged.fullscreen_fits, true);
  assert.equal(edged.preview_visible, true);
  assert.ok(edged.position_offset_x_css_px > 64);
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal((await snap()).position_offset_x_css_px, edged.position_offset_x_css_px);
  const edgedLink = await currentRun();
  assert.equal(await panel.isHidden(), true);
  await page.keyboard.press('+');
  await panel.waitFor({ state: 'visible' });
  await page.click('#referenceTrialLarger');
  assert.match(await page.textContent('#referenceTrialScaleStatus'), /не помещается/);
  assert.deepEqual(await snap(), edged);
  assert.equal(await currentRun(), edgedLink);
  await togglePanel();
  assert.equal(await panel.isHidden(), true);
  await page.keyboard.press('Home');
  assert.deepEqual(await position(), centeredPosition);
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  const moved = await snap();
  assert.deepEqual(await position(), [centeredPosition[0] + 48, centeredPosition[1] - 48]);
  assert.equal(moved.review_segment_display_mm, centered.review_segment_display_mm);
  assert.equal(moved.equivalent_distance_m, centered.equivalent_distance_m);
  assert.equal(moved.calibration_id, centered.calibration_id);
  await togglePanel();
  await checkPanelDistance(moved);
  const firstSavedForest = await savePoint();
  await page.keyboard.press('+');
  const larger = await snap();
  assert.equal(larger.scale_percent, moved.scale_percent + 0.5);
  await checkPanelDistance(larger);
  assert.ok(larger.review_segment_display_mm > moved.review_segment_display_mm);
  assert.ok(larger.equivalent_distance_m < moved.equivalent_distance_m);
  assert.equal(larger.calibration_id, moved.calibration_id);
  assert.equal(larger.position_offset_x_css_px, moved.position_offset_x_css_px);
  assert.equal(larger.position_offset_y_css_px, moved.position_offset_y_css_px);
  lastRun = await savePoint();
  assert.equal(captured(centeredLink).position_offset_x_css_px, 0);
  assert.equal(captured(centeredLink).scale_percent, centered.scale_percent);
  assert.equal(captured(lastRun).scale_percent, larger.scale_percent);
  assert.equal(captured(lastRun).position_offset_x_css_px, 48);
  assert.equal(captured(lastRun).position_offset_y_css_px, -48);
  runs.set('2711_clean_' + forest, lastRun);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
  await checkSummary(larger);
  assert.equal((await snap()).scale_percent, larger.scale_percent);
  await selector.selectOption('neutral');
  assert.equal(await currentRun(), lastRun);
  await page.click('#referenceTrial');
  await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
  await checkBackground('neutral');
  await togglePanel();
  await panel.waitFor({ state: 'visible' });
  await panel.waitFor({ state: 'hidden', timeout: 5000 });
  await togglePanel();
  await page.click('#referenceTrialSmaller');
  const smaller = await snap();
  assert.equal(smaller.scale_percent, larger.scale_percent - 0.5);
  await checkPanelDistance(smaller);
  assert.equal(smaller.review_segment_display_mm, moved.review_segment_display_mm);
  await page.click('#referenceTrialLarger');
  const white = await snap();
  assert.equal(white.scale_percent, larger.scale_percent);
  assert.equal(white.review_segment_display_mm, larger.review_segment_display_mm);
  lastRun = await savePoint();
  await page.click('#referenceTrialDone');
  await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
  await checkSummary(white);
  assert.equal(captured(lastRun).background, 'neutral');
  assert.equal(captured(lastRun).scale_percent, white.scale_percent);
  assert.equal(captured(lastRun).position_offset_x_css_px, 48);
  assert.equal(captured(lastRun).position_offset_y_css_px, -48);
  runs.set('2711_clean_neutral_moved', lastRun);
  await page.click('#referenceCenter');
  assert.equal((await snap()).position_offset_x_css_px, 0);
  assert.equal((await snap()).position_offset_y_css_px, 0);
  assert.equal(captured(lastRun).position_offset_x_css_px, 48);

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
  for (const key of ['2704_clean_neutral', '2755_original_sky', '2755_clean_neutral', '2711_original_neutral', '2711_clean_sky', '2711_clean_neutral_moved']) {
    const link = runs.get(key);
    const expected = captured(link);
    await pilot.evaluate(hash => { location.hash = hash; }, new URL(link).hash);
    await pilot.waitForFunction(id => document.querySelector('[name=reference]').value === id &&
      document.querySelector('#result').hidden && !document.querySelector('[name=report]').files.length, expected.reference);
    assert.equal(await pilot.locator('input[name=reference]').getAttribute('readonly'), '');
    await analyze();
    await checkExport(key);
  }
  const forestKey = '2711_clean_' + forest;
  await pilot.evaluate(hash => { location.hash = hash; }, new URL(runs.get(forestKey)).hash);
  await pilot.waitForFunction(() => document.querySelector('[name=background]').value === 'forest_40_let_pobedy_full_v1');
  await analyze();
  await checkExport(forestKey);
  await pilot.close();
  await page.bringToFront();

  await page.selectOption('#referencePhotoSelect', 'cabinet_img_2751_archive_v4');
  await page.selectOption('#referenceVariant', 'clean');
  await ready();
  await selector.selectOption(forest);
  // Measure the distance between the rendered source points using the DOM image rectangle.
  const renderedSegment = () => page.locator('#referenceDisplay').evaluate(img => {
    const { width, height } = img.getBoundingClientRect();
    const state = referenceTab.snapshot();
    return { width, height, mm: Math.hypot(487 * width / 930, 3 * height / 175) * 0.25,
      calibration: state.calibration_id, scale: state.scale_percent };
  });
  for (const target of [100, 127, 10]) {
    await page.fill('#referenceTarget', String(target));
    await page.click('#referenceApplyTarget');
    const preview = await renderedSegment();
    assert.ok(Math.abs(preview.mm - 325 * 4.34 / target) < 0.01);
    await run(forest, false);
    assert.deepEqual(await renderedSegment(), preview);
  }
  const beforeReject = await renderedSegment();
  await page.fill('#referenceTarget', '5');
  await page.click('#referenceApplyTarget');
  assert.match(await page.textContent('#referenceTargetStatus'), /не помещается/);
  assert.deepEqual(await renderedSegment(), beforeReject);
  await page.fill('#referenceTarget', '100');
  await page.click('#referenceApplyTarget');
  for (const background of [forest, 'neutral']) {
    await selector.selectOption(background);
    await page.click('#referenceTrial');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
    const initial = await renderedSegment();
    const initialPosition = await position();
    const firstLink = await currentRun();
    const initialRange = (await snap()).equivalent_distance_m;
    assert.ok(Math.abs(initial.mm - 14.105) < 0.01);
    for (const count of [1, 2]) {
      await page.keyboard.press('+');
      const adjusted = await renderedSegment();
      const state = await snap();
      assert.equal(adjusted.scale, initial.scale + count * 0.5);
      assert.equal(adjusted.calibration, initial.calibration);
      assert.ok(Math.abs(adjusted.mm - initial.mm * (adjusted.scale / initial.scale)) < 0.01);
      assert.ok(Math.abs(state.equivalent_distance_m - 325 * 4.34 / adjusted.mm) < 0.001);
      assert.ok(state.equivalent_distance_m < initialRange);
      console.log(`IMG_2751 ${background} +${count}: ${initial.mm.toFixed(4)} → ${adjusted.mm.toFixed(4)} mm, ${initialRange.toFixed(3)} → ${state.equivalent_distance_m.toFixed(3)} m`);
    }
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    assert.deepEqual(await renderedSegment(), initial);
    assert.deepEqual(await position(), initialPosition);
    assert.equal(captured(firstLink).scale_percent, initial.scale);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
    await checkSummary({ ...(await snap()), review_segment_display_mm: initial.mm });
    assert.deepEqual(await renderedSegment(), initial);
  }
  await page.fill('#referenceScaleNumber', '0.51');
  await page.click('#referenceTrial');
  await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
  await page.keyboard.press('-');
  assert.ok(Math.abs((await snap()).scale_percent - 0.01) < 1e-10);
  await page.keyboard.press('-');
  await panel.waitFor({ state: 'visible' });
  assert.match(await page.textContent('#referenceTrialScaleStatus'), /предел масштаба/);
  assert.ok(Math.abs((await snap()).scale_percent - 0.01) < 1e-10);
  await page.keyboard.press('+');
  assert.equal((await snap()).scale_percent, 0.51);
  await page.click('#referenceTrialDone');
  await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
  await page.reload();
  await page.click('[data-section=reference]');
  await savedTrials.locator('summary').click();
  const savedLinks = savedTrials.locator('li a');
  assert.deepEqual(await savedLinks.evaluateAll(links => links.map(link => link.href)), [
    runs.get('2711_clean_neutral_moved'), runs.get(forestKey), firstSavedForest
  ]);
  assert.match(await savedLinks.nth(0).textContent(), /IMG_2711.*Белый.*A–B/);
  assert.match(await savedLinks.nth(1).textContent(), /IMG_2711.*Лес.*A–B/);
  assert.equal(captured(firstSavedForest).scale_percent, moved.scale_percent);
  assert.deepEqual(errors, []);
  console.log('Paired shows, rendered A–B, saved points and pilot JSON/CSV: OK');
} finally {
  await browser.close();
}

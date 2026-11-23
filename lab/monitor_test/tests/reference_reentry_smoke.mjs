import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = createRequire(resolve(process.cwd(), 'x.js'))('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
const photos = {
  IMG_2751: { projection: 325, dx: 487, dy: 3, width: 930, height: 175 },
  IMG_2704: { projection: 428, dx: 765, dy: 635, width: 1340, height: 1245 },
  IMG_2755: { projection: 426.62077969030366, dx: 558, dy: 10, width: 860, height: 250 },
  IMG_2711: { projection: 427.2614317188982, dx: 789, dy: 116, width: 1329, height: 927 }
};
const pairs = [['original', 'neutral'], ['clean', 'neutral'], ['clean', 'forest_40_let_pobedy_full_v1']];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(pathToFileURL(resolve(process.argv[2], 'gallery.html')).href);
  await page.click('[data-section=reference]');
  await page.click('#screenCalibBtn');
  const ruler = await page.locator('#screenLine').evaluate(line => line.getBoundingClientRect().width);
  await page.fill('#screenLineCm', '10');
  await page.click('#applyScreenCalib');
  await page.keyboard.press('Escape');
  await page.fill('#distance', '434');
  await page.selectOption('#referencePhotoSelect', 'cabinet_img_2751_archive_v4');
  await page.selectOption('#referenceBackground', 'neutral');
  await page.waitForFunction(() => referenceTab.snapshot().load_state === 'ready');

  const viewport = page.locator('#referenceViewport');
  const panel = page.locator('#referenceTrialScalePanel');
  const precision = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
  const saved = href => JSON.parse(new URLSearchParams(new URL(href).hash.slice(1)).get('stimulus'));

  async function press(selector) {
    if (await panel.isHidden()) await viewport.click({ position: { x: 8, y: 8 } });
    await panel.locator(selector).click();
  }
  async function enter() {
    await page.click('#referenceTrial');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'active');
  }
  async function leave(escape = false) {
    if (escape) await page.keyboard.press('Escape');
    else await press('#referenceTrialDone');
    await page.waitForFunction(() => referenceTab.snapshot().trial_phase === 'idle');
  }
  async function target(meters) {
    await page.fill('#referenceTarget', String(meters));
    await page.click('#referenceApplyTarget');
    assert.match(await page.textContent('#referenceTargetStatus'), /Масштаб рассчитан/);
  }
  async function move(direction, index) {
    await press(direction === 1 ? '#referenceTrialNext' : '#referenceTrialPrevious');
    await page.waitForFunction(i => document.querySelector('#referenceTrialSequence').textContent.startsWith(i + '/12'), index);
  }
  async function measure() {
    const { state, width, height, label } = await page.evaluate(() => {
      const { width, height } = document.querySelector('#referenceDisplay').getBoundingClientRect();
      return { state: referenceTab.snapshot(), width, height, label: document.querySelector('#referenceTrialDistance').textContent };
    });
    const p = photos[state.source_photo_id];
    const ab = Math.hypot(p.dx * width / p.width, p.dy * height / p.height) * (100 / ruler);
    const range = p.projection * state.screen_distance_cm / 100 / ab;
    const labelExpected = `≈ ${range.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м`;
    assert.equal(label, labelExpected);
    precision(state.review_segment_display_mm, ab);
    precision(state.equivalent_distance_m, range);
    return { photo: state.source_photo_id, variant: state.stimulus_variant, background: state.background,
      x: state.position_offset_x_css_px, y: state.position_offset_y_css_px, scale: state.scale_percent,
      calibration: state.calibration_id, ab, range, label };
  }
  async function saveExpected(row) {
    await press('#referenceTrialSave');
    assert.equal(await page.textContent('#referenceTrialScaleStatus'), 'Сохранено');
    const values = saved(await page.locator('#referenceSavedTrials li:first-child a').getAttribute('href'));
    precision(values.equivalent_range_m, row.range);
    precision(values.review_segment_display_mm, row.ab);
    assert.deepEqual([values.position_offset_x_css_px, values.position_offset_y_css_px], [row.x, row.y]);
    return values;
  }

  await target(300);
  await enter();
  await press('[data-trial-direction="ArrowRight"]');
  await press('[data-trial-direction="ArrowUp"]');
  const initial = await measure();
  const initialSaved = await saveExpected(initial);
  for (let cycle = 1; cycle <= 12; cycle++) {
    await move(1, 2);
    const second = await measure();
    await leave(cycle % 2 === 0);
    await enter();
    assert.deepEqual(await measure(), second);
    await move(-1, 1);
    const returned = await measure();
    const record = await saveExpected(returned);
    assert.deepEqual(returned, initial, `cycle ${cycle}`);
    assert.deepEqual(record, initialSaved, `saved cycle ${cycle}`);
    console.log(`Cycle ${cycle}: A–B ${returned.ab.toFixed(6)} mm; UI ${returned.label}; saved ${record.equivalent_range_m.toFixed(6)} m`);
  }

  await move(1, 2);
  const base = await measure();
  await press('#referenceTrialLarger');
  const zoomed = await measure();
  assert.ok(zoomed.range < base.range);
  await leave();
  await enter();
  assert.deepEqual(await measure(), zoomed);
  await press('#referenceTrialSmaller');
  assert.deepEqual(await measure(), base, 'opposite steps around reentry return to the series setting');

  await press('#referenceTrialSmaller');
  const smaller = await measure();
  assert.ok(smaller.range > base.range);
  await leave(true);
  await enter();
  await move(-1, 1);
  const changed = await measure();
  assert.ok(Math.abs(changed.range - smaller.range) < 0.25);
  assert.ok(changed.range > initial.range + 1);

  await press('#referenceTrialLarger');
  const larger = await measure();
  await leave();
  await enter();
  await move(1, 2);
  assert.ok(Math.abs((await measure()).range - larger.range) < 0.25);
  await move(-1, 1);
  await leave();

  await target(127);
  await enter();
  const scenes = pairs.flatMap(([variant, background]) => Object.keys(photos).map(photo => [photo, variant, background]));
  for (const [index, scene] of scenes.entries()) {
    if (index) await move(1, index + 1);
    const current = await measure();
    assert.deepEqual([current.photo, current.variant, current.background], scene);
    assert.deepEqual([current.x, current.y], [initial.x, initial.y]);
    assert.equal(current.calibration, initial.calibration);
    assert.ok(Math.abs(current.range - 127) < 0.1);
  }
  await leave();
  await page.fill('#referenceScaleNumber', '10');
  await enter();
  const manual = await measure();
  await move(-1, 11);
  assert.ok(Math.abs((await measure()).range - manual.range) < 0.1);
  await leave();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

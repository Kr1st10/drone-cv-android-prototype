import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import AB from '../motion-ab.js';
import Manual from '../motion-manual.js';
import Report from '../motion-manual-report.js';
import { motionFixture, pilotFixture } from './fixtures/stage4-comparisons.mjs';

const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const lab = path.resolve(process.argv[2]);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drone-stage4-'));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="grey"/></svg>';
const counts = { civil_quadcopter: 5, military_uav: 5, uav_payload: 3, bird: 3, aircraft: 2, negative: 2 };
const photos = Object.entries(counts).flatMap(([category, count], index) => Array.from({ length: count }, (_, i) => ({
  id: category + '-' + i, category, drone: index < 3, label: 'Синтетический снимок',
  file: 'data:image/svg+xml,' + encodeURIComponent(svg), width: 24, height: 24,
  object_bbox: index < 3 ? [2, 2, 22, 22] : null,
})));
const manifest = { version: 1, sha256: 'synthetic-manifest' };
let browser;

try {
  for (const name of await fs.readdir(lab)) {
    if (name === 'gallery.html' || name.endsWith('.js') && name !== 'manifest.js') {
      await fs.copyFile(path.join(lab, name), path.join(dir, name));
    }
  }
  await fs.writeFile(path.join(dir, 'manifest.js'), 'window.MANIFEST = ' + JSON.stringify({
    version: manifest.version, categories: Object.fromEntries(Object.keys(counts).map(key => [key, key])), images: photos,
  }) + '\nwindow.MANIFEST_SHA256 = ' + JSON.stringify(manifest.sha256));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const url = pathToFileURL(path.join(dir, 'gallery.html')).href;
  await page.goto(url);
  await page.click('[data-section=motion]');
  await page.evaluate(async () => {
    MotionGallery.bounds = () => [0, 0, 24, 24];
    await MotionUI.refresh();
  });
  await page.selectOption('#motionTestMode', 'ab');
  await page.click('#abCreate');
  await page.waitForFunction(() => document.querySelector('#abStatus').textContent.includes('Серия сохранена.'));
  assert.equal(await page.evaluate(async () => (await MotionStore.ab()).series[0].manual_selection_rule), Report.POLICY);

  const aa = motionFixture({ AB, Manual, policy: Report.POLICY });
  const ab = motionFixture({ AB, Manual, policy: Report.POLICY, factor: 'ab', id: 'synthetic-ab' });
  const editedId = aa.runs[1].run_id;
  for (const run of aa.runs.slice(0, 2)) {
    run.conditions.distance_cm = 70;
    run.settings_snapshot = structuredClone({
      values: { conditions: run.conditions },
      viewport: run.conditions.viewport,
      plan: { config: run.scenario },
    });
  }
  const originalSetup = aa.series.attempts.find(attempt => attempt.run_id === editedId);
  originalSetup.manual_setup = {
    operator: structuredClone(aa.series.manual_observations.find(entry => entry.run_id === editedId).operator),
    provenance: 'operator',
  };
  const apk = 'a'.repeat(64);
  for (const entry of ab.series.manual_observations) entry.operator.build_id = apk;
  await page.evaluate(async ({ aa, ab }) => {
    const run_id = ab.runs[1].run_id, hash = 'synthetic';
    ab.series.bindings = { [run_id]: hash };
    ab.series.journals.push({ run_id, hash, data: { mode: 'yolo', frames: [], metadata: { git_sha: 'b'.repeat(40) } } });
    ab.series.analyses.push({ run_id, source_hash: hash, result: { timing_status: 'incompatible' } });
    for (const run of [...aa.runs, ...ab.runs]) await MotionStore.save(run);
    await MotionStore.ab({ schema: 'dronecv-motion-ab-workspace-1', mode: 'ab',
      series: [aa.series, ab.series], selected: aa.series.id });
  }, { aa, ab });
  await page.reload();
  await page.click('[data-section=motion]');
  const section = index => page.locator('.manual-pair-report').nth(index);
  await section(0).getByText('Пара 1 · A/A · план AB', { exact: true }).waitFor();
  assert.equal(await section(0).getAttribute('open'), null);
  assert.equal(await section(1).getAttribute('open'), null);
  await section(0).locator(':scope > summary').click();
  assert.equal(await section(1).getAttribute('open'), null);
  await section(0).getByText('A · Журнал отсутствует', { exact: true }).waitFor();
  assert.match(await section(0).textContent(), /Выбраны A: a0000001, B: a0000002/);
  assert.match(await section(0).textContent(), /Известно 6 из 7/);
  const row = index => section(index).getByRole('row').filter({ hasText: 'Незапланированные срывы' }).locator('td');
  assert.deepEqual((await row(0).allTextContents()).slice(1, 4), ['0', '1', '1']);
  await section(0).getByText('Все попытки (3)', { exact: true }).click();
  await section(0).getByText(/a0000003.+Не оценено.+Ранее завершилась.+Проверка повтора/).waitFor();
  assert.match(await section(1).textContent(), /Пара 2 · A\/A · план BA/);
  await section(1).locator(':scope > summary').click();
  assert.deepEqual((await row(1).allTextContents()).slice(1, 4), ['0', 'Не оценено', 'Недоступна']);
  await section(1).getByText('Все попытки (2)', { exact: true }).click();
  await section(1).getByText(/a0000004.+Синтетическая остановка/).waitFor();

  const savedConditions = () => page.evaluate(async ({ seriesId, runId }) => {
    const workspace = await MotionStore.ab();
    const series = workspace.series.find(row => row.id === seriesId);
    const attempt = series.attempts.find(row => row.run_id === runId);
    const [run] = (await MotionStore.list()).filter(row => row.run_id === runId && row.series_id === seriesId);
    return {
      manualSetup: attempt.manual_setup, referenceConditions: run.conditions, referenceSnapshot: run.settings_snapshot,
      observationDistance: series.manual_observations.find(row => row.run_id === runId).operator.distance_cm,
    };
  }, { seriesId: aa.series.id, runId: editedId });
  const beforeEdit = await savedConditions();
  assert.equal(beforeEdit.manualSetup.operator.distance_cm, 70);
  assert.equal(beforeEdit.referenceConditions.distance_cm, 70);
  assert.equal(beforeEdit.referenceSnapshot.values.conditions.distance_cm, 70);
  assert.equal(beforeEdit.observationDistance, 70);
  await section(0).getByRole('button', { name: 'Открыть ручную оценку ' + editedId }).click();
  const form = page.locator('#manualForm');
  await form.getByText('Фактические условия попытки', { exact: true }).click();
  await form.locator('[name=distance_cm]').fill('80');
  await form.getByRole('button', { name: 'Сохранить оценку' }).click();
  await page.locator('#manualStatus').getByText('Сохранено', { exact: true }).waitFor();
  assert.equal(await section(0).getAttribute('open'), '');
  assert.equal(await section(0).locator('details').getAttribute('open'), '');
  assert.deepEqual(await savedConditions(), { ...beforeEdit, observationDistance: 80 });
  const condition = section(0).getByRole('row').filter({
    has: page.getByRole('cell', { name: 'conditions.distance_cm', exact: true }),
  });
  assert.deepEqual(await condition.locator('td').allTextContents(), ['conditions.distance_cm', '70', '80', 'Различается']);
  assert.deepEqual((await row(0).allTextContents()).slice(1, 4), ['0', '1', 'Недоступна']);

  await page.selectOption('#abSeriesSelect', ab.series.id);
  const abSummary = section(0).getByText('Пара 1 · A/B · план AB', { exact: true });
  await abSummary.waitFor();
  assert.equal(await section(0).getAttribute('open'), null);
  await abSummary.click();
  await section(0).getByText(/Расхождение с журналом \(mode\)/).waitFor();
  await section(0).getByText('B · Несовместимая синхронизация', { exact: true }).waitFor();
  assert.match(await section(0).getByText(/Журнал не подтверждает идентичность APK/).textContent(), new RegExp(apk));
  assert.equal(await section(0).getByText(/Расхождение с журналом \(build_id\)/).count(), 0);
  assert.match(await section(0).textContent(), /Пара 1 · A\/B · план AB/);
  assert.deepEqual((await row(0).allTextContents()).slice(1, 4), ['0', '1', '1']);

  await page.click('[data-section=gallery]');
  const sample = await page.evaluate(() => pilotSample());
  const data = pilotFixture(sample.ids.map(id => photos.find(photo => photo.id === id)), manifest, sample);
  const legacyB = { ...data.runs[1], run_id: 'legacy-B', trial: { ...data.runs[1].trial, run_id: 'legacy-B' } };
  const wrongA = { ...data.runs[0], run_id: 'wrong-phone-A', trial: { ...data.runs[0].trial, run_id: 'wrong-phone-A' } };
  const unpaired = { ...data.records[4], run_id: wrongA.run_id, phone: 'another-phone' };
  const legacy = data.records.filter(record => record.run_id === 'synthetic-B').map(record => ({
    ...record, run_id: legacyB.run_id, ...(record === data.records[1] ? { fp_count: 2, fp_max_conf_pct: 50, false_alarm: true } : {}),
  }));
  await page.setInputFiles('#importJson', {
    name: 'synthetic-pilot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: 'dronecv66-session-2', sample, runs: [...data.runs, legacyB, wrongA], results: [...data.records, ...legacy, unpaired],
    })),
  });
  await page.locator('#pilotComparison summary').click();
  await page.selectOption('#pilotRunA', 'synthetic-A');
  await page.selectOption('#pilotRunB', 'synthetic-B');
  const pilot = page.locator('#pilotComparisonResult');
  assert.match(await pilot.getByRole('row').filter({ hasText: 'Снимки с лишней рамкой' }).textContent(),
    /2 из 3 оценённых \(17 не оценено\).*1 из 4 оценённых \(16 не оценено\).*B−A: -2/s);
  assert.match(await pilot.getByRole('row').filter({ hasText: 'Пропущенные дроны' }).textContent(), /1 из 3.*B−A: 1/s);
  const first = data.records[0].image_id;
  const changed = pilot.getByRole('row').filter({ hasText: 'Открыть ' + first });
  assert.match(await changed.textContent(), /Правильная: да · лишняя: да/);
  await pilot.getByRole('button', { name: 'Открыть ' + first, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#pilotPhotoImage').naturalWidth === 24);
  assert.match(await page.locator('#pilotPhotoTitle').textContent(), new RegExp(first));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#pilotPhoto').isVisible(), false);

  await page.selectOption('#pilotRunB', legacyB.run_id);
  assert.match(await changed.textContent(), /лишняя: не оценено.*Рамок нет.*fp_count/);
  assert.match(await pilot.getByRole('row').filter({ hasText: 'Снимки с лишней рамкой' }).textContent(),
    /1 из 3 оценённых.*A 1\/1, B 0\/1, B−A: -1/s);
  await page.selectOption('#pilotRunA', wrongA.run_id);
  const mismatch = pilot.getByRole('listitem').filter({ hasText: 'phone: план' });
  assert.match(await mismatch.textContent(), new RegExp(unpaired.image_id + '.*phone: план.*another-phone'));
  await mismatch.getByRole('button', { name: 'Открыть ' + unpaired.image_id }).click();
  assert.match(await page.locator('#pilotPhotoTitle').textContent(), new RegExp(unpaired.image_id));
  await page.keyboard.press('Escape');
  assert.equal(await pilot.getByRole('table').count(), 0);

  await page.fill('#distance', '70');
  await page.click('#start');
  await page.keyboard.press('r');
  await page.selectOption('#pilotExtra', 'yes');
  await page.locator('.det[data-det=box_on_object]').click();
  const recorded = await page.evaluate(() => load('results', []).at(-1));
  assert.equal(recorded.detection, 'box_on_object');
  assert.equal(recorded.extra_box_observed, true);
  assert.equal(recorded.false_alarm, true);
  assert.equal(recorded.fp_count, null);

  await page.keyboard.press('s');
  await page.locator('#advanced > summary').click();
  await page.locator('input[name=mode][value=advanced]').check();
  await page.click('#start');
  await page.keyboard.press('r');
  await page.locator('.det[data-det=box_on_object]').click();
  await page.locator('#recordAdvanced > summary').click();
  await page.fill('#recFp', '2');
  await page.fill('#recFpConf', '50');
  await page.click('#recSave');
  await page.keyboard.press('r');
  assert.equal(await page.inputValue('#recFp'), '2');
  await page.locator('.det[data-det=no_box]').click();
  await page.click('#recSave');
  const replaced = await page.evaluate(() => load('results', []).at(-1));
  assert.equal(replaced.detection, 'no_box');
  assert.equal(replaced.fp_count, null);
  assert.equal(replaced.fp_max_conf_pct, null);
  assert.equal(replaced.false_alarm, false);
  assert.equal(replaced.extra_box_observed, undefined);

  const droneIndex = sample.ids.findIndex(id => photos.find(photo => photo.id === id).drone);
  const shot = sample.ids[droneIndex];
  async function startScaleRun() {
    await page.click('#start');
    return page.evaluate(index => {
      if (index > 0) go(index);
      return T.run_id;
    }, droneIndex);
  }
  async function saveScaleAnswer() {
    await page.keyboard.press('r');
    await page.locator('.det[data-det=box_on_object]').click();
    await page.click('#recSave');
    return page.evaluate(() => load('results', []).at(-1));
  }
  await page.keyboard.press('s');
  await page.selectOption('#scaleMode', 'monitor');
  await page.fill('#sizes', '32');
  const enlargedRun = await startScaleRun();
  await page.keyboard.press('=');
  const enlarged = await saveScaleAnswer();
  assert.equal(enlarged.image_id, shot);
  assert.equal(enlarged.size_level, 32);
  assert.equal(enlarged.object_monitor_px, 35.2);
  await page.keyboard.press('s');
  const emptyRun = await startScaleRun();
  await page.keyboard.press('s');
  await page.selectOption('#pilotRunA', enlargedRun);
  await page.selectOption('#pilotRunB', emptyRun);
  const sizeMismatch = pilot.getByRole('listitem').filter({ hasText: /план 32 px монитора, запись 35,2 px монитора/ });
  await sizeMismatch.getByRole('button', { name: 'Открыть ' + shot }).click();
  assert.match(await page.locator('#pilotPhotoTitle').textContent(), new RegExp(shot));
  await page.keyboard.press('Escape');

  await page.selectOption('#scaleMode', 'native');
  await page.fill('#scaleFactor', '0.333333');
  const nativeRuns = [];
  for (let i = 0; i < 2; i++) {
    nativeRuns.push(await startScaleRun());
    assert.equal((await saveScaleAnswer()).display_scale, 0.33333);
    await page.keyboard.press('s');
  }
  await page.selectOption('#pilotRunA', nativeRuns[0]);
  await page.selectOption('#pilotRunB', nativeRuns[1]);
  assert.equal(await pilot.getByText('Парное сравнение недоступно.').count(), 0);
  assert.match(await pilot.getByRole('row').filter({ hasText: 'Правильные обнаружения дрона' }).textContent(), /A 1\/1, B 1\/1, B−A: 0/);
  assert.deepEqual(errors, []);
  console.log('PASS synthetic A/A without journal, A/B with incompatible sync, incomplete BA and static pilot with missing records');
} finally {
  await browser?.close();
  await fs.rm(dir, { recursive: true, force: true });
}

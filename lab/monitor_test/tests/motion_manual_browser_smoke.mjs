import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
const url = pathToFileURL(path.resolve(process.argv[2], 'gallery.html')).href;
const errors = [];
const wait = (page, fn) => page.waitForFunction(fn, null, { polling: 25, timeout: 12000 });
const field = (page, name) => page.locator('#manualForm [name="' + name + '"]');
const status = (page, value) => page.waitForFunction(value => document.querySelector('#manualStatus').textContent.includes(value), value, { polling: 25 });
const disk = page => page.evaluate(() => MotionStore.ab());
const payload = (name, text) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const selectedA = page => page.locator('#abResults label').filter({ hasText: 'Вариант A, попытка' }).locator('select');
const setupField = (page, name) => page.locator('#manualSetup [name="' + name + '"]');

async function open(context) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let now = 0, next = 0;
    const callbacks = new Map();
    Object.defineProperty(performance, 'now', { value: () => now });
    requestAnimationFrame = callback => { callbacks.set(++next, callback); return next; };
    cancelAnimationFrame = id => callbacks.delete(id);
    window.tickManual = ms => {
      now += ms;
      const work = [...callbacks.values()];
      callbacks.clear();
      work.forEach(fn => fn(now));
    };
  });
  await page.goto(url);
  await page.click('[data-section=motion]');
  await wait(page, () => !document.querySelector('#abCreate').disabled || window.MotionABUI && !document.querySelector('#motionTestMode').disabled);
  return page;
}

async function run(page, button) {
  await page.bringToFront();
  await page.click(button);
  try {
    await wait(page, () => !!document.fullscreenElement && document.querySelector('#settings').classList.contains('hidden'));
  } catch (error) {
    const status = await page.locator('#abStatus').textContent();
    const motion = await page.locator('#motionStatus').textContent();
    throw Error('Прогон не начался: ' + status + ' / ' + motion, { cause: error });
  }
  await page.evaluate(() => {
    const prior = MotionUI.runs().length;
    for (let i = 0; i < 130 && MotionUI.runs().length === prior; i++) tickManual(1000);
  });
  for (let i = 0; i < 12 && await page.evaluate(() => MotionUI.busy()); i++) {
    await page.evaluate(() => tickManual(100));
    await page.waitForTimeout(150);
  }
  await wait(page, () => !MotionUI.busy());
  const refs = await page.evaluate(() => MotionStore.list());
  assert.equal(refs.at(-1).complete, true);
  return refs.at(-1);
}

async function pickA(page, run) {
  if (await page.locator('#abJournalCompare').getAttribute('open') === null) {
    await page.locator('#abJournalCompare > summary').click();
  }
  await selectedA(page).selectOption(run);
  await page.getByRole('button', { name: 'Ручная оценка A', exact: true }).click();
}

async function download(page, selector) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  return fs.readFileSync(await file.path(), 'utf8');
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await open(context);
  await page.setViewportSize({ width: 390, height: 844 });
  const capture = page.locator('#motionCaptureConditions');
  assert.equal(await capture.getAttribute('open'), null);
  await capture.locator('summary').focus();
  await page.keyboard.press('Space');
  assert.equal(await capture.getAttribute('open'), '');
  const conditions = { setup_id: ['motionSetup', 'fixture desk'], zoom: ['motionZoom', '2x'],
    orientation: ['motionOrientation', 'landscape'], camera_config: ['motionCamera', 'rear'],
    distance_cm: ['motionDistance', '65.5'] };
  for (const [id, value] of Object.values(conditions)) await page.fill('#' + id, value);
  assert.equal(await page.locator('#settings').evaluate(panel => panel.scrollWidth > panel.clientWidth), false);
  await page.reload();
  await page.click('[data-section=motion]');
  assert.equal(await capture.getAttribute('open'), null);
  for (const [id, value] of Object.values(conditions)) assert.equal(await page.inputValue('#' + id), value);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    canvas.getContext('2d').fillRect(10, 10, 76, 76);
    const photo = { id: 'manual-fixture', sha256: 'synthetic', file: canvas.toDataURL(), width: 96, height: 96 };
    MotionGallery.images = () => [photo];
    MotionGallery.bounds = () => [10, 10, 86, 86];
    await MotionUI.refresh(photo.id);
  });
  await page.selectOption('#motionTestMode', 'ab');
  await page.fill('#abPairs', '1');
  await page.click('#abCreate');
  await wait(page, () => !document.querySelector('#abNext').disabled);
  assert.equal(await page.locator('#abSeriesSettings').getAttribute('open'), null);
  await page.locator('#manualSetup summary').click();
  for (const [name, [, value]] of Object.entries(conditions)) {
    assert.equal(await setupField(page, name).inputValue(), value);
  }
  assert.equal(await setupField(page, 'mode').inputValue(), 'yolo');
  assert.equal(await page.locator('#manualConfirmSetup').isChecked(), false);
  await setupField(page, 'build_id').fill('build-fixture');
  await setupField(page, 'settings').fill('{"confidence":0.25}');
  await setupField(page, 'route_visible').check();
  await setupField(page, 'deviations').fill('Условие пилота');
  await page.check('#manualConfirmSetup');

  const staleNext = await open(context);
  await wait(staleNext, () => !document.querySelector('#abNext').disabled);
  await staleNext.locator('#manualSetup summary').click();
  await staleNext.fill('#manualSetup [name=build_id]', 'stale-next');
  await staleNext.check('#manualConfirmSetup');
  assert.match(await staleNext.locator('#abInstruction').textContent(), /Вариант A, попытка 1/);

  const a = await run(page, '#abNext');
  await staleNext.bringToFront();
  await staleNext.click('#abNext');
  await wait(staleNext, () => document.querySelector('#abStatus').textContent.includes('Очередь серии изменилась'));
  assert.equal(await staleNext.evaluate(() => document.fullscreenElement), null);
  assert.equal(await staleNext.locator('#manualConfirmSetup').isChecked(), false);
  assert.match(await staleNext.locator('#abInstruction').textContent(), /Вариант B, попытка 1/);
  assert.equal((await disk(staleNext)).series[0].attempts.length, 1);
  await staleNext.close();
  const aSetup = (await disk(page)).series[0].attempts[0].manual_setup.operator;
  assert.equal(aSetup.build_id, 'build-fixture');
  assert.equal(aSetup.distance_cm, 65.5);
  assert.equal(aSetup.route_visible, true);
  assert.equal(await setupField(page, 'mode').inputValue(), 'yolo_lk');
  assert.equal(await setupField(page, 'build_id').inputValue(), '');
  assert.equal(await page.locator('#manualConfirmSetup').isChecked(), false);
  await pickA(page, a.run_id);
  await field(page, 'drops_status').selectOption('known');
  await field(page, 'drops').fill('0');
  await field(page, 'before_hide').selectOption('false');
  await field(page, 'notes').fill('Частичная оценка');
  await page.getByRole('button', { name: 'Сохранить оценку' }).click();
  await status(page, 'Сохранено');
  assert.equal((await disk(page)).series[0].manual_observations[0].drops.value, 0);

  const noJournal = await download(page, '#manualExport');
  assert.equal(JSON.parse(noJournal).base.series.journals.length, 0);
  const offlineContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const offline = await open(offlineContext);
  await offline.selectOption('#motionTestMode', 'ab');
  await offline.setInputFiles('#abImport', payload('without-journal.json', noJournal));
  await wait(offline, () => document.querySelector('#abStatus').textContent.includes('Серия восстановлена'));
  await pickA(offline, a.run_id);
  assert.equal(await field(offline, 'drops').inputValue(), '0');
  await offlineContext.close();

  const staleRetry = await open(context);
  await wait(staleRetry, () => !document.querySelector('#abRetry').disabled);
  assert.match(await staleRetry.locator('#abRetryInstruction').textContent(), /вариант A, попытка 2/);
  await setupField(page, 'orientation').fill('');
  await setupField(page, 'setup_target').selectOption('1');
  assert.equal(await setupField(page, 'build_id').inputValue(), 'build-fixture');
  assert.equal(await setupField(page, 'settings').inputValue(), '{"confidence":0.25}');
  assert.equal(await setupField(page, 'route_visible').isChecked(), false);
  assert.equal(await setupField(page, 'deviations').inputValue(), '');
  await setupField(page, 'setup_target').selectOption('0');
  assert.equal(await setupField(page, 'orientation').inputValue(), '');
  await setupField(page, 'setup_target').selectOption('1');
  assert.equal(await page.locator('#manualConfirmSetup').isChecked(), false);
  await page.locator('#abRetrySettings > summary').click();
  const repeated = await run(page, '#abRetry');
  assert.equal((await disk(page)).series[0].attempts[1].manual_setup, undefined);
  await staleRetry.bringToFront();
  await staleRetry.locator('#abRetrySettings > summary').click();
  await staleRetry.click('#abRetry');
  await wait(staleRetry, () => document.querySelector('#abStatus').textContent.includes('Очередь серии изменилась'));
  assert.equal(await staleRetry.evaluate(() => document.fullscreenElement), null);
  assert.match(await staleRetry.locator('#abRetryInstruction').textContent(), /вариант A, попытка 3/);
  assert.deepEqual((await disk(staleRetry)).series[0].attempts.map(attempt => [attempt.attempt, attempt.actual_order]), [[1, 1], [2, 2]]);
  await staleRetry.close();
  await pickA(page, repeated.run_id);
  assert.equal(await field(page, 'drops_status').inputValue(), 'unanswered');
  assert.equal(await field(page, 'notes').inputValue(), '');
  assert.equal(await field(page, 'capture').inputValue(), '');
  await pickA(page, a.run_id);
  assert.equal(await field(page, 'drops').inputValue(), '0');
  const originalSeriesId = (await disk(page)).series[0].id;
  await field(page, 'notes').fill('Скрытый черновик');
  await pickA(page, repeated.run_id);
  await page.click('#manualExport');
  const warning = page.locator('#manualExportWarning');
  await warning.getByRole('button', { name: new RegExp(a.run_id) }).click();
  assert.equal(await field(page, 'notes').inputValue(), 'Скрытый черновик');
  assert.equal(await selectedA(page).inputValue(), repeated.run_id);

  const legacy = await page.evaluate(async () => {
    window.legacyImportSentinel = true;
    const series = MotionAB.create({ id: 'legacy-with-open-draft', factor: 'mode', pair_count: 1,
      variants: { A: { value: 'yolo' }, B: { value: 'yolo_lk' } } });
    return JSON.stringify(await MotionAB.exportBundle(series, []));
  });
  await page.setInputFiles('#abImport', payload('legacy.json', legacy));
  await wait(page, () => document.querySelector('#abStatus').textContent.includes('Серия восстановлена'));
  assert.equal(await page.evaluate(() => window.legacyImportSentinel), true);
  assert.deepEqual((await disk(page)).series.find(series => series.id === 'legacy-with-open-draft').manual_observations, []);
  await page.selectOption('#abSeriesSelect', originalSeriesId);
  await page.evaluate(() => MotionABUI.write(() => {}));
  await pickA(page, a.run_id);
  assert.equal(await field(page, 'notes').inputValue(), 'Скрытый черновик');
  await page.getByRole('button', { name: 'Сохранить оценку' }).click();
  await status(page, 'Сохранено');

  await page.evaluate(() => {
    const original = MotionStore.ab;
    MotionStore.ab = async (...args) => {
      if (args.length && !window.pendingManual) {
        window.pendingManual = true;
        await new Promise(resolve => { window.releaseManual = resolve; });
      }
      return original(...args);
    };
  });
  await field(page, 'lap_1').selectOption('violation');
  await field(page, 'capture').selectOption('after_return');
  await field(page, 'after_return').selectOption('true');
  await status(page, 'Есть несохранённые изменения');
  await page.click('#manualExport');
  await status(page, 'Экспорт не включает открытый черновик');
  await field(page, 'notes').fill('После фонового анализа');
  await page.getByRole('button', { name: 'Сохранить оценку' }).click();
  await wait(page, () => !!window.releaseManual);
  assert.equal(await page.locator('#manualStatus').textContent(), 'Сохранение…');
  await page.evaluate(run => {
    const data = { frames: [{ marker: { run_id: run.run_id } }] };
    window.backgroundManual = MotionABUI.capture({ name: 'synthetic.json', raw: JSON.stringify(data), data, points: [] },
      run, { timing_status: 'incompatible', criterion_version: 'motion-scenario-v5' }, () => true);
  }, a);
  await pickA(page, repeated.run_id);
  await page.evaluate(async () => { releaseManual(); await backgroundManual; await MotionABUI.write(() => {}); });
  const intersected = (await disk(page)).series[0];
  assert.equal(intersected.manual_observations[0].run_id, a.run_id);
  assert.equal(intersected.manual_observations[0].notes, 'После фонового анализа');
  assert.equal(intersected.manual_observations[0].laps[0].value, 'violation');
  assert.deepEqual(intersected.manual_observations[0].capture, { status: 'known', value: 'after_return' });
  assert.equal(intersected.analyses[0].result.timing_status, 'incompatible');
  assert.equal(intersected.selections['1:A'], repeated.run_id);
  await pickA(page, a.run_id);
  await page.reload();
  await page.click('[data-section=motion]');
  await pickA(page, a.run_id);
  assert.equal(await field(page, 'notes').inputValue(), 'После фонового анализа');
  assert.equal(await field(page, 'before_hide').inputValue(), 'false');
  assert.equal(await field(page, 'capture').inputValue(), 'after_return');
  assert.equal(await field(page, 'after_return').inputValue(), 'true');

  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === 'settings' && args[1] === 'abSeries') {
        IDBObjectStore.prototype.put = put;
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    };
  });
  await field(page, 'notes').fill('Черновик после сбоя');
  await page.getByRole('button', { name: 'Сохранить оценку' }).click();
  await status(page, 'Оценка осталась в памяти');
  assert.equal((await disk(page)).series[0].manual_observations[0].notes, 'После фонового анализа');
  assert.equal(await field(page, 'notes').inputValue(), 'Черновик после сбоя');
  await pickA(page, repeated.run_id);
  const hiddenFailure = JSON.parse(await download(page, '#manualExport'));
  assert.equal(hiddenFailure.base.series.manual_observations.find(entry => entry.run_id === a.run_id).notes,
    'Черновик после сбоя');
  await pickA(page, a.run_id);
  const exported = await download(page, '#manualExport');
  const bundle = JSON.parse(exported);
  assert.equal(bundle.base.series.manual_observations[0].notes, 'Черновик после сбоя');
  assert.equal(bundle.base.series.analyses[0].result.timing_status, 'incompatible');
  assert.match(await download(page, '#manualCSV'), /"before_hide","known","false"/);

  const clean = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const restored = await open(clean);
  await restored.selectOption('#motionTestMode', 'ab');
  await restored.setInputFiles('#abImport', payload('manual.json', exported));
  await wait(restored, () => document.querySelector('#abStatus').textContent.includes('Серия восстановлена'));
  assert.deepEqual((await disk(restored)).series[0], bundle.base.series);
  await pickA(restored, a.run_id);
  assert.equal(await field(restored, 'notes').inputValue(), 'Черновик после сбоя');
  assert.equal(await field(restored, 'drops').inputValue(), '0');
  assert.equal(await field(restored, 'before_hide').inputValue(), 'false');
  assert.equal(await field(restored, 'capture').inputValue(), 'after_return');
  await restored.setInputFiles('#abImport', payload('manual-again.json', exported));
  await wait(restored, () => document.querySelector('#abStatus').textContent.includes('ID уже существует'));
  assert.deepEqual((await disk(restored)).series[0], bundle.base.series);
  assert.equal((await disk(restored)).series.length, 1);
  const conflicting = await restored.evaluate(async bundle => {
    const { series, runs } = bundle.base;
    series.id = 'conflicting-series';
    series.manual_observations = [];
    for (const run of runs) run.series_id = series.id;
    return JSON.stringify(await MotionManualTransfer.exportBundle(series, runs));
  }, bundle);
  await restored.setInputFiles('#abImport', payload('conflicting-run.json', conflicting));
  await wait(restored, () => document.querySelector('#abStatus').textContent.includes('Конфликт эталона run_id'));
  assert.deepEqual((await disk(restored)).series[0], bundle.base.series);
  assert.equal((await disk(restored)).series.length, 1);
  const originalId = bundle.base.series.id;
  const emptyBundle = (page, id) => page.evaluate(async id => {
    const series = MotionAB.create({ id, factor: 'mode', pair_count: 1,
      variants: { A: { value: 'yolo' }, B: { value: 'yolo_lk' } } });
    return JSON.stringify(await MotionManualTransfer.exportBundle(series, []));
  }, id);
  const importSeries = async (page, id) => {
    await page.setInputFiles('#abImport', payload(id + '.json', await emptyBundle(page, id)));
    await page.waitForFunction(id => document.querySelector('#abSeriesSelect').value === id, id, { polling: 25 });
  };
  const selectSeries = async (page, id) => {
    await page.selectOption('#abSeriesSelect', id);
    await page.evaluate(() => MotionABUI.write(() => {}));
  };
  const peer = await open(clean);
  await importSeries(restored, 'tab-one');
  await importSeries(peer, 'tab-two');
  assert.deepEqual((await disk(peer)).series.map(series => series.id), [originalId, 'tab-one', 'tab-two']);
  assert.ok(await peer.locator('#abSeriesSelect option[value="tab-one"]').count());

  await peer.locator('#manualSetup summary').click();
  await peer.fill('#manualSetup [name=build_id]', 'tab-setup');
  await peer.check('#manualConfirmSetup');
  await selectSeries(peer, 'tab-one');
  assert.equal(await peer.locator('#manualConfirmSetup').isChecked(), false);
  assert.match(await peer.locator('#manualSetup [role=status]').textContent(), /Подтвердите условия заново/);
  await peer.check('#manualConfirmSetup');
  await peer.fill('#manualSetup [name=build_id]', 'edited-setup');
  assert.equal(await peer.locator('#manualConfirmSetup').isChecked(), false);
  await peer.check('#manualConfirmSetup');
  await peer.selectOption('#manualSetup [name=setup_target]', '1');
  await peer.locator('#abRetrySettings > summary').click();
  await peer.fill('#abRetryPair', '2');
  assert.equal(await peer.locator('#manualConfirmSetup').isChecked(), false);
  await peer.fill('#abRetryPair', '1');

  await selectSeries(peer, originalId);
  await pickA(peer, a.run_id);
  await importSeries(restored, 'tab-three');
  await field(peer, 'notes').fill('Оценка из вкладки с устаревшей серией');
  await peer.getByRole('button', { name: 'Сохранить оценку' }).click();
  await wait(peer, () => Array.from(document.querySelector('#abSeriesSelect').options).some(option => option.value === 'tab-three'));
  const afterSave = await disk(peer);
  assert.ok(afterSave.series.some(series => series.id === 'tab-three'));
  assert.equal(afterSave.series.find(series => series.id === originalId).manual_observations[0].notes,
    'Оценка из вкладки с устаревшей серией');

  await peer.reload();
  await peer.click('[data-section=motion]');
  const rival = await open(clean);
  await selectSeries(peer, originalId);
  await pickA(peer, a.run_id);
  await selectSeries(rival, originalId);
  await pickA(rival, a.run_id);
  await field(rival, 'notes').fill('Запись из другой вкладки');
  await rival.getByRole('button', { name: 'Сохранить оценку' }).click();
  await status(rival, 'Сохранено');
  await field(peer, 'notes').fill('Черновик конфликтующей записи');
  await peer.getByRole('button', { name: 'Сохранить оценку' }).click();
  await status(peer, 'изменилась в другой вкладке');
  assert.equal((await disk(peer)).series.find(series => series.id === originalId).manual_observations[0].notes,
    'Запись из другой вкладки');
  assert.equal(JSON.parse(await download(peer, '#manualExport')).base.series.manual_observations[0].notes,
    'Черновик конфликтующей записи');
  assert.deepEqual(errors, []);
  console.log('PASS Chromium manual form, stale launch targets, hidden drafts, legacy import, two-tab conflicts and JSON/CSV');
} finally {
  await browser.close();
}

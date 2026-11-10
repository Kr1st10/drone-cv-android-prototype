// Offline browser integration; simulated timing and operator inputs are not device measurements.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const dir = path.resolve(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage(), errors = [], network = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('request', r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
page.on('dialog', d => d.accept());
await page.addInitScript(() => {
  let time = 0, next = 1; const callbacks = new Map();
  Object.defineProperty(performance, 'now', { value: () => time });
  window.requestAnimationFrame = cb => { const id = next++; callbacks.set(id, cb); return id; };
  window.cancelAnimationFrame = id => callbacks.delete(id);
  window.advanceMotion = ms => { time += ms; const work = [...callbacks.values()]; callbacks.clear(); work.forEach(cb => cb(time)); };
});
await page.goto('file://' + path.join(dir, 'gallery.html'));
await page.waitForFunction(() => /Изображений: 90/.test(document.getElementById('status').textContent), null, { polling: 100 });
await page.click('[data-section=gallery]'); await page.click('#presetPilot'); await page.click('#start');
const previous = await page.evaluate(() => JSON.parse(sessionJson()));
await page.keyboard.press('s'); await page.click('[data-section=motion]');
await page.click('#motionStart'); assert.match(await page.textContent('#motionStatus'), /Не удалось начать/);
const original = await page.evaluate(() => MANIFEST.images.find(m => m.id === 'civ01'));
await page.setInputFiles('#motionUpload', path.join(dir, original.file));
await page.waitForFunction(() => document.querySelector('#motionPhoto').value.startsWith('ref-'), null, { polling: 100 });
const selected = await page.inputValue('#motionPhoto');
const local = await page.evaluate(id => M.find(m => m.id === id), selected);
await page.click('#motionBounds');
const bbox = original.object_bbox.map((v, i) => v * (i % 2 ? local.height / original.height : local.width / original.width));
for (const [i, id] of ['boundX1', 'boundY1', 'boundX2', 'boundY2'].entries()) await page.fill('#' + id, String(bbox[i]));
await page.click('#saveBounds'); assert.match(await page.textContent('#motionPhotoStatus'), /Границы подтверждены/);
for (const [id, value] of Object.entries({ motionSetup: 'test setup', motionZoom: '1x', motionOrientation: 'landscape', motionCamera: 'test camera', motionWidth: '60', motionSpeed: '500', motionAcceleration: '1000' })) await page.fill('#' + id, value);
await page.check('#motionConfirm');
async function start() { if (!(await page.isChecked('#motionConfirm'))) await page.check('#motionConfirm'); await page.click('#motionStart'); await page.waitForFunction(() => document.fullscreenElement === document.getElementById('motionCanvas') && document.getElementById('settings').classList.contains('hidden'), null, { polling: 100 }); }
async function tick(ms) { await page.evaluate(ms => advanceMotion(ms), ms); }
async function finish() { for (let i = 0; i < 100; i++) { if (!(await page.evaluate(() => !!document.fullscreenElement))) break; await tick(500); } await page.waitForFunction(() => !document.fullscreenElement, null, { polling: 100 }); }
async function fullRun() { await start(); await tick(0); await tick(1000); await tick(250); await finish(); }
async function exportJson(id) { const [download] = await Promise.all([page.waitForEvent('download'), page.click(id)]); return JSON.parse(fs.readFileSync(await download.path(), 'utf8')); }
await start(); await tick(0); await tick(1000); await tick(250);
assert.equal(await page.evaluate(() => document.fullscreenElement.id), 'motionCanvas');
assert.ok(await page.evaluate(() => { const c = document.getElementById('motionCanvas'); return c.width > 0 && c.height > 0 && c.getContext('2d').getImageData(16, 16, 1, 1).data[3] === 255; }));
const markerPixels = await page.evaluate(() => { const c = document.getElementById('motionCanvas'), ctx = c.getContext('2d'), m = Math.max(4, Math.round(c.width / 100)), x = 16 + m, y = 16 + m; return Array.from({ length: 80 }, (_, i) => ctx.getImageData(x + (i % 10) * m + Math.floor(m / 2), y + Math.floor(i / 10) * m + Math.floor(m / 2), 1, 1).data[0] < 128 ? 1 : 0); });
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await finish(); const first = await exportJson('#motionExportLast');
assert.equal(first.schema, 'dronecv-motion-run-1'); assert.equal(first.complete, true); assert.equal(first.mode, 'yolo'); assert.equal(first.order, 'AB');
assert.ok(first.samples.some(s => s.visible)); assert.ok(first.samples.some(s => !s.visible));
assert.deepEqual(markerPixels, await page.evaluate(({ run, step }) => Motion.markerBits(run, step), { run: first.run_id, step: 2 })); assert.equal(first.conditions.distance_cm, null);
assert.equal(first.marker.module_px > 0, true); assert.equal(first.calibration_points.length, 4);
await fullRun(); let bundle = await exportJson('#motionExport');
assert.deepEqual(bundle.runs.map(r => r.mode), ['yolo', 'yolo_lk']);
assert.deepEqual(bundle.runs[0].samples.map(({ run_id, ...s }) => s), bundle.runs[1].samples.map(({ run_id, ...s }) => s));
await page.click('#motionNextPair'); await page.check('#motionConfirm');
await fullRun(); await fullRun(); bundle = await exportJson('#motionExport');
assert.equal(bundle.schema, 'dronecv-motion-series-1'); assert.deepEqual(bundle.runs.map(r => r.mode), ['yolo', 'yolo_lk', 'yolo_lk', 'yolo']);
assert.deepEqual(bundle.runs.map(r => r.order), ['AB', 'AB', 'BA', 'BA']);
await page.click('#motionNextPair'); await page.check('#motionConfirm'); await start(); await tick(0); await page.keyboard.press('Escape');
const aborted = await exportJson('#motionExportLast'); assert.equal(aborted.complete, false); assert.ok(aborted.abort_reason); assert.equal(aborted.slot, 1);
await fullRun(); bundle = await exportJson('#motionExport'); assert.equal(bundle.runs.at(-1).slot, 1);
const after = await page.evaluate(() => JSON.parse(sessionJson()));
assert.deepEqual(after.sample, previous.sample); assert.deepEqual(after.results, previous.results); assert.equal(after.trial.run_id, previous.trial.run_id);
assert.deepEqual(errors, []); assert.deepEqual(network, []);
await context.close(); await browser.close();
console.log('motion offline upload, bounds, validation, fullscreen, marker, exports, AB/BA, deterministic timing, abort and gallery preservation: OK');

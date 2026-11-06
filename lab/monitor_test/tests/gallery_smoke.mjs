// Stage 6.6 gallery smoke test (Playwright + local Chromium, file://). Usage: node gallery_smoke.mjs <dir-with-gallery>
// <dir> must contain gallery.html, manifest.js and images/ (python3 fetch_images.py).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright'); // resolve from cwd (node_modules there)
const dir = path.resolve(process.argv[2] || '.');
const exe = process.env.CHROMIUM || execSync('command -v chromium || command -v chromium-browser').toString().trim();
const ok = (c, msg) => { if (!c) { console.error('FAIL: ' + msg); process.exit(1); } console.log('ok - ' + msg); };
const browser = await chromium.launch({ executablePath: exe, args: ['--allow-file-access-from-files'] });
const URL_ = 'file://' + path.join(dir, 'gallery.html');
const PILOT = { civil_quadcopter: 5, military_uav: 5, uav_payload: 3, bird: 3, aircraft: 2, negative: 2 };

async function open(ctx) {
  const page = await ctx.newPage();
  page.dialogs = []; page.on('dialog', d => { page.dialogs.push(d.message()); d.accept(); });
  page.net = []; page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) page.net.push(r.url()); });
  await page.goto(URL_);
  await page.waitForFunction(() => /Изображений: \d+|Не найдено/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  return page;
}
const newCtx = () => browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, acceptDownloads: true }); // = 3840x2160 monitor px
const LSK = 'dronecv66v2.';
const ls = (page, k) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), LSK + k);
const visibleText = page => page.evaluate(() => document.body.innerText);
async function dl(page, sel) { const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); return fs.readFileSync(await d.path(), 'utf8'); }

const ctx = await newCtx();
let page = await open(ctx);
ok(/Изображений: 90/.test(await page.textContent('#status')), 'manifest loaded, all 90 files present');
ok(await page.locator('.catn').count() === 6, '6 per-category count inputs');
ok(await page.isHidden('fieldset.adv') && await page.isHidden('#calibBtn'), 'quick mode by default: advanced parameters hidden');
const catNames = await page.evaluate(() => Object.values(window.MANIFEST.categories));

// ---- pilot preset: fixed sample 5/5/3/3/2/2 ----
await page.click('#presetPilot');
const smp = await ls(page, 'sample');
const cats = await page.evaluate(ids => ids.map(id => window.MANIFEST.images.find(m => m.id === id).category), smp.ids);
const cnt = {}; cats.forEach(c => cnt[c] = (cnt[c] || 0) + 1);
ok(smp.ids.length === 20 && JSON.stringify(cnt, Object.keys(PILOT).sort()) === JSON.stringify(PILOT, Object.keys(PILOT).sort()) && new Set(smp.ids).size === 20, 'pilot preset: 20 unique images, 5/5/3/3/2/2 by category');
ok(/Пилот — 20 фото/.test(await page.textContent('#sampleInfo')) && !(await page.textContent('#sampleInfo')).includes(smp.ids[0]), 'sample info shown without image ids');
// custom counts
await page.fill('.catn[data-cat=civil_quadcopter]', '2'); for (const c of ['military_uav', 'uav_payload', 'bird', 'aircraft']) await page.fill(`.catn[data-cat=${c}]`, '0');
await page.fill('.catn[data-cat=negative]', '1'); await page.fill('#seed', '5'); await page.click('#makeSample');
const custom = await ls(page, 'sample');
ok(custom.ids.length === 3 && custom.ids.filter(i => i.startsWith('civ')).length === 2 && custom.ids.filter(i => i.startsWith('neg')).length === 1, 'custom counts 2/0/0/0/0/1 -> 3 images of those categories');
await page.click('#presetPilot');
ok(JSON.stringify((await ls(page, 'sample')).ids) === JSON.stringify(smp.ids), 'pilot preset is deterministic (same ids again)');
ok(smp.sample_id === 'S0d95e824', 'pilot sample code is the documented S0d95e824 (' + smp.sample_id + ')');
// determinism across computers: fresh browser profile
{ const c2 = await newCtx(); const p2 = await open(c2); await p2.click('#presetPilot');
  ok(JSON.stringify((await ls(p2, 'sample')).ids) === JSON.stringify(smp.ids), 'pilot preset gives the same 20 images in a fresh browser profile'); await p2.close(); await c2.close(); }
await page.reload(); await page.waitForFunction(() => /Изображений/.test(document.getElementById('status').textContent));
ok(JSON.stringify((await ls(page, 'sample')).ids) === JSON.stringify(smp.ids) && /Пилот/.test(await page.textContent('#sampleInfo')), 'sample persists after reload');

// ---- quick run 1x ----
await page.fill('#phone', 'Xiaomi 17T Pro'); await page.selectOption('#zoom', '1x'); await page.fill('#distance', '120');
await page.click('#start');
ok(await page.isHidden('#settings') && await page.isHidden('#hud') && await page.isHidden('#answer'), 'clean display: no settings, captions or answers');
const run1 = await ls(page, 'trial');
ok(JSON.stringify(run1.order.map(o => o.id)) === JSON.stringify(smp.ids) && run1.settings.mode === 'quick', 'run uses exactly the saved sample ids/order');
{ const c = await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('dronecv66v2.trial')); const id = t.order.find(o => !o.id.startsWith('neg')).id;
    return id; }); const i = run1.order.findIndex(o => o.id === c);
  for (let n = 0; n < i; n++) await page.keyboard.press('ArrowRight');
  const q = await page.evaluate(id => { const m = window.MANIFEST.images.find(x => x.id === id), r = document.getElementById('img').getBoundingClientRect(), b = m.object_bbox;
    return { cx: r.left + (b[0] + b[2]) / 2 * r.width / m.width, cy: r.top + (b[1] + b[3]) / 2 * r.height / m.height, s: r.width / m.width, fit: Math.min(innerWidth / m.width, innerHeight / m.height) }; }, c);
  ok(Math.abs(q.cx - 960) < 1 && Math.abs(q.cy - 540) < 1 && Math.abs(q.s - q.fit) < 1e-6, 'quick mode: fit scale, object centred on screen (for 5x)');
  for (let n = 0; n < i; n++) await page.keyboard.press('ArrowLeft'); }
const noLeak = async what => { const t = await visibleText(page); const id = (await ls(page, 'trial')).order[(await ls(page, 'trial')).index].id;
  return !catNames.some(n => t.includes(n)) && !t.includes(id) ? true : (console.error(what, t), false); };
ok(await noLeak('display'), 'no category name / image id on screen during display');
// A before R: no answer, no record dialog
await page.keyboard.press('a');
ok(await page.isHidden('#answer') && await page.isHidden('#record') && /скрыт/.test(await page.textContent('#toast')), 'A before saving shows only a hint, not the answer or the form');
// R: record form without answer
await page.keyboard.press('r');
ok(await page.isVisible('#record') && await page.isVisible('.det[data-det=box_on_object]') && await page.isHidden('#recConf') && await page.isHidden('#recCamPx'), 'R opens quick record form (3 choices, no advanced size/confidence inputs)');
ok(await noLeak('record'), 'record form does not reveal the answer');
ok(await page.isVisible('#recMaxConf'), 'maximum confidence available in quick mode');
for (const value of ['-0.1', '100.1']) {
  await page.fill('#recMaxConf', value); await page.click('.det[data-det=box_on_object]');
  ok(await page.isVisible('#record') && !(await ls(page, 'results'))?.length && await page.isHidden('#answer'), 'out-of-range confidence blocked: ' + value);
}
await page.fill('#recMaxConf', '87.25'); await page.locator('#recMaxConf').blur();
await page.keyboard.press('1');
ok(await page.isHidden('#record'), 'quick mode: key 1 saves immediately');
let r0 = (await ls(page, 'results'))[0];
ok(r0.detection === 'box_on_object' && r0.object_camera_px_measured === null && r0.object_yolo_px === null && r0.object_camera_px_expected === null && r0.fp_count === null && r0.target_conf_pct === null,
  'unmeasured values saved as null (camera px, YOLO px, fp, confidence)');
ok(r0.max_confidence_pct === 87.25, 'choice 1 stores fractional maximum confidence');
ok(r0.camera_zoom === '1x' && r0.distance_cm === 120 && r0.phone === 'Xiaomi 17T Pro' && r0.sample_id === smp.sample_id, 'record has phone, zoom, distance, sample id');
ok(r0.category.startsWith('negative') ? r0.object_monitor_px === null : r0.object_monitor_px > 0, 'object size in monitor px computed by gallery');
await page.keyboard.press('a');
ok(await page.isVisible('#answer') && (await page.textContent('#answer')).includes(await page.evaluate(c => window.MANIFEST.categories[c], r0.category)), 'A after saving shows the correct category');
await page.keyboard.press('ArrowRight');
ok(await page.isHidden('#answer'), 'answer hidden on the next image');
// No boxes must ignore a typed value.
await page.keyboard.press('r'); await page.fill('#recMaxConf', '99'); await page.locator('#recMaxConf').blur(); await page.keyboard.press('3');
ok((await ls(page, 'results')).find(r => r.step === 1).max_confidence_pct === null, 'choice 3 ignores confidence and stores null');
await page.keyboard.press('r'); ok(await page.isHidden('#recMaxConf'), 'choice 3 hides confidence on reopening'); await page.keyboard.press('Escape');
// record the remaining 19 with "3" (no boxes) — operator choices, not real CV results
for (let i = 1; i < 20; i++) { await page.keyboard.press('r'); await page.keyboard.press('3'); if (i < 19) await page.keyboard.press('ArrowRight'); }
await page.keyboard.press('ArrowRight');
ok(/Последнее изображение\. Записано 20 из 20/.test(await page.textContent('#toast')), 'end of run reported');
const res1 = await ls(page, 'results');
ok(res1.length === 20 && res1.every(r => ['TP', 'FN', 'FP', 'TN'].includes(r.result_class)) &&
   res1.filter(r => r.step > 0 && !['civil_quadcopter', 'military_uav', 'uav_payload'].includes(r.category)).every(r => r.result_class === 'TN') &&
   res1.filter(r => r.step > 0 && ['civil_quadcopter', 'military_uav', 'uav_payload'].includes(r.category)).every(r => r.result_class === 'FN') &&
   res1[0].result_class === (['civil_quadcopter', 'military_uav', 'uav_payload'].includes(res1[0].category) ? 'TP' : 'FP'), 'result classes derived after recording (TP/FN/FP/TN)');
// re-record overwrites (no duplicates)
await page.keyboard.press('r'); await page.keyboard.press('2');
await page.keyboard.press('r'); await page.fill('#recMaxConf', '42.5'); await page.locator('#recMaxConf').blur(); await page.keyboard.press('2');
ok((await ls(page, 'results')).find(r => r.step === 19).max_confidence_pct === 42.5, 'choice 2 stores false-box maximum confidence');
ok((await ls(page, 'results')).length === 20, 're-recording a show replaces the previous record');
// persistence
await page.reload(); await page.waitForFunction(() => /Изображений/.test(document.getElementById('status').textContent)); await page.click('#resume');
ok((await ls(page, 'trial')).index === 19 && (await ls(page, 'results')).length === 20, 'run position and results persist after reload');

// ---- repeat same sample with 5x ----
await page.keyboard.press('s'); await page.selectOption('#zoom', '5x');
ok(/Пилот — 20 фото, 5×/.test(await page.textContent('#start')), 'start button names the sample and zoom');
await page.click('#start');
const run2 = await ls(page, 'trial');
ok(run2.run_id !== run1.run_id && JSON.stringify(run2.order.map(o => o.id)) === JSON.stringify(run1.order.map(o => o.id)) && run2.settings.zoom === '5x', '5x run shows exactly the same images in the same order');
await page.keyboard.press('r'); await page.keyboard.press('3'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('r'); await page.keyboard.press('1');
ok((await ls(page, 'results')).find(r => r.run_id === run2.run_id && r.step === 1).max_confidence_pct === null, 'blank confidence stores null for choice 1');

// ---- export ----
await page.keyboard.press('s');
ok((await page.locator('#summary table').first().locator('tr').count()) === 3, 'summary lists both runs');
const csv = (await dl(page, '#exportCsv')).trim().split('\n');
const head = csv[0].split(',');
ok(csv[0] === fs.readFileSync(path.join(dir, 'results_template.csv'), 'utf8').trim() && csv.length === 23, 'CSV header = results_template.csv, 22 rows');
const rows = csv.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
const z1 = rows.filter(r => r.camera_zoom === '1x').map(r => r.image_id), z5 = rows.filter(r => r.camera_zoom === '5x').map(r => r.image_id);
ok(z1.length === 20 && z5.length === 2 && z5.every((id, i) => id === z1[i]), 'CSV: 1x and 5x rows refer to the same images');
ok(rows.every(r => r.object_yolo_px === '' && r.object_camera_px_measured === '' && r.fp_count === ''), 'CSV: unmeasured values are empty (null), not invented');
ok(rows.some(r => r.max_confidence_pct === '87.25') && rows.some(r => r.max_confidence_pct === '42.5') && rows.filter(r => r.detection === 'no_box').every(r => r.max_confidence_pct === ''), 'CSV exports maximum confidence and empty nulls');
const js = JSON.parse(await dl(page, '#exportJson'));
ok(js.format === 'dronecv66-session-2' && JSON.stringify(js.sample.ids) === JSON.stringify(smp.ids) && js.runs.length === 2 && js.results.length === 22, 'JSON export: sample ids, 2 runs, 22 results');
ok(js.results.some(r => r.max_confidence_pct === 87.25) && js.results.some(r => r.max_confidence_pct === 42.5) && js.results.filter(r => r.detection === 'no_box').every(r => r.max_confidence_pct === null), 'JSON exports maximum confidence and nulls');
fs.writeFileSync('/tmp/dronecv66_session.json', JSON.stringify(js));
{ const c3 = await newCtx(); const p3 = await open(c3); await p3.setInputFiles('#importJson', '/tmp/dronecv66_session.json'); await p3.waitForTimeout(500);
  ok(JSON.stringify((await ls(p3, 'sample')).ids) === JSON.stringify(smp.ids) && (await ls(p3, 'results')).length === 22, 'JSON import restores sample and results on another computer');
  ok((await ls(p3, 'results')).some(r => r.max_confidence_pct === 87.25), 'JSON import preserves fractional confidence'); await p3.close(); await c3.close(); }

// Older session results have no maximum-confidence field.
const old = JSON.parse(JSON.stringify(js)); old.results.forEach(r => {
  for (const key of ['max_confidence_pct', 'drone_width_cm', 'drone_width_source', 'screen_object_width_mm', 'object_angular_width_deg', 'equivalent_distance_m']) delete r[key];
}); delete old.size_summary;
fs.writeFileSync('/tmp/dronecv66_session_old.json', JSON.stringify(old));
{ const c = await newCtx(); const p = await open(c); await p.setInputFiles('#importJson', '/tmp/dronecv66_session_old.json');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('dronecv66v2.results') || '[]').length === 22);
  const exported = await p.evaluate(() => JSON.parse(sessionJson()));
  ok(exported.results.every(r => r.max_confidence_pct === null), 'old JSON imports and re-exports with explicit null');
  ok(exported.results.every(r => r.drone_width_cm === null && r.screen_object_width_mm === null && r.equivalent_distance_m === null), 'old JSON has no invented physical sizes or distances');
  await p.evaluate(results => localStorage.setItem('dronecv66v2.results', JSON.stringify(results)), old.results);
  await p.reload();
  ok((await p.evaluate(() => JSON.parse(sessionJson()))).results.every(r => r.max_confidence_pct === null), 'old localStorage results export with null');
  ok((await p.evaluate(() => JSON.parse(sessionJson()))).results.every(r => r.equivalent_distance_m === null), 'old localStorage keeps unknown distance null');
  await p.close(); await c.close(); }

// ---- advanced mode: sizes in three units ----
await page.check('input[name=mode][value=advanced]');
ok(await page.isVisible('fieldset.adv'), 'advanced mode shows extra parameters');
await page.fill('.catn[data-cat=civil_quadcopter]', '3'); for (const c of ['military_uav', 'uav_payload', 'bird', 'aircraft', 'negative']) await page.fill(`.catn[data-cat=${c}]`, '0');
await page.fill('#seed', '1'); await page.click('#makeSample');
await page.selectOption('#scaleMode', 'monitor'); await page.fill('#sizes', '32'); await page.check('#center'); await page.click('#start');
await page.waitForFunction(() => { const i = document.getElementById('img'); return i.complete && i.naturalWidth && !i.style.visibility; });
const sz = await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('dronecv66v2.trial')); const m = window.MANIFEST.images.find(x => x.id === t.order[0].id);
  const r = document.getElementById('img').getBoundingClientRect(), b = m.object_bbox;
  return { px: Math.max(b[2] - b[0], b[3] - b[1]) * r.width / m.width * devicePixelRatio, cx: r.left + (b[0] + b[2]) / 2 * r.width / m.width, cy: r.top + (b[1] + b[3]) / 2 * r.height / m.height }; });
ok(Math.abs(sz.px - 32) < 0.5 && Math.abs(sz.cx - 960) < 1 && Math.abs(sz.cy - 540) < 1, `monitor mode: object 32 monitor px, centred (${sz.px.toFixed(2)})`);
await page.keyboard.press('r');
ok(await page.isVisible('#recConf') && await page.isVisible('#recCamPx'), 'advanced record form has optional confidence / measured size');
await page.keyboard.press('1'); ok(await page.isVisible('#record'), 'advanced: choice does not close the form');
await page.fill('#recMaxConf', '0'); await page.click('#recSave');
ok((await ls(page, 'results')).find(r => r.test_mode === 'advanced').max_confidence_pct === 0, 'zero confidence accepted');
await page.keyboard.press('r'); await page.fill('#recMaxConf', '100'); await page.fill('#recConf', '55'); await page.keyboard.press('Enter');
let ra = (await ls(page, 'results')).find(r => r.test_mode === 'advanced');
ok(ra.max_confidence_pct === 100, '100 percent confidence accepted');
await page.keyboard.press('r'); await page.click('.det[data-det=no_box]');
ok(await page.isHidden('#recMaxConf'), 'advanced choice 3 hides confidence'); await page.click('#recSave');
ok((await ls(page, 'results')).find(r => r.test_mode === 'advanced').max_confidence_pct === null, 'advanced choice 3 stores null');
ok(ra.target_conf_pct === 55 && ra.size_level === 32 && ra.size_level_unit === 'monitor_px' && Math.abs(ra.object_monitor_px - 32) < 0.2 && ra.object_camera_px_expected === null && ra.object_yolo_px === null,
  'advanced, no calibration: monitor px recorded, camera/YOLO px null');
// calibration and camera-px mode
await page.keyboard.press('s'); await page.keyboard.press('c');
const sq = await page.evaluate(() => [...document.querySelectorAll('#calibgrid .sq')].map(e => e.getBoundingClientRect().width * devicePixelRatio));
ok(sq.length === 6 && Math.abs(sq[0] - 512) < 0.5 && Math.abs(sq[5] - 16) < 0.5, 'calibration squares 512..16 monitor px');
await page.fill('#calibMeasured', '64'); await page.click('#calibApply');
ok(Math.abs(parseFloat(await page.inputValue('#k')) - 0.25) < 1e-6, 'calibration k = measured/256');
await page.keyboard.press('c'); await page.selectOption('#scaleMode', 'camera'); await page.fill('#sizes', '16'); await page.click('#start');
await page.waitForFunction(() => { const i = document.getElementById('img'); return i.complete && i.naturalWidth && !i.style.visibility; });
const cam = await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('dronecv66v2.trial')); const m = window.MANIFEST.images.find(x => x.id === t.order[0].id);
  const r = document.getElementById('img').getBoundingClientRect(), b = m.object_bbox; return Math.max(b[2] - b[0], b[3] - b[1]) * r.width / m.width * devicePixelRatio; });
ok(Math.abs(cam - 64) < 0.5, `camera mode: 16 px in frame / k 0.25 = 64 monitor px (${cam.toFixed(2)})`);
await page.keyboard.press('r'); await page.keyboard.press('1'); await page.keyboard.press('Enter');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('r'); await page.keyboard.press('2'); await page.fill('#recCamPx', '20'); await page.keyboard.press('Enter');
const adv = (await ls(page, 'results')).filter(r => r.size_level_unit === 'camera_px');
ok(Math.abs(adv[0].object_camera_px_expected - 16) < 0.2 && Math.abs(adv[0].object_yolo_px - 16) < 0.2 && adv[0].object_yolo_px_source === 'calibration', 'calibrated: camera px 16 -> YOLO px 16 (640x480 frame, 640 input)');
ok(adv[1].object_camera_px_measured === 20 && adv[1].object_yolo_px === 20 && adv[1].object_yolo_px_source === 'measured', 'measured camera px used for YOLO px');
// ---- physical width / equivalent distance: synthetic operator inputs, not CV measurements ----
await page.keyboard.press('s'); await page.fill('#distance', '150'); await page.selectOption('#zoom', '1x'); await page.fill('#appConf', '50'); await page.click('#start');
const physicalRun = await ls(page, 'trial');
await page.keyboard.press('r'); await page.keyboard.press('1');
for (const id of ['recDroneWidth', 'recScreenWidth', 'recCamPx']) {
  await page.fill('#' + id, '0'); await page.click('#recSave');
  ok(await page.isVisible('#record'), 'invalid zero measurement rejected: ' + id); await page.fill('#' + id, '');
}
await page.fill('#recDroneWidth', '60'); await page.fill('#recScreenWidth', '60'); await page.fill('#recCamPx', '16');
await page.fill('#recWidthSource', 'TEST ONLY: measured full width A-B'); await page.fill('#recMaxConf', '80.5'); await page.click('#recSave');
let physical = (await ls(page, 'results')).find(r => r.run_id === physicalRun.run_id);
ok(physical.equivalent_distance_m === 15 && physical.drone_width_cm === 60 && physical.screen_object_width_mm === 60 && physical.distance_cm === 150 && physical.app_conf_threshold_pct === 50, '60 cm / 150 cm / 60 mm -> 15 m with raw inputs and actual threshold');
ok(Math.abs(physical.object_angular_width_deg - 2.291525676350207) < 1e-10, 'angular width computed from measured screen geometry');
await page.keyboard.press('r');
ok(await page.inputValue('#recDroneWidth') === '60' && await page.inputValue('#recScreenWidth') === '60', 'physical measurements restored on re-record');
ok(await page.evaluate(() => { const p = document.getElementById('record'); return p.scrollWidth <= p.clientWidth + 1; }), 'physical record fields fit within panel width');
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '_range_record.png' });
await page.keyboard.press('Escape'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('r');
ok(await page.inputValue('#recDroneWidth') === '' && await page.inputValue('#recScreenWidth') === '', 'no physical dimensions carried to another image');
await page.keyboard.press('3'); await page.fill('#recCamPx', '16'); await page.click('#recSave');
await page.keyboard.press('s');
const physicalJson = JSON.parse(await dl(page, '#exportJson'));
const group = physicalJson.size_summary.find(g => g.run_id === physicalRun.run_id && g.camera_px_source === 'measured');
ok(group.checks === 2 && group.correct_detections === 1 && group.detection_rate === 0.5 && group.distance_known_count === 1 && group.equivalent_distance_min_m === 15, 'size summary: 2 tests / 1 TP / 50%, 1 known distance');
ok(/50.0%/.test(await page.textContent('#summary')) && /15.00/.test(await page.textContent('#summary')), 'size summary rendered');
if (process.env.SHOT) { await page.locator('#summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SHOT + '_range_summary.png' }); }
const physicalCsv = (await dl(page, '#exportCsv')).trim().split('\n'); const ph = physicalCsv[0].split(',');
const pr = physicalCsv.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [ph[i], v]))).find(r => r.run_id === physicalRun.run_id && r.step === '0');
ok(pr.drone_width_cm === '60' && pr.screen_object_width_mm === '60' && pr.equivalent_distance_m === '15', 'CSV contains measured widths and computed distance');
fs.writeFileSync('/tmp/dronecv66_range_session.json', JSON.stringify(physicalJson));
{ const c = await newCtx(); const p = await open(c); await p.setInputFiles('#importJson', '/tmp/dronecv66_range_session.json');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('dronecv66v2.results') || '[]').some(r => r.equivalent_distance_m === 15));
  const imported = await p.evaluate(() => JSON.parse(sessionJson()));
  ok(imported.results.some(r => r.drone_width_source === 'TEST ONLY: measured full width A-B' && r.equivalent_distance_m === 15), 'new JSON round trip preserves width source and distance');
  await p.close(); await c.close(); }
await page.selectOption('#zoom', '5x'); await page.click('#start');
const physical5 = await ls(page, 'trial');
ok(JSON.stringify(physical5.order) === JSON.stringify(physicalRun.order) && physical5.settings.zoom === '5x', 'range experiment repeats same images and levels at 5x');
await page.keyboard.press('s'); await page.fill('#distance', ''); await page.click('#start');
await page.keyboard.press('r'); await page.keyboard.press('1'); await page.fill('#recDroneWidth', '60'); await page.fill('#recScreenWidth', '60'); await page.click('#recSave');
const unknownDistance = (await ls(page, 'results')).filter(r => r.distance_cm === null);
ok(unknownDistance.length === 1 && unknownDistance.every(r => r.equivalent_distance_m === null && r.object_angular_width_deg === null), 'missing camera distance stays null');
ok(new Set((await ls(page, 'runs')).map(r => r.run_id)).size === (await ls(page, 'runs')).length, 'run ids are unique even when started within one second');
ok(page.net.length === 0, 'no network requests (offline): ' + page.net.slice(0, 3).join(' '));
ok(page.dialogs.length === 1 && /Заменить текущую выборку/.test(page.dialogs[0]), 'only dialog: confirmation before replacing a sample that has results: ' + page.dialogs.join(' | '));
if (process.env.SHOT) { await page.keyboard.press('s'); await page.check('input[name=mode][value=quick]'); await page.screenshot({ path: process.env.SHOT + '_settings.png' });
  await page.click('#presetPilot'); await page.click('#start'); await page.keyboard.press('r'); await page.screenshot({ path: process.env.SHOT + '_record.png' }); }
await page.close(); await ctx.close(); await browser.close(); process.exit(0);

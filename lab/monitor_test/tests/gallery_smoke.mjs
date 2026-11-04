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
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, acceptDownloads: true }); // = 3840x2160 monitor px
const page = await ctx.newPage();
const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto('file://' + path.join(dir, 'gallery.html'));
await page.waitForFunction(() => /все файлы на месте|Изображений: \d+/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
const status = await page.textContent('#status');
ok(/Изображений: 90/.test(status), 'manifest loaded, all 90 files present: ' + status.slice(0, 60));
ok(await page.locator('.cat').count() === 6, '6 category filters');
// filter: only civil quadcopters + negatives; monitor mode 32 px; sequential
for (const c of ['military_uav', 'uav_payload', 'bird', 'aircraft']) await page.uncheck(`.cat[value=${c}]`);
await page.check('input[name=order][value=sequential]');
await page.selectOption('#scaleMode', 'monitor'); await page.fill('#sizes', '32');
await page.click('#start');
ok(await page.isHidden('#settings'), 'clean mode: settings hidden');
ok(await page.isHidden('#hud') && await page.isHidden('#answer'), 'clean mode: no captions/answers');
const order = await page.evaluate(() => JSON.parse(localStorage.getItem('dronecv66.trial')).order);
ok(order.length === 30 && order.every(o => /^(civ|neg)\d\d$/.test(o.id)), 'filter applied: 20 civil + 10 negative');
const sz = await page.evaluate(() => { const m = window.MANIFEST.images.find(x => x.id === JSON.parse(localStorage.getItem('dronecv66.trial')).order[0].id);
  const img = document.getElementById('img'); const b = m.object_bbox; const side = Math.max(b[2] - b[0], b[3] - b[1]);
  const r = img.getBoundingClientRect(); const cx = r.left + (b[0] + b[2]) / 2 * r.width / m.width, cy = r.top + (b[1] + b[3]) / 2 * r.height / m.height;
  return { px: side * r.width / m.width * devicePixelRatio, cx, cy }; });
ok(Math.abs(sz.px - 32) < 0.5, `object scaled to 32 monitor px (${sz.px.toFixed(2)})`);
ok(Math.abs(sz.cx - 960) < 1 && Math.abs(sz.cy - 540) < 1, 'object centred');
// record + answer
await page.keyboard.press('a');
ok(await page.isVisible('#record') && await page.isHidden('#answer'), 'A before recording opens the record form, not the answer');
await page.check('input[name=out][value=hit]'); await page.fill('#recConf', '55'); await page.keyboard.press('Enter');
await page.keyboard.press('a');
ok(await page.isVisible('#answer') && /Гражданский/.test(await page.textContent('#answer')), 'answer shown after recording');
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
await page.keyboard.press('i'); ok(/^3\/30/.test(await page.textContent('#hud')), 'arrow keys + HUD (I)');
// zoom keys change scale
await page.waitForTimeout(300); const w0 = await page.evaluate(() => document.getElementById('img').getBoundingClientRect().width);
await page.waitForTimeout(300); await page.keyboard.press('+'); await page.waitForTimeout(300); const w1 = await page.evaluate(() => document.getElementById('img').getBoundingClientRect().width);
await page.keyboard.press('0'); await page.waitForTimeout(300); const w2 = await page.evaluate(() => document.getElementById('img').getBoundingClientRect().width);
ok(w1 > w0 * 1.09 && Math.abs(w2 - w0) < 0.5, '+ / 0 zoom');
// negative: 'hit' rejected
const negIdx = order.findIndex(o => o.id.startsWith('neg'));
await page.evaluate(i => { const t = JSON.parse(localStorage.getItem('dronecv66.trial')); t.index = i; localStorage.setItem('dronecv66.trial', JSON.stringify(t)); }, negIdx);
await page.reload(); await page.click('#resume');
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('dronecv66.trial')).index) === negIdx, 'order and position persist after reload');
await page.keyboard.press('r'); await page.check('input[name=out][value=hit]'); await page.keyboard.press('Enter');
ok(dialogs.length === 1 && await page.isVisible('#record'), 'hit on a negative is rejected');
await page.check('input[name=out][value=none]'); await page.fill('#recFp', '2'); await page.fill('#recFpConf', '31'); await page.keyboard.press('Enter');
// export
await page.keyboard.press('s');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsv')]);
const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
ok(csv.length === 3 && csv[0].startsWith('trial_id,step,image_id') && csv[0] === fs.readFileSync(path.join(dir, 'results_template.csv'), 'utf8').trim(), 'CSV export matches results_template.csv');
const [dj] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
const js = JSON.parse(fs.readFileSync(await dj.path(), 'utf8'));
ok(js.format === 'dronecv66-session-1' && js.results.length === 2 && js.results.some(r => r.fp_count === 2 && r.fp_max_conf_pct === 31), 'JSON export');
// random order reproducible by seed
await page.check('input[name=order][value=random]'); await page.fill('#seed', '7'); await page.click('#start');
const o1 = await page.evaluate(() => JSON.parse(localStorage.getItem('dronecv66.trial')).order.map(o => o.id).join());
await page.keyboard.press('s'); await page.click('#start');
const o2 = await page.evaluate(() => JSON.parse(localStorage.getItem('dronecv66.trial')).order.map(o => o.id).join());
ok(o1 === o2 && o1 !== order.map(o => o.id).join(), 'seeded random order is reproducible');
// calibration squares in monitor px
await page.keyboard.press('s'); await page.keyboard.press('c');
const sq = await page.evaluate(() => [...document.querySelectorAll('#calibgrid .sq')].map(e => e.getBoundingClientRect().width * devicePixelRatio));
ok(sq.length === 6 && Math.abs(sq[0] - 512) < 0.5 && Math.abs(sq[5] - 16) < 0.5, 'calibration squares 512..16 monitor px');
await page.fill('#calibMeasured', '64'); await page.click('#calibApply');
ok(Math.abs(parseFloat(await page.inputValue('#k')) - 0.25) < 1e-6, 'calibration k = measured/256');
await page.keyboard.press('c'); await page.selectOption('#scaleMode', 'camera'); await page.fill('#sizes', '16'); await page.click('#start');
const cam = await page.evaluate(() => { const st = JSON.parse(localStorage.getItem('dronecv66.trial')); const m = window.MANIFEST.images.find(x => x.id === st.order[0].id);
  const r = document.getElementById('img').getBoundingClientRect(); const b = m.object_bbox; return Math.max(b[2] - b[0], b[3] - b[1]) * r.width / m.width * devicePixelRatio; });
ok(Math.abs(cam - 64) < 0.5, `camera mode: 16 px in frame / k 0.25 = 64 monitor px (${cam.toFixed(2)})`);
if (process.env.SHOT) { await page.keyboard.press('r'); await page.screenshot({ path: process.env.SHOT + '_record.png' }); await page.keyboard.press('Escape');
  await page.keyboard.press('s'); await page.screenshot({ path: process.env.SHOT + '_settings.png' }); }
await page.close(); await browser.close(); process.exit(0);

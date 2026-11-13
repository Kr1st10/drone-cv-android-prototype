// Synthetic files exercise import ordering in the real page; no model or phone results.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const dir = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
for (const image of manifest.images) image.file = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--allow-file-access-from-files'] });
let passed = 0, failed = 0;

async function fixture(action) {
  const context = await browser.newContext();
  await context.addInitScript(value => { window.MANIFEST = value; }, manifest);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto('file://' + path.join(dir, 'gallery.html'));
    await page.evaluate(() => {
      T = { run_id: 'TEST-RUN', index: 0, settings: { ...readSettings(), mode: 'advanced' },
        order: M.slice(0, 2).map(m => ({ id: m.id, level: null })) };
      openRecord();
      window.requests = {};
      window.importInputs = { observation: { value: '' }, settings: { value: '' } };
      window.begin = (name, observation = true, digest = false) => {
        const input = $(observation ? 'androidJson' : 'androidSetupJson');
        const target = importInputs[observation ? 'observation' : 'settings'];
        target.value = name;
        const entry = requests[name] = { input, target };
        const report = { schema_version: 1, device: name + ' PHONE',
          frames: [{ target_signal: { schema_version: 1, status: 'detected', confidence: 0.8,
            frame_width: 640, frame_height: 480, center_x: 100, center_y: 200 } }] };
        const text = JSON.stringify(report);
        const textPromise = new Promise((resolve, reject) => { entry.resolve = () => resolve(text); entry.reject = reject; });
        if (digest) sha256 = () => new Promise(resolve => { entry.hash = () => resolve(name + '-hash'); });
        else sha256 = async () => name + '-hash';
        target.files = [{ name: name + '.json', text: () => textPromise }];
        entry.done = input.onchange({ target });
      };
      window.finish = async (name, reject = false) => {
        if (reject) requests[name].reject(new Error('late-' + name)); else requests[name].resolve();
        await requests[name].done;
      };
      window.snapshot = observation => ({ file: ui.android?.file_name ?? null, metadata: DEVICE_PROFILE,
        status: $(observation ? 'androidPreview' : 'androidSetupStatus').textContent,
        input: importInputs[observation ? 'observation' : 'settings'].value,
        phone: $('phone').value });
    });
    await action(page);
  } finally { await context.close(); }
}

async function check(name, action) {
  try { await fixture(action); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

try {
  for (const observation of [true, false]) {
    const kind = observation ? 'observation' : 'settings';
    await check(kind + ': B finishes before A', async page => {
      await page.evaluate(observation => { begin('A', observation); begin('B', observation); }, observation);
      await page.evaluate(() => finish('B'));
      const expected = await page.evaluate(observation => snapshot(observation), observation);
      await page.evaluate(() => finish('A'));
      assert.deepEqual(await page.evaluate(observation => snapshot(observation), observation), expected);
      assert.equal(expected.metadata.phone, 'B PHONE');
      if (observation) assert.equal(expected.file, 'B.json');
    });
    await check(kind + ': late error cannot clear B', async page => {
      await page.evaluate(observation => { begin('A', observation); begin('B', observation); }, observation);
      await page.evaluate(() => finish('B'));
      const expected = await page.evaluate(observation => snapshot(observation), observation);
      await page.evaluate(() => finish('A', true));
      assert.deepEqual(await page.evaluate(observation => snapshot(observation), observation), expected);
    });
    for (const reject of [false, true]) {
      await check(kind + ': stale completion leaves pending B input and label (' + reject + ')', async page => {
        await page.evaluate(observation => { begin('A', observation); begin('B', observation); }, observation);
        const expected = await page.evaluate(observation => snapshot(observation), observation);
        await page.evaluate(reject => finish('A', reject), reject);
        assert.deepEqual(await page.evaluate(observation => snapshot(observation), observation), expected);
        assert.equal(expected.input, 'B');
        await page.evaluate(() => finish('B'));
      });
    }
    await check(kind + ': superseded digest cannot publish', async page => {
      await page.evaluate(async observation => {
        begin('A', observation, true); requests.A.resolve();
        await Promise.resolve(); await Promise.resolve();
        if (!requests.A.hash) throw new Error('digest not reached');
        begin('B', observation);
      }, observation);
      await page.evaluate(() => finish('B'));
      const expected = await page.evaluate(observation => snapshot(observation), observation);
      await page.evaluate(async () => { requests.A.hash(); await requests.A.done; });
      assert.deepEqual(await page.evaluate(observation => snapshot(observation), observation), expected);
    });
    await check(kind + ': changed run or step invalidates pending import', async page => {
      for (const field of ['step', 'run']) {
        await page.evaluate(({ observation, field }) => {
          begin('A', observation);
          if (field === 'step') T.index++; else T.run_id += '-NEW';
        }, { observation, field });
        const expected = await page.evaluate(observation => snapshot(observation), observation);
        await page.evaluate(() => finish('A'));
        assert.deepEqual(await page.evaluate(observation => snapshot(observation), observation), expected);
      }
    });
  }
  await check('remove during reading remains removed', async page => {
    await page.evaluate(() => begin('A'));
    await page.evaluate(() => $('clearAndroidImport').onclick());
    const expected = await page.evaluate(observation => snapshot(observation), true);
    await page.evaluate(() => finish('A'));
    assert.deepEqual(await page.evaluate(observation => snapshot(observation), true), expected);
    assert.equal(expected.file, null);
  });
  await check('saved and exported observation keeps B after late A', async page => {
    await page.evaluate(() => { begin('A'); begin('B'); });
    await page.evaluate(() => finish('B'));
    await page.evaluate(() => { ui.chosen = 'box_on_object'; saveRecord(); });
    const expected = await page.evaluate(() => JSON.parse(sessionJson()).results);
    assert.equal(expected.length, 1);
    assert.equal(expected[0].run_id, 'TEST-RUN');
    assert.equal(expected[0].step, 0);
    assert.equal(expected[0].android_import.file_name, 'B.json');
    assert.equal(expected[0].android_import.metadata.phone, 'B PHONE');
    await page.evaluate(() => finish('A'));
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionJson()).results), expected);
  });
  for (const close of ['cancel', 'escape', 'overlays', 'save']) {
    await check('close observation form: ' + close, async page => {
      await page.evaluate(() => begin('A'));
      if (close === 'cancel') await page.click('#recCancel');
      else if (close === 'escape') await page.keyboard.press('Escape');
      else await page.evaluate(close => {
        if (close === 'overlays') closeOverlays();
        else { ui.chosen = 'no_box'; saveRecord(); }
      }, close);
      const expected = await page.evaluate(observation => snapshot(observation), true);
      await page.evaluate(() => finish('A'));
      assert.deepEqual(await page.evaluate(observation => snapshot(observation), true), expected);
      assert.equal((await page.evaluate(() => R)).some(row => row.android_import), false);
    });
  }
  await check('settings import invalidated on navigation', async page => {
    await page.evaluate(() => { begin('A', false); section('results'); });
    const expected = await page.evaluate(observation => snapshot(observation), false);
    await page.evaluate(() => finish('A'));
    assert.deepEqual(await page.evaluate(observation => snapshot(observation), false), expected);
  });
  for (const observation of [true, false]) {
    await check('closing import details invalidates pending ' + (observation ? 'observation' : 'settings'), async page => {
      const id = observation ? 'androidJson' : 'androidSetupJson';
      await page.evaluate(({ id, observation }) => {
        if (!observation) { closeOverlays(); $('settings').classList.remove('hidden'); }
        $(id).closest('details').open = true;
      }, { id, observation });
      await page.locator('#' + id).evaluate(input => input.closest('details').querySelector('summary').click());
      // Reopen through the summary so both toggle tasks finish before reading begins.
      await page.locator('#' + id).evaluate(input => input.closest('details').querySelector('summary').click());
      await page.evaluate(observation => begin('A', observation), observation);
      await page.locator('#' + id).evaluate(input => input.closest('details').querySelector('summary').click());
      await page.waitForFunction(id => !document.getElementById(id).closest('details').open, id);
      const expected = await page.evaluate(observation => snapshot(observation), observation);
      await page.evaluate(() => finish('A'));
      assert.deepEqual(await page.evaluate(observation => snapshot(observation), observation), expected);
    });
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally { await browser.close(); }

// Real browser, local files and downloads. Reports are synthetic unless read from the archived Mi 8 Lite data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const pilot = new URL('../yolo-pilot/index.html', import.meta.url);
const page = await browser.newPage({ acceptDownloads: true });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const fixture = (name, text) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) });
const legacy = fileURLToPath(new URL(
  '../../../ml/results/android/mi8-lite/2026-11-03/', import.meta.url));
const report = JSON.stringify({
  schema_version: 1,
  model: { confidence: 0.45 },
  frames: Array.from({ length: 3 }, (_, i) => ({
    offset_ms: i * 1000, conversion_ms: 0, preprocess_ms: 0, ort_ms: 0, postprocess_ms: 0, pipeline_ms: 0,
    target_signal: { schema_version: 2, source_id: 1, frame_id: i + 1, analyzer_entry_ns: i + 1,
      status: 'detected', confidence: 0.8 },
  })),
});
const rows = [
  ['header', '100', { start_ns: '100', clock: 'elapsed_realtime_ns', mode: 'yolo' }],
  ['session_end', '200', { stop_ns: '200', recording_complete: true, dropped_count: '0',
    missing_ranges: '0', accepted_count: '1', written_count: '1' }],
];
const timeline = rows.map(([type, event_ns, data], i) => JSON.stringify({
  schema: 'dronecv-session-timeline-1', event_id: String(i + 1), event_ns, session_id: 'batch-test', type, data,
})).join('\n') + '\n';

const runTitle = 'Фото / лес · 150 м · 5×';
const zip = execFileSync('python3', ['-c', `
import io, json, sys, zipfile
report, timeline, title = json.load(sys.stdin)
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.comment = b'ZIP with multiple journal formats'
    archive.writestr('1 - Фото.json', report)
    bad = 'broken.json'
    archive.writestr(bad, report, compress_type=zipfile.ZIP_STORED)
    bad_offset = archive.getinfo(bad).header_offset + 30 + len(bad)
    archive.writestr('2 - Фото.ndjson', timeline, compress_type=zipfile.ZIP_STORED)
    archive.writestr('manifest.json', json.dumps({
        'schema': 'dronecv-journal-batch-1', 'journals': [
            {'path': '1 - Фото.json', 'id': 'diagnostic-a.ndjson', 'title': title},
            {'path': '2 - Фото.ndjson', 'id': 'diagnostic-b.ndjson', 'title': title},
            {'path': bad, 'id': 'diagnostic-c.ndjson', 'title': 'Broken'},
        ],
    }, ensure_ascii=False))
result = bytearray(buffer.getvalue())
result[bad_offset] ^= 0x10
sys.stdout.buffer.write(result)
`], { input: JSON.stringify([report, timeline, runTitle]) });

async function load(files, count) {
  await page.setInputFiles('#reports', files);
  await page.waitForFunction(n => document.querySelector('#status').textContent === `Загружено прогонов: ${n}.`, count);
  assert.equal(await page.locator('#runs tbody tr').count(), count);
}

async function download(id) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.click(id)]);
  return readFile(await file.path(), 'utf8');
}

async function csv(id = '#csv') {
  const data = await download(id);
  return JSON.parse(execFileSync('python3', ['-c', `
import csv, io, json, sys
print(json.dumps(list(csv.DictReader(io.StringIO(sys.stdin.read().lstrip('\ufeff'))))))
`], { input: data, encoding: 'utf8' }));
}

try {
  await page.goto(pilot.href);
  await load([fixture('Новое фото.json', report), fixture('Повреждён.json', '{'), fixture('Прежний.ndjson', timeline.replace('\n', '\nbroken\n'))], 2);
  assert.match(await page.locator('#errors').innerText(), /Повреждён\.json/);
  assert.match(await page.locator('#runs tbody tr').nth(1).innerText(), /Проблемы целостности/);
  const loose = await csv();
  assert.deepEqual(loose.map(run => [run.run_name, run.checked]), [['Новое фото', '3'], ['Прежний', '0']]);
  assert.equal(loose[0].background, '');
  assert.equal(loose[1].candidate_fraction, '');
  assert.equal(await page.locator('#attempts tbody tr').count(), 3);
  assert.equal((await csv('#attempt-csv')).length, 3);

  await load([fixture('Журналы.zip', zip)], 2);
  assert.match(await page.locator('#errors').innerText(), /broken\.json.*контрольная сумма/);
  assert.deepEqual(await page.locator('#runs tbody button').allTextContents(), [`1. ${runTitle}`, `2. ${runTitle}`]);

  await page.fill('[name="start"]', '1');
  await page.fill('[name="reference"]', 'Кадр А');
  await page.fill('[name="background"]', '=formula');
  await page.fill('[name="equivalent_range_m"]', '150');
  await page.fill('[name="camera"]', '5×');
  await page.click('#conditions button');
  await page.waitForFunction(() => document.querySelector('#conditions-status').textContent === 'Условия применены.');
  await page.selectOption('#run-select', '1');
  assert.equal(await page.inputValue('[name="reference"]'), '');
  await page.fill('[name="reference"]', 'Кадр Б');
  await page.click('#conditions button');
  await page.waitForFunction(() => document.querySelector('#conditions-status').textContent === 'Условия применены.');
  await page.selectOption('#run-select', '0');
  assert.equal(await page.inputValue('[name="reference"]'), 'Кадр А');

  const summary = await csv();
  assert.deepEqual(summary.map(run => [
    run.run_name, run.archive_id, run.checked, run.reference, run.background, run.camera, run.equivalent_range_m,
  ]), [
    [runTitle, 'diagnostic-a.ndjson', '2', 'Кадр А', "'=formula", '5×', '150'],
    [runTitle, 'diagnostic-b.ndjson', '0', 'Кадр Б', '', '', ''],
  ]);
  assert.ok(summary.every(run => !('attempt' in run)));
  const detail = JSON.parse(await download('#json'));
  assert.equal(detail.schema, 'dronecv-yolo-pilot-1');
  assert.equal(detail.samples.length, 2);
  assert.equal(detail.source.run_name, runTitle);

  const oldFilename = (await readdir(legacy)).find(name => /^drone-performance-.*\.json$/.test(name));
  await load(path.join(legacy, oldFilename), 1);
  assert.equal(await page.locator('#errors li').count(), 0);
  const [old] = await csv();
  assert.equal(old.checked, '0');
  assert.equal(old.candidate_fraction, '');
  assert.equal(old.reference, '');
  assert.deepEqual(pageErrors, []);
  console.log('Chrome file://: ZIP with damaged member, mixed loose files, duplicate titles, per-run conditions, CSV/JSON and legacy single import passed');
} finally {
  await browser.close();
}

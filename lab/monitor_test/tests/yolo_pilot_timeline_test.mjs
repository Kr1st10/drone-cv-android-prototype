import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import pilot from '../yolo-pilot/pilot.js';

const base = 90_071_992_547_409_931n;
const second = 1_000_000_000n;
const schema = 'dronecv-session-timeline-1';

function fixture(mode = 'yolo') {
  const rows = [];
  function add(type, data, time = base) {
    const event = { schema, session_id: 'pilot-test', event_id: String(rows.length + 1), event_ns: String(time), type, data };
    rows.push(event);
    return event;
  }
  add('header', { start_ns: String(base), clock: 'elapsed_realtime_ns', measurement_clock: 'monotonic_nano_time',
    app_version: 'test', confidence: .45 });
  add('metadata', { mode, confidence: .45 }, base + 1n);

  function result(i, found, at = BigInt(i) * second, extra = {}) {
    const time = base + at;
    const frame = String(base + BigInt(i));
    const entry = String(time - 1n);
    // Separate clocks deliberately have wildly different values.
    add('diagnostic_frame', { completed_ns: String(42n + BigInt(i)), offset_ns: String(i), detection_count: null }, time - 1n);
    return add('state', {
      reason: found ? 'update' : 'no_detection', result_source: 'yolo',
      publication_ns: String(time), publication_clock: 'elapsed_realtime_ns',
      source_id: String(base), generation: '3', frame_id: frame, detector_frame_id: frame,
      analyzer_entry_ns: entry, timestamp_source: 'elapsed_realtime', capture_ns: entry,
      last_yolo_frame_id: found ? frame : String(base + 1n),
      last_yolo_accepted_ns: found ? String(time) : String(base + second),
      last_yolo_analyzer_entry_ns: found ? entry : String(base + second - 1n),
      box: found ? [.1, .2, .3, .4] : null, ...extra,
    }, time + 3n);
  }

  function finish(fields = {}) {
    const stop = base + 60n * second;
    const count = String(rows.length);
    add('session_end', {
      stop_ns: String(stop), recording_complete: true, interrupted: false,
      experiment_status: 'not_observed', accepted_count: count, written_count: count,
      missing_ranges: '0', dropped_count: '0', ...fields,
    }, stop);
  }
  const text = () => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  return { rows, add, result, finish, text };
}

for (const [name, present, count] of [
  ['all candidates', () => true, 20],
  ['all no_detection', () => false, 0],
  ['mixed series', i => i % 2 === 0, 10],
]) {
  test(`NDJSON ${name}: counts state results, preserves unknown completion association`, () => {
    const log = fixture();
    for (let i = 1; i <= 20; i++) log.result(i, present(i));
    log.finish();
    const result = pilot.analyzeText(log.text(), '0', { confidence_threshold: .8 }, 'file.ndjson');
    assert.equal(result.source.filename, 'file.ndjson');
    assert.equal(result.source.format, schema);
    assert.equal(result.source.mode, 'yolo');
    assert.equal(result.source.recording_complete, true);
    assert.equal(result.conditions.confidence_threshold, .45);
    assert.deepEqual(result.summary, {
      checked: 20, with_candidate: count, without_candidate: 20 - count, candidate_fraction: count / 20, complete: false,
    });
    assert.equal(result.input_rows.diagnostic_frames_unlinked, 20);
    assert.equal(result.samples[0].frame_id, String(base + 1n));
    assert.equal(result.samples[1].frame_id, String(base + 2n));
    assert.ok(result.samples.every(row => row.confidence === null && row.completion_link === 'unknown'));
    assert.equal(result.ground_truth.tp, null);
    assert.match(pilot.toCsv(result), /"state_detector_frame","unknown"/);
    assert.doesNotThrow(() => JSON.stringify(result));
  });
}

test('NDJSON 19 distinct states, ignores initial snapshot, repeated result, timer and LK', () => {
  const log = fixture();
  const first = log.result(1, true);
  log.add('state', { ...first.data, reason: 'initial_snapshot' }, base + 2n * second);
  log.add('state', first.data, base + 2n * second);
  log.add('state', { ...first.data, reason: 'no_update_timeout', box: null }, base + 2n * second);
  log.add('state', { ...first.data, result_source: 'lk' }, base + 2n * second);
  log.add('state', { ...first.data, result_source: 'correction' }, base + 2n * second);
  log.add('tracking', { sequence: first.data.frame_id });
  log.add('publication', { source: 'yolo', frame_id: first.data.frame_id });
  for (let i = 2; i <= 19; i++) log.result(i, i % 2 === 0);
  log.finish();
  const result = pilot.analyzeText(log.text(), '0');
  assert.equal(result.summary.checked, 19);
  assert.equal(result.input_rows.duplicates, 1);
  assert.equal(result.input_rows.insufficient_evidence, 0);
});

test('NDJSON sampling uses exact ns including the start and one-second boundary', () => {
  const log = fixture();
  log.result(1, true, second);
  log.result(2, false, second + 1n);
  log.result(3, true, 2n * second);
  log.result(4, true, 2n * second + 1n);
  log.result(5, true, 3n * second + 1n, { timestamp_source: 'unknown' });
  log.finish();
  const result = pilot.analyzeText(log.text(), '1.000000001');
  assert.equal(result.selection.start_ns, '1000000001');
  assert.deepEqual(result.samples.map(row => row.offset_ns), ['1000000001', '2000000001', '3000000001']);
  assert.equal(result.samples.at(-1).capture_ns, null);
});

test('NDJSON excludes contradictory states, stale accepted confirmations and unproven mode', () => {
  const log = fixture();
  log.result(1, false);
  log.result(1, true);
  log.result(2, true, 2n * second, { last_yolo_accepted_ns: String(base) });
  log.result(3, false);
  log.finish();
  const result = pilot.analyzeText(log.text(), '0');
  assert.equal(result.summary.checked, 1);
  assert.equal(result.samples[0].candidate, false);
  assert.equal(result.input_rows.insufficient_evidence, 3);

  const lk = fixture('yolo_lk');
  lk.result(1, true);
  lk.finish();
  assert.equal(pilot.analyzeText(lk.text(), '0').summary.checked, 0);
});

test('NDJSON damaged end, loss, gaps and recording_failure preserve only observed statistics', () => {
  const log = fixture();
  for (let i = 1; i <= 20; i++) log.result(i, false);
  const truncated = pilot.analyzeText(log.text() + '{"incomplete"', '0');
  assert.equal(truncated.summary.checked, 20);
  assert.equal(truncated.summary.complete, false);
  assert.equal(truncated.source.recording_complete, false);
  assert.ok(truncated.source.integrity_issues.includes('invalid_line'));
  assert.ok(truncated.source.integrity_issues.includes('missing_or_invalid_end'));
  log.finish({ recording_complete: false, dropped_count: '1', missing_ranges: '1' });
  log.rows.splice(2, 1);
  log.add('recording_failure', { reason: 'close failed' });
  const loss = pilot.analyzeText(log.text(), '0');
  assert.equal(loss.summary.with_candidate, 0);
  assert.equal(loss.summary.checked, 20);
  assert.equal(loss.summary.complete, false);
  assert.equal(loss.source.recording_complete, false);
  for (const issue of ['reported_loss', 'recording_failure', 'event_id_gap_or_repeat', 'inconsistent_counts']) {
    assert.ok(loss.source.integrity_issues.includes(issue), issue);
  }
});

test('legacy JSON is detected by content, including pretty-printed input', () => {
  const report = JSON.stringify({ schema_version: 1, frames: [] }, null, 2);
  const result = pilot.analyzeText(report, '0', {}, 'old.ndjson');
  assert.equal(result.source.format, 'android-diagnostic-json-1');
  assert.equal(result.summary.candidate_fraction, null);
});

if (process.env.PILOT_PR35_CONTROLLER && process.env.PILOT_PR35_DIAGNOSTIC) {
  test('actual Kotlin fixtures from PR #35 preserve publication outcome and diagnostic ambiguity', () => {
    const states = pilot.analyzeText(readFileSync(process.env.PILOT_PR35_CONTROLLER, 'utf8'), '0.000000001');
    assert.equal(states.source.recording_complete, true);
    assert.deepEqual(states.samples.map(row => row.candidate), [false, true]);
    assert.equal(states.summary.complete, false);
    const diagnostics = pilot.analyzeText(readFileSync(process.env.PILOT_PR35_DIAGNOSTIC, 'utf8'), '0');
    assert.equal(diagnostics.source.recording_complete, true);
    assert.equal(diagnostics.input_rows.diagnostic_frames_unlinked, 1);
    assert.equal(diagnostics.summary.checked, 0);
  });
}

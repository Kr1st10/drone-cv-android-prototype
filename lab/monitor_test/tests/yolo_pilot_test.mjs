import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import pilot from '../yolo-pilot/pilot.js';

const { analyze, toCsv } = pilot;

function row(frameId, offsetMs, candidate = true) {
  const capture = 1e9 + frameId * 1e6;
  return {
    offset_ms: offsetMs, conversion_ms: 1, preprocess_ms: 3, ort_ms: 80, postprocess_ms: 2, pipeline_ms: 86,
    target_signal: {
      schema_version: 2, source_id: 1, frame_id: frameId, analyzer_entry_ns: capture + 1e5,
      capture_ns: capture, timestamp_source: 'elapsed_realtime',
      status: candidate ? 'detected' : 'no_target', confidence: candidate ? .6 : null,
    },
  };
}

function report(frames) {
  return { schema_version: 1, target_signal_schema_version: 2, model: { confidence: .25 }, frames };
}

test('20 candidates: first eligible completion, fixed spacing, deterministic ties and cap', () => {
  const frames = Array.from({ length: 22 }, (_, i) => row(i + 1, 250 + i * 1000));
  const high = row(30, 1260);
  high.target_signal.confidence = .99;
  const tie = row(31, 1250, false);
  const result = analyze(report([high, ...frames.slice().reverse(), tie]), 1000);
  assert.deepEqual(result.summary, {
    checked: 20, with_candidate: 20, without_candidate: 0, candidate_fraction: 1, complete: true,
  });
  assert.deepEqual(result.samples.map(s => s.frame_id), Array.from({ length: 20 }, (_, i) => i + 2));
  assert.equal(result.samples[0].offset_ms, 1250);
  assert.equal(result.samples[0].confidence, .6);
  assert.equal(result.ground_truth.tp, null);
  assert.equal(result.ground_truth.recall, null);
  assert.equal(result.independent_trials, false);
});

test('partial series distinguishes candidates, misses and unknown candidate confidence', () => {
  const rows = [row(1, 0, false), row(2, 1000), row(3, 3500)];
  delete rows[2].target_signal.confidence;
  const result = analyze(report(rows), 0);
  assert.deepEqual(result.summary, {
    checked: 3, with_candidate: 2, without_candidate: 1, candidate_fraction: 2 / 3, complete: false,
  });
  assert.deepEqual(result.samples.map(s => s.confidence), [null, .6, null]);
  assert.equal(result.ground_truth.fn, null);
  assert.equal(result.ground_truth.fp, null);
});

test('20 known negative frames yield a measured zero fraction', () => {
  const result = analyze(report(Array.from({ length: 20 }, (_, i) => row(i + 1, i * 1000, false))), 0);
  assert.equal(result.summary.checked, 20);
  assert.equal(result.summary.without_candidate, 20);
  assert.equal(result.summary.candidate_fraction, 0);
});

test('deduplicates publication ID, exposure and analyzer entry even outside sampled intervals', () => {
  const before = row(1, 0);
  const first = row(2, 2000);
  const between = row(3, 2500);
  const repeatedBefore = { ...before, offset_ms: 1000 };
  const repeatedBetween = row(4, 3000);
  repeatedBetween.target_signal.capture_ns = between.target_signal.capture_ns;
  const repeatedEntry = row(5, 3100);
  Object.assign(repeatedEntry.target_signal, {
    analyzer_entry_ns: between.target_signal.analyzer_entry_ns, capture_ns: null, timestamp_source: 'unknown',
  });
  const result = analyze(report([before, repeatedBefore, first, between, repeatedBetween, repeatedEntry, row(6, 3300)]), 1000);
  assert.deepEqual(result.samples.map(s => s.frame_id), [2, 6]);
  assert.equal(result.input_rows.duplicates, 3);
});

test('missing provenance, incomplete timing and LK observations never count as YOLO', () => {
  const countOnly = { ...row(1, 1000), target_signal: null, detection_count: 2 };
  const missingId = row(2, 2000);
  delete missingId.target_signal.analyzer_entry_ns;
  const noCompletion = row(3, 3000);
  delete noCompletion.ort_ms;
  const old = row(4, 4000);
  old.target_signal.schema_version = 1;
  const result = analyze({
    ...report([countOnly, missingId, noCompletion, old]),
    tracking: { samples: [
      { ...row(1, 0), kind: 'frame', last_yolo_confidence: .99 },
      { ...row(2, 1000), kind: 'correction', last_yolo_confidence: .99 },
    ] },
    completed_frames: 20, accepted_callbacks_not_completed: 10,
  }, 0);
  assert.equal(result.summary.checked, 0);
  assert.equal(result.summary.candidate_fraction, null);
  assert.equal(result.input_rows.insufficient_evidence, 4);
  assert.throws(() => analyze({ schema: 'dronecv-motion-android-1', frames: [] }, 0), TypeError);
});

test('a change in camera binding ends the series', () => {
  const otherSource = row(2, 500);
  otherSource.target_signal.source_id = 2;
  const result = analyze(report([row(1, 0), otherSource, row(3, 2000)]), 0);
  assert.deepEqual(result.samples.map(s => s.frame_id), [1]);
  assert.equal(result.input_rows.stopped_on_source_change, true);
});

test('exports series conditions and unavailable values, even without attempts', () => {
  const result = analyze(report([]), 500, {
    reference: 'Эталон "А"', view: 'спереди', equivalent_range_m: 100, monitor_distance_cm: 50,
    background: '=1+1', camera: '1×', confidence_threshold: .5,
  }, 'test.json');
  assert.equal(result.conditions.confidence_threshold, .25);
  assert.equal(result.conditions.confidence_threshold_source, 'android');
  assert.equal(analyze({ schema_version: 1, frames: [] }, 0, { confidence_threshold: .5 })
    .conditions.confidence_threshold_source, 'operator');
  assert.equal(JSON.parse(JSON.stringify(result)).ground_truth.successful_range_m, null);
  const csv = toCsv(result);
  assert.equal(csv.trimEnd().split('\r\n').length, 2);
  assert.match(csv, /"Эталон ""А"""/);
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"attempt","offset_ms"/);
});

test('three archived real timing reports yield unknown candidate fraction', () => {
  const directory = new URL('../../../ml/results/android/mi8-lite/2026-11-03/', import.meta.url);
  const files = readdirSync(directory).filter(name => /^drone-performance-.*\.json$/.test(name));
  assert.equal(files.length, 3);
  for (const name of files) {
    const input = JSON.parse(readFileSync(new URL(name, directory)));
    const result = analyze(input, 0);
    assert.ok(input.completed_frames > 20);
    assert.equal(result.summary.checked, 0, name);
    assert.equal(result.summary.candidate_fraction, null, name);
    assert.equal(result.input_rows.insufficient_evidence, input.frames.length, name);
  }
});

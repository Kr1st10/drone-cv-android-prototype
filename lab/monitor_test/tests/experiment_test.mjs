// All observations in this test are synthetic fixtures, not results from a model or a phone.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../experiment.js');
const condition = { phone: 'TEST PHONE', camera_zoom: '1x', analysis_frame_w: 640, analysis_frame_h: 480,
  model_name: 'TEST YOLO11s', model_sha256: 'a'.repeat(64), confidence_pct: 50, nms_iou: 0.7, camera_id: 'TEST CAMERA' };
function level(px, successes, total = 20, options = {}) {
  return Array.from({ length: total }, (_, i) => ({ run_id: 'TEST RUN', step: px * 1000 + i, experiment_kind: 'limit',
    experiment_condition: condition, category: 'civil_quadcopter', size_level: px, size_level_unit: 'camera_px',
    truth_camera_width_px: px, camera_size_independent: true, independent_check: true,
    screen_object_width_mm: px * 2, equivalent_distance_m: 570 / px,
    result_class: i < successes ? 'TP' : 'FN', max_confidence_pct: i < successes ? 80 : null, ...options }));
}
assert.deepEqual(api.analysis([]), []);
assert.deepEqual(api.analysis(level(20, 20, 20, { experiment_kind: 'gallery' })), []);
assert.throws(() => api.analysis(null), TypeError);
const baseline = api.analysis([...level(8, 5), ...level(16, 18), ...level(32, 20)])[0];
assert.equal(baseline.limit.status, 'bracketed');
assert.equal(baseline.limit.min_px, 16);
assert.equal(baseline.limit.n, 20);
assert.equal(baseline.limit.rate, 0.9);
assert.equal(baseline.limit.max_equivalent_distance_m, 570 / 16);
assert.equal(baseline.points.find(p => p.camera_width_px === 16).misses, 2);
assert.equal(baseline.points.find(p => p.camera_width_px === 16).confidence_known_count, 18);
assert.equal(baseline.points.find(p => p.camera_width_px === 16).confidence_median_pct, 80);
assert.equal(baseline.points[0].checked_frame_count, null); // manual windows do not invent frame counts
assert.equal(baseline.points[0].frames_with_known_count, 0);
assert.equal(baseline.points[0].candidate_frame_count, null);
assert.equal(baseline.points[0].matched_frame_count, null);
const frameRows = level(16, 18).map(r => ({ ...r, checked_frame_count: 30, candidate_frame_count: 29,
  matched_frame_count: 27, missed_frame_count: 3, false_positive_frame_count: 2 }));
const counted = api.analysis(frameRows)[0].points[0];
assert.equal(counted.checked_frame_count, 600);
assert.equal(counted.frames_with_known_count, 20);
assert.equal(counted.candidate_frame_count, 580);
assert.equal(counted.matched_frame_count, 540);
assert.equal(counted.missed_frame_count, 60);
assert.equal(counted.false_positive_frame_count, 40);
assert.equal(counted.checks, 20);
assert.equal(counted.correct, 18); // candidates and raw matched frames do not replace attempt labels
const partialFrames = frameRows.map((r, i) => i ? r : { ...r, checked_frame_count: null, matched_frame_count: null });
const partialPoint = api.analysis(partialFrames)[0].points[0];
assert.equal(partialPoint.checked_frame_count, null);
assert.equal(partialPoint.frames_with_known_count, 19);
assert.equal(partialPoint.matched_frame_count, null);
assert.equal(partialPoint.candidate_frame_count, 580); // an independently recorded raw count is retained
assert.equal(api.analysis(frameRows.map(r => ({ ...r, candidate_frame_count: 31 })))[0].points[0].candidate_frame_count, null);
assert.equal(api.analysis(level(16, 20).map(r => ({ ...r, checked_frame_count: 0, candidate_frame_count: 0 })))[0].points[0].checked_frame_count, 0);
assert.ok(baseline.points[0].ci95.low < baseline.points[0].rate && baseline.points[0].ci95.high > baseline.points[0].rate);
assert.equal(api.analysis(level(16, 18, 19))[0].limit.status, 'insufficient');
assert.equal(api.analysis(level(16, 20))[0].limit.status, 'all_pass');
assert.equal(api.analysis(level(16, 20))[0].limit.min_px, null);
assert.equal(api.analysis(level(16, 1))[0].limit.status, 'all_fail');
assert.equal(api.analysis([...level(8, 20), ...level(16, 1)])[0].limit.status, 'contradictory');
const withUnknown = level(16, 20);
withUnknown.push(...level(16, 0, 20, { truth_camera_width_px: null }).map((r, i) => ({ ...r, step: 90000 + i })));
const unknown = api.analysis(withUnknown)[0];
assert.equal(unknown.points[0].camera_width_px, null);
assert.equal(unknown.points[0].truth_complete, false);
assert.equal(unknown.points[0].checks, 40);
assert.equal(unknown.points[0].misses, 20);
assert.equal(unknown.limit.status, 'insufficient');
// A missed check with missing geometry belongs to its nominal level, not to a separate unplotted group.
const nominalStable = level(20, 20, 20, { size_level: 3, size_level_unit: 'screen_cm', screen_object_width_mm: 30 });
const nominalMiss = { ...nominalStable[0], step: 99999, result_class: 'FN', false_alarm: true,
  screen_object_width_mm: null, truth_camera_width_px: null, equivalent_distance_m: null };
const nominal = api.analysis([...level(10, 2), ...nominalStable, nominalMiss])[0];
const nominalPoint = nominal.points.find(p => p.size_level === 3);
assert.equal(nominalPoint.checks, 21);
assert.equal(nominalPoint.misses, 1);
assert.equal(nominalPoint.rate, 20 / 21);
assert.equal(nominalPoint.false_positives, 1);
assert.equal(nominalPoint.camera_width_px, null);
assert.equal(nominalPoint.truth_complete, false);
assert.equal(nominalPoint.geometry_complete, false);
assert.equal(nominal.limit.min_px, null);
assert.notEqual(nominal.limit.status, 'bracketed');
// Different known physical geometry under one nominal level is ineligible rather than silently blended.
const changedMm = api.analysis([...nominalStable, { ...nominalStable[0], step: 99999, screen_object_width_mm: 31 }])[0];
assert.equal(changedMm.points.length, 1);
assert.equal(changedMm.points[0].checks, 21);
assert.equal(changedMm.points[0].geometry_consistent, false);
assert.equal(changedMm.points[0].eligible, false);
const changedScale = api.analysis(nominalStable.map((r, i) => ({ ...r, display_scale: i ? 0.5 : 0.6 })))[0];
assert.equal(changedScale.points[0].geometry_consistent, false);
assert.equal(changedScale.points[0].truth_complete, false);
const missingScale = api.analysis(nominalStable.map((r, i) => ({ ...r, display_scale: i ? 0.5 : null })))[0];
assert.equal(missingScale.points[0].geometry_complete, false);
assert.equal(missingScale.points[0].eligible, false);
const duplicate = api.analysis([...level(16, 20), ...level(16, 20)])[0];
assert.equal(duplicate.points[0].checks, 20);
assert.equal(duplicate.duplicate_count, 20); // duplicate step keys cannot make extra independent tests
const truthMissing = api.analysis(level(16, 20, 20, { camera_size_independent: false, detector_bbox_camera_px: [0, 0, 50, 50] }))[0];
assert.equal(truthMissing.points[0].camera_width_px, null);
assert.equal(truthMissing.limit.status, 'insufficient');
assert.equal(api.analysis(level(16, 20, 20, { truth_camera_width_px: 641 }))[0].limit.status, 'insufficient');
const correlated = api.analysis(level(16, 20, 20, { independent_check: false }))[0];
assert.equal(correlated.points[0].checks, 20);
assert.equal(correlated.points[0].independent_checks, 0);
assert.equal(correlated.limit.status, 'insufficient');
const inflate = [...level(16, 1), ...level(16, 100, 100, { independent_check: false }).map((r, i) => ({ ...r, step: 90000 + i }))];
assert.equal(api.analysis(inflate)[0].points[0].stability_met, false); // correlated TP cannot rescue failing independent trials
const median = level(16, 20).map((r, i) => ({ ...r, truth_camera_width_px: i % 2 ? 16.2 : 15.8 }));
assert.equal(api.analysis(median)[0].points[0].camera_width_px, 16);
assert.equal(api.analysis([...level(8, 5), ...level(16, 18), ...level(32, 2, 5)])[0].limit.uncertainty, true);
assert.equal(api.analysis([...level(16, 20), ...level(16, 20, 20, { experiment_condition: { ...condition, camera_zoom: '5x' } })]).length, 2);
assert.deepEqual(api.analysis(JSON.parse(JSON.stringify([...level(8, 5), ...level(16, 18), ...level(32, 20)]))), [baseline]);
assert.equal(api.compatibility(condition, { ...condition }).status, 'match');
assert.equal(api.compatibility(condition, { ...condition, camera_zoom: '5x' }).status, 'mismatch');
assert.equal(api.compatibility(condition, { ...condition, model_sha256: null }).status, 'unknown');
assert.equal(api.compatibility({ ...condition, analysis_frame_w: false }, { ...condition, analysis_frame_w: false }).status, 'unknown');
assert.equal(api.classifySize(baseline, 20, condition).status, 'inside_tested_range');
assert.equal(api.classifySize(baseline, 10, condition).status, 'below');
assert.equal(api.classifySize(baseline, 40, condition).status, 'above');
assert.equal(api.classifySize(baseline, 20, { ...condition, camera_zoom: '5x' }).status, 'unknown');
assert.equal(api.classifySize(baseline, 20, condition).guarantee_detection, false);
assert.equal(api.classifySize(api.analysis(level(16, 20))[0], 20, condition).status, 'unknown');
const preciseBoundary = api.analysis([...level(60, 1), ...level(120, 20)])[0];
assert.equal(api.classifySize(preciseBoundary, 120 + 1e-12, condition).status, 'inside_tested_range');
assert.equal(api.classifySize(preciseBoundary, 120 - 1e-12, condition).status, 'inside_tested_range');
assert.equal(api.classifySize(preciseBoundary, 119.99, condition).status, 'below');
assert.equal(api.classifySize(preciseBoundary, 120.01, condition).status, 'above');
assert.equal(api.wilson(1, 0), null);
assert.equal(api.wilson(2, 1), null);
const negative = api.analysis(level(16, 10, 20, { category: 'bird', result_class: 'FP' }))[0];
assert.equal(negative.points[0].false_positive_rate, 1);
assert.equal(negative.limit.status, 'empty');
const alarmsOnDrone = api.analysis(level(16, 10).map(r => ({ ...r, false_alarm: true })))[0].points[0];
assert.equal(alarmsOnDrone.false_positives, 20);
assert.equal(alarmsOnDrone.correct, 10);
assert.equal(alarmsOnDrone.misses, 10);
assert.equal(alarmsOnDrone.rate, 0.5); // TP+false_alarm and FN+false_alarm retain their original denominator
const report = { schema_version: 1, target_signal_schema_version: 2, device: 'TEST PHONE', app_version: 'TEST APP',
  started_epoch_ms: 100, completed_frames: 2, unstored_frames: 0,
  model: { name: 'YOLO11s', sha256: 'a'.repeat(64), input_width: 640, input_height: 640, confidence: 0.5, nms_iou: 0.7 },
  frames: [{ offset_ms: 10, target_signal: { schema_version: 2, frame_id: 1, status: 'detected', width: 640, height: 480, confidence: 0.8, center: { x: 320, y: 240 } } },
    { offset_ms: 20, target_signal: { schema_version: 2, frame_id: 2, status: 'no_target', width: 640, height: 480, confidence: null, center: null } }] };
const parsed = api.parseAndroid(report);
assert.equal(parsed.metadata.analysis_frame_w, 640);
assert.equal(parsed.metadata.analysis_frame_h, 480);
assert.equal(parsed.metadata.model_sha256, 'a'.repeat(64));
assert.equal(parsed.metadata.confidence_pct, 50);
assert.equal(parsed.metadata.camera_zoom, null);
assert.equal(parsed.frame_count, 2);
assert.equal(parsed.candidate_count, 1);
assert.equal(parsed.no_target_count, 1);
assert.equal(parsed.bbox_available, false);
assert.equal(parsed.correct_detection_count, null);
assert.equal(parsed.frames[0].object_width_px, null);
assert.equal(parsed.frames[0].independent_check, false);
assert.equal(parsed.frames[0].confidence_pct, 80);
assert.equal(parsed.frames[0].result_class, null);
assert.equal(api.parseAndroid({ ...report, frames: [report.frames[0], { target_signal: { ...report.frames[1].target_signal, width: 480, height: 640 } }] }).metadata.analysis_frame_w, null);
assert.throws(() => api.parseAndroid({ frames: [] }), TypeError);
assert.throws(() => api.parseAndroid({ schema_version: 1 }), TypeError);
assert.equal(api.parseAndroid({ ...report, model: { confidence: NaN }, frames: [] }).metadata.confidence_pct, null);
const absent = api.parseAndroid({ ...report, frames: [{ target_signal: null }, {}, null] });
assert.equal(absent.unknown_signal_count, 3);
assert.equal(absent.metadata.analysis_frame_w, null);
console.log('Synthetic fixtures: threshold/uncertainty, independent truth/trials, compatibility, serialization and Android metadata: OK');

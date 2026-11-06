"""Target-signal timing/coordinate validation without model or third-party dependencies."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('analyzer', Path(__file__).parents[1] / 'scripts/analyze_android_sessions.py')
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


def report():
    signal = dict(schema_version=2, frame_id=1, source_id=1, status='detected', capture_ns=1_000_000_000,
                  analyzer_entry_ns=1_010_000_000, signal_dispatch_ns=1_150_000_000,
                  timestamp_source='elapsed_realtime', capture_to_signal_ms=150.0,
                  capture_to_analyzer_ms=10.0, analyzer_to_signal_ms=140.0, timing_issue=None,
                  width=640, height=480, coordinate_space='upright_crop_pixels',
                  center=dict(x=100.25, y=200.75), pixel=dict(x=100, y=200), confidence=.9)
    return dict(target_signal_schema_version=2, frames=[dict(target_signal=signal)], application_stale_frames_discarded=1,
                capture_timing_availability=dict(scope='stored_frames', stored_frames=1, signals_recorded=1,
                                                available_frames=1, unavailable_frames=0, available_fraction=1.),
                timing_summary_ms={name: analyzer.summary([value]) for name, value in
                                   [('capture_to_signal', 150.0), ('capture_to_analyzer', 10.0), ('analyzer_to_signal', 140.0)]})


class TargetSignalValidation(unittest.TestCase):
    def check(self, d):
        errors = []
        result = analyzer.analyze_target_signals(d, errors)
        return result, errors

    def test_timestamps_and_availability_recomputed(self):
        result, errors = self.check(report())
        self.assertFalse(errors)
        self.assertEqual(150.0, result['timings_ms']['capture_to_signal']['mean'])
        self.assertEqual(1., result['capture_timing_availability']['available_fraction'])
        self.assertEqual(1, result['detected'])

    def test_unknown_clock_keeps_coordinates_but_not_exposure_latency(self):
        d = report(); s = d['frames'][0]['target_signal']; s['timestamp_source'] = 'unknown'
        self.assertTrue(any('capture_to_signal' in e for e in self.check(d)[1]))
        s.update(timing_issue='unsynchronized_camera_clock', capture_to_signal_ms=None, capture_to_analyzer_ms=None)
        d['timing_summary_ms'].update(capture_to_signal=None, capture_to_analyzer=None)
        d['capture_timing_availability'].update(available_frames=0, unavailable_frames=1, available_fraction=0.)
        result, errors = self.check(d)
        self.assertFalse(errors); self.assertEqual(1, result['without_exposure_latency'])
        self.assertEqual(1, result['detected'])

    def test_no_target_cannot_carry_old_coordinates_or_confidence(self):
        d = report(); s = d['frames'][0]['target_signal']; s['status'] = 'no_target'
        self.assertTrue(any('status/center' in e for e in self.check(d)[1]))
        s['center'] = None
        errors = self.check(d)[1]
        self.assertTrue(any('confidence' in e for e in errors)); self.assertTrue(any('pixel' in e for e in errors))
        s.update(pixel=None, confidence=None)
        result, errors = self.check(d)
        self.assertFalse(errors); self.assertEqual(0, result['detected'])

    def test_mismatched_summary_pixels_and_duplicate_frame_id_are_detected(self):
        d = report(); d['timing_summary_ms']['capture_to_signal']['mean'] = 1
        d['frames'][0]['target_signal']['center']['x'] = 900
        d['frames'].append(copy.deepcopy(d['frames'][0]))
        errors = self.check(d)[1]
        self.assertTrue(any('summary mismatch' in e for e in errors))
        self.assertTrue(any('outside image' in e for e in errors))
        self.assertTrue(any('duplicate' in e for e in errors))
        self.assertTrue(any('availability' in e for e in errors))

    def test_p50_alias_is_optional_for_old_summaries_and_checked_when_present(self):
        d = report()
        for value in d['timing_summary_ms'].values(): value['p50'] = value['median']
        self.assertFalse(self.check(d)[1])
        d['timing_summary_ms']['capture_to_signal']['p50'] = 1.
        self.assertTrue(any('p50 mismatch' in e for e in self.check(d)[1]))

    def test_availability_scope_excludes_unstored_and_discarded_frames(self):
        d = report(); d['frames'].append(dict(target_signal=None))
        d['unstored_frames'] = 100; d['application_stale_frames_discarded'] = 50
        d['capture_timing_availability'].update(stored_frames=2, unavailable_frames=1, available_fraction=.5)
        result, errors = self.check(d)
        self.assertFalse(errors); self.assertEqual(.5, result['capture_timing_availability']['available_fraction'])

    def test_empty_report_fraction_is_null(self):
        d = report(); d['frames'] = []
        d['timing_summary_ms'] = dict.fromkeys(d['timing_summary_ms'])
        d['capture_timing_availability'].update(stored_frames=0, signals_recorded=0, available_frames=0, available_fraction=None)
        self.assertFalse(self.check(d)[1])

    def test_version_one_reports_remain_readable_without_motion_processing(self):
        d = report(); d['target_signal_schema_version'] = 1; del d['capture_timing_availability']
        s = d['frames'][0]['target_signal']; s['schema_version'] = 1; s['status'] = 'observed'
        s['observed'] = s.pop('center'); s['observed_pixel'] = s.pop('pixel')
        # Legacy fields are tolerated on input only; their removed calculations are not performed.
        s.update(target_id=7, velocity_px_per_second=dict(x=10., y=0.), forecast=[],
                 prediction_issue='insufficient_history', one_step_prediction_error_px=None)
        d['one_step_prediction_error_px'] = None
        result, errors = self.check(d)
        self.assertFalse(errors); self.assertEqual(1, result['detected'])
        self.assertNotIn('one_step_prediction_error_px', result)
        s.update(status='lost', observed=None, observed_pixel=None, confidence=None)
        result, errors = self.check(d)
        self.assertFalse(errors); self.assertEqual(0, result['detected'])


if __name__ == '__main__':
    unittest.main()

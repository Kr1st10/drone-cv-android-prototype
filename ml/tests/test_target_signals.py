"""Target-signal timing/coordinate validation without model or third-party dependencies."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('analyzer', Path(__file__).parents[1] / 'scripts/analyze_android_sessions.py')
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


def report():
    signal = dict(frame_id=1, source_id=1, target_id=1, status='observed', capture_ns=1_000_000_000,
                  analyzer_entry_ns=1_010_000_000, signal_dispatch_ns=1_150_000_000,
                  timestamp_source='elapsed_realtime', capture_to_signal_ms=150.0,
                  capture_to_analyzer_ms=10.0, analyzer_to_signal_ms=140.0, timing_issue=None,
                  width=640, height=480, coordinate_space='upright_crop_pixels',
                  observed=dict(x=100.0, y=200.0), forecast=[dict(after_signal_ms=200, point=dict(x=120.0, y=200.0))],
                  one_step_prediction_error_px=2.0)
    return dict(target_signal_schema_version=1, frames=[dict(target_signal=signal)], application_stale_frames_discarded=1,
                timing_summary_ms={name: analyzer.summary([value]) for name, value in
                                   [('capture_to_signal', 150.0), ('capture_to_analyzer', 10.0), ('analyzer_to_signal', 140.0)]},
                one_step_prediction_error_px=analyzer.summary([2.0]))


class TargetSignalValidation(unittest.TestCase):
    def check(self, d):
        errors = []
        result = analyzer.analyze_target_signals(d, errors)
        return result, errors

    def test_timestamps_recomputed_and_errors_in_pixels(self):
        result, errors = self.check(report())
        self.assertFalse(errors)
        self.assertEqual(150.0, result['timings_ms']['capture_to_signal']['mean'])
        self.assertEqual(2.0, result['one_step_prediction_error_px']['mean'])

    def test_unknown_clock_must_not_export_capture_latency_or_forecasts(self):
        d = report(); s = d['frames'][0]['target_signal']; s['timestamp_source'] = 'unknown'
        _, errors = self.check(d)
        self.assertTrue(any('capture_to_signal' in error for error in errors))
        self.assertTrue(any('forecast' in error for error in errors))
        s.update(timing_issue='unsynchronized_camera_clock', capture_to_signal_ms=None, capture_to_analyzer_ms=None, forecast=[])
        d['timing_summary_ms'].update(capture_to_signal=None, capture_to_analyzer=None)
        result, errors = self.check(d)
        self.assertFalse(errors); self.assertEqual(1, result['without_exposure_latency'])

    def test_forecast_beyond_one_second_is_rejected(self):
        d = report(); d['frames'][0]['target_signal']['forecast'][0]['after_signal_ms'] = 2000
        self.assertTrue(any('horizon' in error for error in self.check(d)[1]))

    def test_mismatched_summary_pixels_and_duplicate_id_are_detected(self):
        d = report(); d['timing_summary_ms']['capture_to_signal']['mean'] = 1
        d['frames'][0]['target_signal']['observed']['x'] = 900
        d['frames'].append(copy.deepcopy(d['frames'][0]))
        errors = self.check(d)[1]
        self.assertTrue(any('summary mismatch' in e for e in errors))
        self.assertTrue(any('outside image' in e for e in errors))
        self.assertTrue(any('duplicate' in e for e in errors))


if __name__ == '__main__':
    unittest.main()

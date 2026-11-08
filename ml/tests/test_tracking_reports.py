"""Validate the additive LK stream without conflating corrections and distinct frames."""
from pathlib import Path
import importlib.util
import unittest

spec = importlib.util.spec_from_file_location('analyzer', Path(__file__).parents[1] / 'scripts/analyze_android_sessions.py')
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


def sample(sequence, offset, kind, tracked, known=True):
    entry = 1_000_000_000 + offset * 1_000_000
    frame = dict(capture_ns=entry-10_000_000, analyzer_entry_ns=entry,
                 timestamp_source='elapsed_realtime' if known else 'unknown')
    return dict(sequence=sequence, generation=1, source_id=1, offset_ms=offset,
                kind=kind, status='tracking' if tracked else 'lost', reason=None,
                track_id=4 if tracked else None, coordinate_space='upright_crop_pixels', width=200, height=100,
                tracking_width=100, tracking_height=50,
                box=dict(left=20, top=30, right=41, bottom=50) if tracked else None,
                center=dict(x=30.5, y=40) if tracked else None, pixel=dict(x=30, y=40) if tracked else None,
                quality=dict(points=6, initial_points=8, retained_fraction=.75, correlation=.8,
                             median_fb_error_px=.4) if tracked else None,
                classification='confirmed', last_yolo_confidence=.85,
                last_yolo_frame=dict(capture_ns=990_000_000, analyzer_entry_ns=1_000_000_000, timestamp_source='elapsed_realtime'),
                confirmation_age_ms=offset+11, frame=frame, signal_dispatch_ns=entry+1_000_000,
                work_ms=1.0, timing_issue=None if known else 'unsynchronized_camera_clock',
                capture_to_signal_ms=11.0 if known else None, capture_to_analyzer_ms=10.0 if known else None,
                analyzer_to_signal_ms=1.0)


def report():
    return dict(duration_ms=100.0, tracking=dict(
        schema_version=1, observed_frames=3, track_updates=2, corrections=1, loss_events=1, unstored_samples=0,
        updates_fps_session=20.0, stored_updates=2, updates_with_capture_timing=1,
        samples=[sample(1, 10, 'frame', True), sample(1, 20, 'correction', True),
                 sample(2, 40, 'frame', True, False), sample(3, 60, 'frame', False)],
        timing_summary_ms={name: analyzer.summary(values) for name, values in {
            'update_work': [1., 1.], 'update_capture_to_signal': [11.], 'update_capture_to_analyzer': [10.],
            'update_analyzer_to_signal': [1., 1.], 'correction_work': [1.]}.items()}))


class TrackingReportTest(unittest.TestCase):
    def test_counts_distinct_updates_and_ignores_unknown_capture_timing(self):
        errors = []
        t = analyzer.analyze_tracking(report(), errors)
        self.assertEqual([], errors)
        self.assertEqual(20., t['updates_fps_session'])
        self.assertEqual(1, t['updates_with_capture_timing'])
        self.assertEqual(11., t['timing_summary_ms']['update_capture_to_signal']['median'])

    def test_rejects_lost_coordinates_and_miscounted_or_duplicate_frames(self):
        d = report()
        t = d['tracking']
        t['samples'][1]['kind'] = 'frame'
        t['samples'][-1]['center'] = dict(x=4, y=4)
        errors = []
        analyzer.analyze_tracking(d, errors)
        self.assertTrue(any('duplicate frame' in e for e in errors))
        self.assertTrue(any('status/coordinates' in e for e in errors))
        self.assertTrue(any('inconsistent' in e for e in errors))

    def test_truncation_retains_full_session_counters(self):
        d = report()
        t = d['tracking']
        t['samples'].pop()
        t['unstored_samples'] = 1
        errors = []
        analyzer.analyze_tracking(d, errors)
        self.assertEqual([], errors)

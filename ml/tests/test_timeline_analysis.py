import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from timeline_analysis import read_timeline


class TimelineAnalysisTest(unittest.TestCase):
    def test_long_export_and_incomplete_tail(self):
        base = 90071992547409930
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'run.ndjson'
            def row(i, kind, t, data):
                return json.dumps(dict(schema='dronecv-session-timeline-1', session_id='run', event_id=str(i), event_ns=str(t), type=kind, data=data)) + '\n'
            with path.open('w') as out:
                out.write(row(1, 'header', base, {'start_ns': str(base)}))
                out.write(row(2, 'state', base, {'publication_ns': str(base), 'box': None, 'reason': 'initial_snapshot'}))
                for i in range(3, 20005):
                    out.write(row(i, 'state', base+i, {'publication_ns': str(base+i), 'box': [0,0,1,1] if i % 2 else None, 'reason': 'update'}))
                out.write(row(20005, 'session_end', base+21000, {'stop_ns': str(base+21000), 'recording_complete': True, 'experiment_status': 'completed', 'dropped_count': '0', 'accepted_count': '20004', 'written_count': '20004'}))
            result = read_timeline(path)
            self.assertTrue(result['recording_complete'])
            self.assertEqual(result['duration_ns'], '21000')
            self.assertEqual(result['counts']['state'], 20003)
            self.assertEqual(result['intervals'][-1]['end_ns'], str(base+21000))
            with path.open('rb+') as out:
                out.seek(-3, 2); out.truncate()
            self.assertFalse(read_timeline(path)['recording_complete'])

    def test_kotlin_export_fixture_if_available(self):
        path = Path('/private/tmp/dronecv-timeline-fixture.ndjson')
        if not path.exists(): self.skipTest('Kotlin export fixture not generated')
        result = read_timeline(path)
        self.assertTrue(result['recording_complete'], result['errors'])
        self.assertGreater(result['counts']['frame'], 20000)
        self.assertGreater(result['counts']['state'], 20000)
        self.assertEqual(result['intervals'][1]['publication_ns'], result['header']['start_ns'])
        self.assertTrue(result['intervals'][-1]['end_ns'] == result['end']['stop_ns'])

    def test_kotlin_combined_fixture_if_available(self):
        path = Path('/private/tmp/dronecv-timeline-fixture.ndjson-diagnostic.ndjson')
        if not path.exists(): self.skipTest('Kotlin diagnostic fixture not generated')
        result = read_timeline(path)
        self.assertTrue(result['recording_complete'], result['errors'])
        for kind in ('resource', 'diagnostic_frame', 'tracking', 'frame_geometry', 'stale_discard', 'state'):
            self.assertGreater(result['counts'].get(kind, 0), 0, kind)

    def test_real_controller_timeline_if_available(self):
        path = Path('/private/tmp/dronecv-controller-timeline.ndjson')
        if not path.exists(): self.skipTest('controller timeline fixture not generated')
        result = read_timeline(path)
        self.assertTrue(result['recording_complete'], result['errors'])
        states = [i for i in result['intervals'] if i.get('reason') != 'initial_unknown']
        self.assertEqual(states[0]['reason'], 'initial_snapshot')
        self.assertIsNone(states[0]['box'])
        negative = next(i for i in states if i['reason'] == 'no_detection')
        self.assertEqual(negative['last_yolo_frame_id'], '1')
        self.assertEqual(negative['last_yolo_capture_ns'], '1000000000')
        self.assertTrue(any(i.get('box') for i in states))
        self.assertTrue(any(i['reason'] == 'no_update_timeout' and i['box'] is None for i in states))
        self.assertIsNotNone(states[-1]['box'])
        self.assertEqual(states[-1]['end_ns'], result['end']['stop_ns'])
        self.assertEqual(result['counts'].get('discard', 0) + result['counts'].get('stale_discard', 0), 1)

    def test_real_controller_correction_if_available(self):
        path = Path('/private/tmp/dronecv-controller-correction.ndjson')
        if not path.exists(): self.skipTest('controller correction fixture not generated')
        result = read_timeline(path)
        self.assertTrue(result['recording_complete'], result['errors'])
        correction = next(i for i in result['intervals'] if i.get('result_source') == 'correction')
        self.assertEqual((correction['frame_id'], correction['detector_frame_id'], correction['last_yolo_frame_id']), ('3', '1', '1'))
        self.assertEqual((correction['capture_ns'], correction['last_yolo_capture_ns'], correction['last_yolo_accepted_ns']), ('1061000000', '995000000', '1066000000'))

    def test_actual_types_gap_and_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'session.ndjson'
            def row(i, kind, time, data):
                return dict(schema='dronecv-session-timeline-1', session_id='s', event_id=str(i), event_ns=str(time), type=kind, data=data)
            rows = [row(1, 'header', 100, {'start_ns':'100'}),
                    row(2, 'state', 100, {'publication_ns':'100','box':[0,0,1,1]}),
                    *[row(i+3, kind, 100+i, {}) for i,kind in enumerate(['resource','diagnostic_frame','tracking','frame_geometry','stale_discard'])],
                    row(9, 'session_end', 200, {'stop_ns':'200','recording_complete':False,'experiment_status':'interrupted','interrupted':True,'dropped_count':'1','accepted_count':'7','written_count':'7','missing_first_event_id':'8','missing_last_event_id':'8','missing_first_ns':'105','missing_last_ns':'105','missing_bounds_exact':True})]
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            result=read_timeline(path)
            self.assertFalse(result['recording_complete'])
            self.assertEqual(result['missing_extent'],'entire_interval_conservative')
            self.assertTrue(all(not i['state_known'] for i in result['intervals']))
            rows[-1]['data'].update(recording_complete=True,dropped_count='0',accepted_count='7',written_count='7',missing_first_event_id=None,missing_last_event_id=None)
            rows[-1]['event_id']='8'
            rows.append(row(9,'recording_failure',201,{'reason':'close failed'}))
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            self.assertFalse(read_timeline(path)['recording_complete'])

    def test_unknown_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'run.ndjson'
            path.write_text(json.dumps({'schema': 'dronecv-session-timeline-2'})+'\n')
            with self.assertRaisesRegex(ValueError, 'unsupported timeline schema'):
                read_timeline(path)

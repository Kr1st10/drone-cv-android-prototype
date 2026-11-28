from copy import deepcopy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from timeline_analysis import analyze_timeline, read_timeline, publication_timing


class TimelineAnalysisTest(unittest.TestCase):
    def test_centering_simulation_uses_shared_timeline_integrity(self):
        events = [
            ('header', {'start_ns': '100', 'mode': 'centering_simulation', 'simulation': True}),
            ('centering_simulation', {'kind': 'frame', 'offset_percent': 38}),
            ('centering_simulation', {'kind': 'step_requested', 'step': 1, 'offset_percent': 38}),
            ('centering_simulation', {'kind': 'step_completed', 'step': 1}),
            ('centering_simulation', {'kind': 'frame_ignored', 'offset_percent': 38}),
            ('centering_simulation', {'kind': 'finished', 'completed_steps': 1, 'offset_percent': 0,
                                      'reason': 'centered'}),
            ('session_end', {'stop_ns': '200', 'recording_complete': True, 'dropped_count': '0',
                             'accepted_count': '6', 'written_count': '6', 'reason': 'centered'}),
        ]
        rows = [dict(schema='dronecv-session-timeline-1', session_id='sim', event_id=str(i),
                     event_ns='100', type=kind, data=data) for i, (kind, data) in enumerate(events, 1)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'simulation.ndjson'

            def read(records):
                path.write_text(''.join(json.dumps(row) + '\n' for row in records))
                return read_timeline(path)

            result = read(rows)
            self.assertTrue(result['recording_complete'])
            self.assertEqual(result['centering_simulation'], dict(label='Симуляция DJI', completed_steps=1,
                             offset_percent=0, stop_reason='centered', stop_label='Цель в зоне покоя',
                             confirmed=True, integrity_errors=[]))
            report = analyze_timeline(path, max_coordinate_age_ns=1)
            self.assertEqual(report['centering_simulation'], result['centering_simulation'])
            self.assertIsNone(report['metrics'])
            cases = [
                ('missing', 'отсутствует событие finished'),
                ('duplicate', 'несколько событий finished'),
                ('simulation after finished', 'Сразу после finished'),
                ('metadata after finished', 'Сразу после finished'),
                ('reason', 'Причины остановки в finished и session_end различаются'),
                ('empty reason', 'непустой reason'),
                ('steps', 'не совпадает с числом событий step_completed'),
                ('fractional steps', 'целое неотрицательное число'),
                ('boolean steps', 'целое неотрицательное число'),
            ]
            for case, expected in cases:
                with self.subTest(case=case):
                    edited = deepcopy(rows)
                    if case == 'missing':
                        edited.pop(-2)
                    elif case == 'duplicate':
                        edited.insert(-1, deepcopy(edited[-2]))
                    elif case == 'simulation after finished':
                        edited.insert(-1, deepcopy(edited[-3]))
                    elif case == 'metadata after finished':
                        edited.insert(-1, dict(edited[0], type='metadata', data={}))
                    elif case == 'reason':
                        edited[-1]['data']['reason'] = 'stopped'
                    elif case == 'empty reason':
                        edited[-2]['data']['reason'] = ' '
                    else:
                        edited[-2]['data']['completed_steps'] = {
                            'steps': 2, 'fractional steps': 0.5, 'boolean steps': True,
                        }[case]
                    for i, row in enumerate(edited, 1):
                        row['event_id'] = str(i)
                    footer = edited[-1]['data']
                    footer['accepted_count'] = footer['written_count'] = str(len(edited) - 1)
                    invalid = read(edited)
                    summary = invalid['centering_simulation']
                    self.assertFalse(invalid['recording_complete'])
                    self.assertFalse(summary['confirmed'])
                    self.assertEqual(invalid['errors'], summary['integrity_errors'])
                    self.assertEqual(len(invalid['errors']), 1)
                    self.assertIn(expected, invalid['errors'][0])

            stopped = deepcopy(rows)
            stopped[-2]['data']['reason'] = stopped[-1]['data']['reason'] = 'stopped'
            stopped[-1]['data']['interrupted'] = True
            stopped_summary = read(stopped)
            self.assertTrue(stopped_summary['recording_complete'])
            self.assertTrue(stopped_summary['centering_simulation']['confirmed'])
            self.assertEqual(stopped_summary['centering_simulation']['stop_label'], 'Остановлено')

            missing = read(rows[:3] + rows[4:])
            self.assertFalse(missing['recording_complete'])
            self.assertIn('event ID gap or reversal', missing['errors'])
            self.assertEqual(missing['centering_simulation']['completed_steps'], 0)
            self.assertIn('missing session_end', read(rows[:-1])['errors'])
            rows[-1]['data']['dropped_count'] = '1'
            self.assertFalse(read(rows)['recording_complete'])
            rows[0]['data']['mode'] = 'yolo'
            with self.assertRaisesRegex(ValueError, 'unsupported timeline record type: centering_simulation'):
                read(rows)

    def test_assignment_times_and_late_snapshot_preserve_observation(self):
        base = 90071992547409930
        data = dict(timing_semantics='stateflow_assignment_v1', reason='update',
                    publication_ns=str(base+30), state_publication_ns=str(base+30),
                    observation_publication_ns=str(base+30), result_ready_ns=str(base+10),
                    signal_publication_ns=str(base+20))
        publication_timing(data)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'run.ndjson'
            data.update(reason='initial_snapshot', publication_ns=str(base+100))
            rows = [('header', {'start_ns': str(base+100)}), ('state', data),
                    ('session_end', dict(stop_ns=str(base+200), recording_complete=True,
                                         dropped_count='0', accepted_count='2', written_count='2'))]
            path.write_text(''.join(json.dumps(dict(schema='dronecv-session-timeline-1',
                session_id='s', event_id=str(i), event_ns=str(base+100), type=kind, data=value))+'\n'
                for i, (kind, value) in enumerate(rows, 1)))
            result = read_timeline(path)
            self.assertTrue(result['recording_complete'], result['errors'])
            state = result['intervals'][-1]
            self.assertEqual(state['start_ns'], str(base+100))
            self.assertEqual(state['state_publication_ns'], str(base+30))
            self.assertEqual(state['result_ready_ns'], str(base+10))
        for field in ('result_ready_ns', 'signal_publication_ns', 'state_publication_ns'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                publication_timing({**data, field: str(base+300)})
        legacy = {'publication_ns': str(base+100)}
        publication_timing(legacy)
        self.assertNotIn('state_publication_ns', legacy)

    def test_optional_dry_run_does_not_change_legacy_tracking_intervals(self):
        header = ('header', 100, {'start_ns': '100', 'clock': 'elapsed_realtime_ns'})
        state = ('state', 110, {'publication_ns': '110', 'reason': 'update', 'box': [0, 0, .5, .5]})
        dry_run = ('dry_run', 120, {'decision_ns': '120', 'action': 'STOP', 'reason': 'TRACKING_CLEARED'})
        with tempfile.TemporaryDirectory() as tmp:
            results = []
            for extra in ([], [dry_run]):
                rows = [header, state, *extra]
                count = str(len(rows))
                rows.append(('session_end', 130, dict(stop_ns='130', recording_complete=True,
                    dropped_count='0', accepted_count=count, written_count=count)))
                path = Path(tmp) / f'{count}.ndjson'
                path.write_text(''.join(json.dumps(dict(schema='dronecv-session-timeline-1',
                    session_id='s', event_id=str(i), event_ns=str(t), type=kind, data=data)) + '\n'
                    for i, (kind, t, data) in enumerate(rows, 1)))
                result = read_timeline(path)
                self.assertTrue(result['recording_complete'], result['errors'])
                results.append(result)
            self.assertEqual(results[0]['intervals'], results[1]['intervals'])
            self.assertNotIn('dry_run', results[0]['counts'])
            self.assertEqual(results[1]['counts']['dry_run'], 1)

    def test_optional_one_turn_does_not_change_legacy_tracking_intervals(self):
        header = ('header', 100, {'start_ns': '100', 'clock': 'elapsed_realtime_ns'})
        state = ('state', 110, {'publication_ns': '110', 'reason': 'update', 'box': [0, 0, .5, .5]})
        one_turn = ('one_turn', 120, {'decision_ns': '120', 'action': 'STOP', 'reason': 'TRACKING_CLEARED'})
        with tempfile.TemporaryDirectory() as tmp:
            results = []
            for extra in ([], [one_turn]):
                rows = [header, state, *extra]
                count = str(len(rows))
                rows.append(('session_end', 130, dict(stop_ns='130', recording_complete=True,
                    dropped_count='0', accepted_count=count, written_count=count)))
                path = Path(tmp) / f'{count}.ndjson'
                path.write_text(''.join(json.dumps(dict(schema='dronecv-session-timeline-1',
                    session_id='s', event_id=str(i), event_ns=str(t), type=kind, data=data)) + '\n'
                    for i, (kind, t, data) in enumerate(rows, 1)))
                result = read_timeline(path)
                self.assertTrue(result['recording_complete'], result['errors'])
                results.append(result)
            self.assertEqual(results[0]['intervals'], results[1]['intervals'])
            self.assertNotIn('one_turn', results[0]['counts'])
            self.assertEqual(results[1]['counts']['one_turn'], 1)

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

    def test_corrupt_lines_and_gaps_hash_whole_file_and_hide_coordinates(self):
        import hashlib
        def row(i, kind, data):
            return json.dumps(dict(schema='dronecv-session-timeline-1', session_id='s',
                                   event_id=str(i), event_ns=str(100+i), type=kind, data=data))+'\n'
        header = row(1, 'header', {'start_ns':'100'})
        state = row(2, 'state', {'publication_ns':'102','box':[0,0,1,1],'reason':'initial_snapshot'})
        end = row(3, 'session_end', {'stop_ns':'200','recording_complete':True,'dropped_count':'0',
                                    'accepted_count':'2','written_count':'2','interrupted':False})
        cases = {
            'truncated': header+state+end[:-3],
            'corrupt_middle': header+'broken JSON\n'+state+end,
            'blank_before_failure': header+state+end+'\n'+row(4,'recording_failure',{'reason':'close failed'}),
            'gap': header+state+end.replace('"event_id": "3"','"event_id": "4"'),
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'damaged.ndjson'
            for name, text in cases.items():
                with self.subTest(name=name):
                    path.write_bytes(text.encode())
                    result = read_timeline(path)
                    self.assertFalse(result['recording_complete'])
                    self.assertTrue(result['errors'])
                    self.assertEqual(result['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
                    self.assertTrue(all(not i['state_known'] and i['box'] is None for i in result['intervals']))
                    if name == 'blank_before_failure':
                        self.assertIn('recording failure: close failed',result['errors'])

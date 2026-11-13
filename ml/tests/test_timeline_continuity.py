"""Hand-calculated synthetic timelines; no device quality claims."""
import csv
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from timeline_analysis import analyze_timeline, read_timeline, write_episode_csv

MS = 1_000_000
BOX = [0.1, 0.2, 0.3, 0.4]


class ContinuityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'session.ndjson'

    def write(self, states, start=1000*MS, stop=2000*MS, interrupted=False, extra=()):
        rows = []
        def row(kind, t, data):
            rows.append(dict(schema='dronecv-session-timeline-1', session_id='synthetic',
                             event_id=str(len(rows)+1), event_ns=str(t), type=kind, data=data))
        row('header', start, dict(start_ns=str(start), clock='elapsed_realtime_ns'))
        for t, box, capture, *options in states:
            data = dict(publication_ns=str(t), box=box, capture_ns=str(capture) if capture is not None else None,
                        analyzer_entry_ns=str(t), timestamp_source='elapsed_realtime',
                        reason='initial_snapshot' if len(rows) == 1 and t == start else 'update')
            if options:
                data.update(options[0])
            row('state', t, data)
        for kind, t, data in extra:
            row(kind, t, data)
        if stop is not None:
            row('session_end', stop, dict(stop_ns=str(stop), recording_complete=True,
                experiment_status='interrupted' if interrupted else 'completed', interrupted=interrupted,
                dropped_count='0', accepted_count=str(len(rows)), written_count=str(len(rows))))
        self.path.write_text(''.join(json.dumps(r)+'\n' for r in rows))

    def analyze(self, threshold=200*MS):
        return analyze_timeline(self.path, max_coordinate_age_ns=threshold)

    def example(self):
        self.write([(1000*MS, BOX, 900*MS), (1200*MS, BOX, 900*MS),
                    (1400*MS, None, None), (1600*MS, BOX, 1500*MS), (1800*MS, None, None)],
                   extra=[('publication',1200*MS,dict(bbox=BOX,published_ns=str(1200*MS)))])

    def test_required_example(self):
        self.example()
        r = self.analyze()
        self.assertTrue(r['recording_complete'])
        self.assertEqual(r['metrics']['duration_ns'], dict(present=600*MS, absent=400*MS,
                         unknown=0, fresh=200*MS, stale=400*MS, age_unknown=0))
        self.assertEqual(r['metrics']['coordinate_availability']['exact'], 0.6)
        self.assertEqual(r['metrics']['fresh_coordinate_availability']['exact'], 0.2)
        for name, expected in [('coordinate_gaps', [(1400,1600),(1800,2000)]),
                               ('fresh_coordinate_gaps', [(1100,1600),(1700,2000)])]:
            series = r[name]
            self.assertEqual([(e['start_ns']//MS,e['end_ns']//MS) for e in series['episodes']],expected)
            self.assertEqual(series['summary']['observed_start_count'],2)
            self.assertEqual(series['summary']['completed_recovery_count'],1)
            self.assertEqual(series['summary']['unfinished_at_stop_count'],1)
            self.assertTrue(series['episodes'][0]['recovered'])
            self.assertTrue(series['episodes'][1]['right_censored'])
            self.assertIsNone(series['episodes'][1]['recovery_ns'])
            self.assertTrue(series['episodes'][1]['duration_is_lower_bound'])
            self.assertEqual(series['summary']['mean_fully_observed_recovery_ns'], (200 if name=='coordinate_gaps' else 500)*MS)
        self.assertEqual(r['coordinate_gaps']['first_observation']['observed_wait_ns'],0)
        self.assertTrue(r['coordinate_gaps']['first_observation']['in_initial_snapshot'])
        self.assertEqual(r,self.analyze())
        self.assertEqual(r['sha256'],hashlib.sha256(self.path.read_bytes()).hexdigest())

    def test_all_absent_is_initial_wait(self):
        self.write([(1000*MS,None,None),(1300*MS,None,None)])
        r=self.analyze()
        for key in ('coordinate_gaps','fresh_coordinate_gaps'):
            self.assertEqual(r[key]['episodes'],[])
            self.assertIsNone(r[key]['first_observation']['time_ns'])
            self.assertEqual(r[key]['first_observation']['observed_wait_ns'],1000*MS)
            self.assertTrue(r[key]['first_observation']['wait_right_censored'])

    def test_delayed_initial_snapshot_preserves_provenance_and_image_age(self):
        self.write([(1010*MS, BOX, 950*MS,
                     {'reason': 'initial_snapshot', 'analyzer_entry_ns': str(970*MS)})],
                   stop=1200*MS)
        r = self.analyze()
        self.assertTrue(r['recording_complete'])
        self.assertEqual(r['integrity_errors'], [])
        self.assertEqual(r['interval']['duration_ns'], 200*MS)
        self.assertEqual(r['metrics']['duration_ns'],
                         dict(present=190*MS, absent=0, unknown=10*MS,
                              fresh=140*MS, stale=50*MS, age_unknown=0))
        for key in ('coordinate_gaps', 'fresh_coordinate_gaps'):
            with self.subTest(series=key):
                self.assertEqual(r[key]['first_observation'],
                                 dict(time_ns=1010*MS, in_initial_snapshot=True,
                                      observed_wait_ns=10*MS, wait_uncertain=True,
                                      wait_right_censored=False))
        self.assertEqual(r['coordinate_gaps']['episodes'], [])
        episodes = r['fresh_coordinate_gaps']['episodes']
        self.assertEqual(len(episodes), 1)
        self.assertEqual((episodes[0]['start_ns'], episodes[0]['end_ns'],
                          episodes[0]['duration_ns']), (1150*MS, 1200*MS, 50*MS))
        self.assertTrue(episodes[0]['right_censored'])
        self.assertFalse(episodes[0]['recovered'])
        self.assertIsNone(episodes[0]['recovery_ns'])

    def test_initial_snapshot_at_start_has_zero_wait_in_both_series(self):
        self.write([(1000*MS, BOX, 950*MS, {'reason': 'initial_snapshot'})],
                   stop=1100*MS)
        r = self.analyze()
        for key in ('coordinate_gaps', 'fresh_coordinate_gaps'):
            self.assertEqual(r[key]['first_observation'],
                             dict(time_ns=1000*MS, in_initial_snapshot=True,
                                  observed_wait_ns=0, wait_uncertain=False,
                                  wait_right_censored=False))

    def test_first_update_is_not_initial_snapshot(self):
        self.write([(1010*MS, BOX, 950*MS, {'reason': 'update'})], stop=1100*MS)
        r = self.analyze()
        for key in ('coordinate_gaps', 'fresh_coordinate_gaps'):
            self.assertEqual(r[key]['first_observation'],
                             dict(time_ns=1010*MS, in_initial_snapshot=False,
                                  observed_wait_ns=10*MS, wait_uncertain=True,
                                  wait_right_censored=False))

    def test_stale_initial_snapshot_and_first_fresh_update_have_distinct_origins(self):
        self.write([(1010*MS, BOX, 800*MS, {'reason': 'initial_snapshot'}),
                    (1100*MS, BOX, 1090*MS, {'reason': 'update'})], stop=1200*MS)
        r = self.analyze()
        self.assertEqual(r['coordinate_gaps']['first_observation'],
                         dict(time_ns=1010*MS, in_initial_snapshot=True,
                              observed_wait_ns=10*MS, wait_uncertain=True,
                              wait_right_censored=False))
        self.assertEqual(r['fresh_coordinate_gaps']['first_observation'],
                         dict(time_ns=1100*MS, in_initial_snapshot=False,
                              observed_wait_ns=100*MS, wait_uncertain=True,
                              wait_right_censored=False))

    def test_end_does_not_clear_and_expiry_without_events(self):
        self.write([(1000*MS,BOX,1000*MS)])
        r=self.analyze()
        self.assertEqual(r['coordinate_gaps']['episodes'],[])
        self.assertEqual(r['metrics']['duration_ns']['fresh'],200*MS)
        self.assertEqual(r['fresh_coordinate_gaps']['episodes'][0]['start_ns'],1200*MS)

    def test_timer_clear_and_repeated_empty_states(self):
        self.write([(1000*MS,BOX,1000*MS),(1100*MS,None,None,{'reason':'no_update_timeout'}),
                    (1200*MS,None,None),(1300*MS,BOX,1300*MS)])
        e=self.analyze()['coordinate_gaps']['episodes']
        self.assertEqual(len(e),1)
        self.assertEqual(e[0]['duration_ns'],200*MS)
        self.assertEqual(e[0]['transitions'][0]['reason'],'no_update_timeout')

    def test_unknown_exposure_keeps_presence(self):
        for options in ({'timestamp_source':'unknown'}, {'capture_ns':None}, {'capture_ns':str(1001*MS)},
                        {'timing_issue':'bad'}, {'analyzer_entry_ns':None}):
            with self.subTest(options=options):
                self.write([(1000*MS,BOX,1000*MS, options)])
                r=self.analyze()
                self.assertEqual(r['metrics']['duration_ns']['present'],1000*MS)
                self.assertEqual(r['metrics']['duration_ns']['age_unknown'],1000*MS)
                self.assertEqual(r['metrics']['fresh_coordinate_availability'],dict(exact=None,lower=0,upper=1))

    def test_incompatible_clear_publication_clock_rejects_exact_half_availability(self):
        self.write([(1000*MS, BOX, 1000*MS),
                    (1500*MS, None, None, {'publication_clock': 'monotonic_nano_time'})])
        for reader in (read_timeline, lambda path: analyze_timeline(path, max_coordinate_age_ns=1000*MS)):
            with self.subTest(reader=reader.__name__):
                with self.assertRaisesRegex(ValueError, 'incompatible state publication_clock.*line 3'):
                    reader(self.path)

    def test_incompatible_nonempty_publication_clock_is_not_an_interval_boundary(self):
        for publication in (1500*MS, 9000*MS):
            with self.subTest(publication=publication):
                self.write([(1000*MS, BOX, 1000*MS),
                            (publication, BOX, 1000*MS,
                             {'publication_clock': 'monotonic_nano_time'})])
                with self.assertRaisesRegex(ValueError, 'incompatible state publication_clock'):
                    self.analyze()

    def test_historical_missing_publication_clock_matches_explicit_elapsed_clock(self):
        states = [(1000*MS, BOX, 1000*MS), (1500*MS, None, None)]
        self.write(states)
        historical = self.analyze(threshold=1000*MS)
        self.write([(t, box, capture, {'publication_clock': 'elapsed_realtime_ns'})
                    for t, box, capture in states])
        explicit = self.analyze(threshold=1000*MS)
        for key in ('recording_complete', 'integrity_errors', 'interval', 'metrics',
                    'coordinate_gaps', 'fresh_coordinate_gaps'):
            self.assertEqual(historical[key], explicit[key], key)
        self.assertEqual(historical['metrics']['coordinate_availability']['exact'], 0.5)
        self.assertEqual(historical['metrics']['fresh_coordinate_availability']['exact'], 0.5)

    def test_unknown_exposure_with_valid_publication_clock_keeps_presence(self):
        self.write([(1000*MS, BOX, None, {'publication_clock': 'elapsed_realtime_ns',
                                        'timestamp_source': 'unknown'})])
        result = self.analyze()
        self.assertTrue(result['recording_complete'])
        self.assertEqual(result['integrity_errors'], [])
        self.assertEqual(result['metrics']['coordinate_availability']['exact'], 1)
        self.assertEqual(result['metrics']['duration_ns']['age_unknown'], 1000*MS)

    def test_cli_rejects_incompatible_publication_clock_before_writing_outputs(self):
        self.write([(1000*MS, BOX, 1000*MS),
                    (1500*MS, None, None, {'publication_clock': 'monotonic_nano_time'})])
        output, episodes = self.path.with_suffix('.json'), self.path.with_suffix('.csv')
        result = subprocess.run([sys.executable,
            str(Path(__file__).resolve().parents[1]/'scripts/timeline_analysis.py'), str(self.path),
            '--max-coordinate-age-ms', '1000', '--output', str(output),
            '--episodes-csv', str(episodes)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('incompatible state publication_clock', result.stderr)
        self.assertFalse(output.exists())
        self.assertFalse(episodes.exists())

    def test_initial_unknown_missing_and_invalid_box(self):
        for box_options in ({}, {'box':[1,0,0,1]}):
            self.write([(1200*MS,BOX,1200*MS,box_options)])
            if not box_options:
                text=self.path.read_text().replace('"box": [0.1, 0.2, 0.3, 0.4], ', '')
                self.path.write_text(text)
            r=self.analyze()
            self.assertEqual(r['metrics']['duration_ns']['unknown'],1000*MS)
            self.assertIsNone(r['metrics']['coordinate_availability']['exact'])
            self.assertEqual(r['metrics']['coordinate_availability']['upper'],1)

    def test_unknown_between_gaps_does_not_connect_recovery(self):
        self.write([(1000*MS,BOX,1000*MS),(1100*MS,None,None),(1200*MS,None,None),
                    (1300*MS,None,None),(1400*MS,BOX,1400*MS)])
        rows=[json.loads(line) for line in self.path.read_text().splitlines()]
        del next(row['data'] for row in rows if row['type']=='state'
                 and row['data']['publication_ns']==str(1200*MS))['box']
        self.path.write_text(''.join(json.dumps(row)+'\n' for row in rows))
        r=self.analyze()
        e=r['coordinate_gaps']['episodes']
        self.assertEqual(len(e),2)
        self.assertFalse(e[0]['recovered'])
        self.assertTrue(e[0]['right_uncertain'])
        self.assertTrue(e[1]['left_uncertain'])
        self.assertTrue(e[1]['recovered'])
        self.assertIsNone(r['coordinate_gaps']['summary']['total_count'])
        self.assertIsNone(r['coordinate_gaps']['summary']['max_fully_observed_completed_duration_ns'])

    def test_damage_and_dropped_events(self):
        for damage in ('gap','failure','corrupt'):
            self.example()
            text=self.path.read_text()
            if damage=='gap': text=text.replace('"event_id": "3"','"event_id": "30"')
            elif damage=='failure':
                text+=json.dumps(dict(schema='dronecv-session-timeline-1',session_id='synthetic',event_id='9',event_ns=str(2000*MS),type='recording_failure',data={'reason':'close'}))+'\n'
            else: text+='broken\n'
            self.path.write_text(text)
            r=self.analyze()
            self.assertFalse(r['recording_complete'])
            self.assertEqual(r['metrics']['duration_ns']['unknown'],1000*MS)
            self.assertEqual(r['coordinate_gaps']['episodes'],[])
            self.assertFalse(r['coordinate_gaps']['summary']['total_count_exact'])

    def test_missing_or_invalid_end_and_truncation(self):
        for ending in ('missing','truncated','invalid'):
            self.example()
            lines=self.path.read_text().splitlines(keepends=True)
            if ending=='missing': lines=lines[:-1]
            elif ending=='truncated': lines[-1]=lines[-1][:-4]
            else: lines[-1]=lines[-1].replace('"stop_ns": "2000000000"','"stop_ns": "bad"')
            self.path.write_text(''.join(lines))
            r=self.analyze()
            self.assertIsNone(r['metrics'])
            self.assertIsNone(r['interval']['stop_ns'])
            self.assertEqual(r['interval']['scope'],'unavailable')

    def test_zero_duration_and_same_time(self):
        self.write([(1000*MS,BOX,1000*MS),(1000*MS,None,None),(1000*MS,BOX,1000*MS)],stop=1000*MS)
        r=self.analyze()
        self.assertEqual(r['coordinate_gaps']['episodes'],[])
        self.assertIsNone(r['metrics']['coordinate_availability']['exact'])
        self.assertEqual(sum(r['metrics']['duration_ns'].values()),0)
        self.write([(1000*MS,BOX,1000*MS),(1000*MS,None,None),(1000*MS,BOX,1000*MS)])
        self.assertEqual(self.analyze()['coordinate_gaps']['episodes'],[])

    def test_large_absolute_times_and_correction_image(self):
        base=2**60+3
        self.write([(base,BOX,base-5,{'result_source':'correction','last_yolo_capture_ns':str(base-1000)}),
                    (base+2,BOX,base-5)],start=base,stop=base+10)
        r=self.analyze(threshold=8)
        self.assertEqual(r['metrics']['duration_ns']['fresh'],3)
        self.assertEqual(r['metrics']['duration_ns']['stale'],7)
        self.assertEqual(r['fresh_coordinate_gaps']['episodes'][0]['start_ns'],base+3)

    def test_interrupted_complete_recording(self):
        self.write([(1000*MS,None,None)],interrupted=True)
        r=self.analyze()
        self.assertTrue(r['recording_complete'])
        self.assertEqual(r['experiment_status'],'interrupted')
        self.assertEqual(r['metrics']['duration_ns']['absent'],1000*MS)

    def test_cli_and_csv(self):
        self.example()
        output=self.path.with_suffix('.json'); episodes=self.path.with_suffix('.csv')
        command=[sys.executable,str(Path(__file__).resolve().parents[1]/'scripts/timeline_analysis.py'),str(self.path),
                 '--max-coordinate-age-ms','200','--output',str(output),'--episodes-csv',str(episodes)]
        result=subprocess.run(command,capture_output=True,text=True,check=True)
        self.assertIn('present=600000000',result.stdout)
        self.assertEqual(json.loads(output.read_text()),self.analyze())
        with episodes.open() as stream: rows=list(csv.DictReader(stream))
        self.assertEqual(len(rows),4)
        self.assertEqual(rows[1]['recovery_ns'],'null')
        original=output.read_bytes()
        subprocess.run(command,capture_output=True,check=True)
        self.assertEqual(output.read_bytes(),original)
        command[command.index('200')]='NaN'
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_invalid_threshold(self):
        for value in (-1,1.5,True):
            with self.assertRaises(ValueError):
                self.analyze(value)

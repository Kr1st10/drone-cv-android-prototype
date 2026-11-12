"""Read the streaming Android timeline without rounding Android Long values."""
import hashlib
import json

SCHEMA = 'dronecv-session-timeline-1'


def integer(value, name):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise ValueError(f'{name}: expected a decimal string')
    return int(value)


def read_timeline(path):
    digest = hashlib.sha256()
    header = end = None
    counts = {}
    intervals = []
    errors = []
    previous_id = None
    current = None
    last_time = None
    failure = False
    damaged = False
    session_id = None
    gaps = []
    records_before_end = 0
    with path.open('rb') as stream:
        for line_no, raw in enumerate(stream, 1):
            digest.update(raw)
            if not raw.endswith(b'\n'):
                errors.append(f'truncated line {line_no}')
                damaged = True
                continue
            try:
                row = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('non-finite JSON')))
            except (ValueError, UnicodeDecodeError):
                errors.append(f'invalid line {line_no}')
                damaged = True
                continue
            if not isinstance(row, dict):
                errors.append(f'invalid envelope on line {line_no}')
                damaged = True
                continue
            if row.get('schema') != SCHEMA:
                raise ValueError(f'unsupported timeline schema: {row.get("schema")}')
            if not isinstance(row.get('data'), dict) or not isinstance(row.get('session_id'), str):
                errors.append(f'invalid envelope on line {line_no}')
                damaged = True
                continue
            try:
                eid = integer(row.get('event_id'), 'event_id')
                t = integer(row.get('event_ns'), 'event_ns')
            except ValueError as exc:
                errors.append(f'invalid envelope on line {line_no}: {exc}')
                damaged = True
                continue
            if session_id is None: session_id = row['session_id']
            if row['session_id'] != session_id: errors.append('mixed session IDs')
            if previous_id is None and eid != 1: errors.append('first event ID is not 1')
            if previous_id is not None and eid != previous_id + 1:
                errors.append('event ID gap or reversal')
                if eid > previous_id + 1: gaps.append((previous_id + 1, eid - 1))
            previous_id = eid
            last_time = t if last_time is None else max(last_time, t)
            kind, data = row.get('type'), row['data']
            counts[kind] = counts.get(kind, 0) + 1
            if kind not in ('session_end', 'recording_failure'): records_before_end += 1
            if end is not None and kind != 'recording_failure': errors.append('record after session_end')
            if kind == 'header':
                if header is not None or line_no != 1: errors.append('duplicate or misplaced header')
                header = data
                start = integer(data.get('start_ns'), 'start_ns')
                current = {'start_ns': start, 'box': None, 'reason': 'initial_unknown'}
            elif header is None:
                raise ValueError('missing timeline header')
            elif kind == 'state':
                published = integer(data.get('publication_ns'), 'publication_ns')
                last_time = max(last_time, published)
                if published < current['start_ns']:
                    errors.append('state publication time reversal')
                else:
                    intervals.append({**current, 'end_ns': published, 'duration_ns': published-current['start_ns']})
                    current = {**data, 'start_ns': published}
            elif kind == 'session_end':
                if end is not None: errors.append('duplicate session_end')
                end = data
            elif kind == 'recording_failure':
                failure = True
                errors.append('recording failure: ' + str(data.get('reason')))
            elif kind not in ('frame', 'detection', 'metadata', 'publication', 'resource', 'diagnostic_frame', 'tracking', 'frame_geometry', 'stale_discard', 'discard'):
                raise ValueError(f'unsupported timeline record type: {kind}')
    if header is None: raise ValueError('missing timeline header')
    try:
        stop = integer(end.get('stop_ns'), 'stop_ns') if end else last_time
    except ValueError:
        errors.append('invalid session_end stop_ns')
        stop = last_time
    if stop is not None and stop >= current['start_ns']:
        intervals.append({**current, 'end_ns': stop, 'duration_ns': stop-current['start_ns']})
    else: errors.append('invalid end time')
    if end:
        try:
            dropped = end.get('dropped_count')
            if isinstance(dropped, str): dropped = integer(dropped, 'dropped_count')
            if type(dropped) is not int or dropped < 0: errors.append('invalid dropped_count')
            if dropped and end.get('recording_complete'): errors.append('complete recording with dropped events')
            accepted = integer(end.get('accepted_count'), 'accepted_count')
            if accepted != records_before_end: errors.append('accepted_count mismatch')
            if integer(end.get('written_count'), 'written_count') != records_before_end: errors.append('written_count mismatch')
            if type(dropped) is int and sum(b-a+1 for a, b in gaps) != dropped: errors.append('dropped_count mismatch')
            first, last = end.get('missing_first_event_id'), end.get('missing_last_event_id')
            if gaps:
                if first is None or last is None or integer(first, 'missing_first_event_id') != gaps[0][0] or integer(last, 'missing_last_event_id') != gaps[-1][1]: errors.append('missing event bounds mismatch')
            elif first is not None or last is not None: errors.append('unexpected missing event bounds')
        except ValueError:
            errors.append('invalid session_end counters or missing bounds')
    else: errors.append('missing session_end')
    complete = bool(end and end.get('recording_complete') is True and not errors)
    # Lost records can contain state changes, and their event clocks need not be
    # ordered. Without trustworthy transition bounds, none of the carried boxes
    # can be asserted for the exported interval.
    uncertain = bool(errors or damaged or gaps or failure or (end and end.get('dropped_count') not in (None, '0', 0)))
    for interval in intervals:
        if uncertain:
            interval['observed_box'] = interval.get('box')
            interval['box'] = None
            interval['state_known'] = False
            interval['uncertainty'] = 'damaged or missing events; transition bounds unknown'
        else:
            interval['state_known'] = interval.get('reason') != 'initial_unknown'
        for key in ('start_ns', 'end_ns', 'duration_ns'):
            interval[key] = str(interval[key])
    return {'schema': SCHEMA, 'file': path.as_posix(), 'sha256': digest.hexdigest(), 'session_id': session_id,
            'header': header, 'end': end, 'recording_complete': complete,
            'experiment_status': end.get('experiment_status') if end else 'unknown',
            'duration_ns': str(stop-integer(header['start_ns'], 'start_ns')) if stop is not None else None,
            'intervals': intervals, 'counts': counts, 'errors': errors,
            'missing_extent': 'entire_interval_conservative' if uncertain else None,
            'metric_eligibility': {'physical_tracking': False, 'reason': 'independent reference required'}}


REPORT_SCHEMA = 'dronecv-coordinate-continuity-1'


def _box_valid(box):
    import math
    return (isinstance(box, list) and len(box) == 4
            and all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in box)
            and box[0] < box[2] and box[1] < box[3])


def _segments(timeline, threshold):
    segments = []
    for state in timeline['intervals']:
        a, b = int(state['start_ns']), int(state['end_ns'])
        if b <= a:
            continue
        reason = state.get('reason')
        category, issue = 'unknown', state.get('uncertainty')
        if state['state_known']:
            if 'box' not in state:
                issue = 'missing box'
            elif state['box'] is None:
                category = 'absent'
            elif _box_valid(state['box']):
                category = 'present'
            else:
                issue = 'invalid box'
        if category == 'unknown' and issue is None:
            issue = 'unconfirmed initial state'
        parts = [(a, b, category, issue)]
        if category == 'present':
            try:
                capture = integer(state.get('capture_ns'), 'capture_ns')
                entry = integer(state.get('analyzer_entry_ns'), 'analyzer_entry_ns')
                compatible = (timeline['header'].get('clock') == 'elapsed_realtime_ns'
                              and state.get('timestamp_source') == 'elapsed_realtime'
                              and state.get('publication_clock', 'elapsed_realtime_ns') == 'elapsed_realtime_ns'
                              and not state.get('timing_issue') and 0 < capture <= entry <= a)
            except ValueError:
                compatible = False
            if not compatible:
                parts = [(a, b, 'age_unknown', 'unusable exposure timestamp or clock')]
            else:
                expiry = capture + threshold
                parts = []
                if a < min(b, expiry):
                    parts.append((a, min(b, expiry), 'fresh', None))
                if max(a, expiry) < b:
                    parts.append((max(a, expiry), b, 'stale', None))
        for left, right, status, uncertainty in parts:
            segments.append(dict(start_ns=left, end_ns=right, status=status,
                                 reason='analytical_age_threshold' if left != a else reason,
                                 initial_snapshot=reason == 'initial_snapshot', uncertainty=uncertainty))
    return segments


def _series(segments, good, bad, start, stop):
    first = next((s for s in segments if s['status'] in good), None)
    episodes = []
    active = None
    seen = False
    previous = None
    for s in segments:
        status = s['status']
        if status in good:
            if active is not None:
                active.update(recovered=True, recovery_ns=s['start_ns'])
                active = None
            seen = True
        elif status in bad and seen:
            if active is None:
                active = dict(start_ns=s['start_ns'], end_ns=s['end_ns'], recovered=False,
                              recovery_ns=None, left_uncertain=previous not in good,
                              right_uncertain=False, right_censored=False, transitions=[])
                episodes.append(active)
            active['end_ns'] = s['end_ns']
            transition = dict(time_ns=s['start_ns'], state=status, reason=s['reason'])
            if not active['transitions'] or any(active['transitions'][-1][k] != transition[k] for k in ('state', 'reason')):
                active['transitions'].append(transition)
        elif status not in bad:
            if active is not None:
                active['right_uncertain'] = True
                active = None
        previous = status
    if active is not None:
        active['right_censored'] = True
    for e in episodes:
        e['duration_ns'] = e['end_ns'] - e['start_ns']
        e['duration_is_lower_bound'] = e['left_uncertain'] or e['right_uncertain'] or e['right_censored']
    fully_completed = [e['duration_ns'] for e in episodes if e['recovered'] and not e['duration_is_lower_bound']]
    unknown = any(s['status'] not in good | bad for s in segments)
    summary = dict(observed_episode_count=len(episodes),
                   observed_start_count=sum(not e['left_uncertain'] for e in episodes),
                   completed_recovery_count=sum(e['recovered'] for e in episodes),
                   unfinished_at_stop_count=sum(e['right_censored'] for e in episodes),
                   uncertain_boundary_count=sum(e['left_uncertain'] or e['right_uncertain'] for e in episodes),
                   total_count_exact=not unknown,
                   total_count=len(episodes) if not unknown else None,
                   max_observed_duration_ns=max((e['duration_ns'] for e in episodes), default=None),
                   max_fully_observed_completed_duration_ns=max(fully_completed, default=None),
                   mean_fully_observed_recovery_ns=sum(fully_completed)/len(fully_completed) if fully_completed else None)
    first_info = dict(time_ns=first['start_ns'] if first else None,
                      in_initial_snapshot=bool(first and first['initial_snapshot'] and first['start_ns'] == start),
                      observed_wait_ns=(first['start_ns'] if first else stop)-start,
                      wait_right_censored=first is None,
                      wait_uncertain=any(s['status'] not in good | bad for s in segments
                                         if first is None or s['start_ns'] < first['start_ns']))
    return dict(first_observation=first_info, summary=summary, episodes=episodes)


def analyze_timeline(path, *, max_coordinate_age_ns):
    """Analyze reader intervals using an explicit nonnegative integer age threshold.

    Returns a deterministic JSON-compatible report. Unbounded recordings have no
    full-run metrics. Reader errors remain authoritative; observed_box is unused.
    Raises ValueError for invalid thresholds or unsupported input (via reader).
    """
    if type(max_coordinate_age_ns) is not int or max_coordinate_age_ns < 0:
        raise ValueError('max_coordinate_age_ns must be a nonnegative integer')
    timeline = read_timeline(path)
    start = integer(timeline['header']['start_ns'], 'start_ns')
    try:
        stop = integer(timeline['end'].get('stop_ns'), 'stop_ns') if timeline['end'] else None
    except ValueError:
        stop = None
    boundaries = [(int(s['start_ns']), int(s['end_ns'])) for s in timeline['intervals']]
    bounded = (stop is not None and stop >= start and bool(boundaries)
               and boundaries[0][0] == start and boundaries[-1][1] == stop
               and all(a <= b for a, b in boundaries)
               and all(x[1] == y[0] for x, y in zip(boundaries, boundaries[1:]))
               and not any(x in error for error in timeline['errors']
                           for x in ('mixed session', 'header', 'duplicate session_end', 'record after session_end', 'time reversal')))
    report = dict(schema=REPORT_SCHEMA, session_id=timeline['session_id'], sha256=timeline['sha256'],
                  header=timeline['header'], session_end=timeline['end'],
                  recording_complete=timeline['recording_complete'], experiment_status=timeline['experiment_status'],
                  integrity_errors=timeline['errors'], missing_extent=timeline['missing_extent'],
                  parameters={'max_coordinate_age': {'value': max_coordinate_age_ns, 'unit': 'ns'},
                              'freshness_rule': 'age < threshold; analytical estimate, not runtime expiry'},
                  interval=dict(start_ns=start, stop_ns=stop if bounded else None,
                                duration_ns=stop-start if bounded else None,
                                scope='bounded_recording' if bounded else 'unavailable'),
                  metrics=None, coordinate_gaps=None, fresh_coordinate_gaps=None,
                  unavailable_reasons=[], unknown_reasons=[])
    if not bounded:
        report['unavailable_reasons'] = ['trustworthy recording boundaries unavailable; full-run metrics not computed']
        return report
    segments = _segments(timeline, max_coordinate_age_ns)
    durations = dict.fromkeys(('present', 'absent', 'unknown', 'fresh', 'stale', 'age_unknown'), 0)
    for s in segments:
        d = s['end_ns'] - s['start_ns']
        durations[s['status']] += d
        if s['status'] in ('fresh', 'stale', 'age_unknown'):
            durations['present'] += d
    duration = stop-start
    assert durations['present'] + durations['absent'] + durations['unknown'] == duration
    assert durations['fresh'] + durations['stale'] + durations['age_unknown'] == durations['present']
    def fraction(n):
        return n/duration if duration else None
    def bounds(known, unknown):
        return dict(exact=fraction(known) if unknown == 0 else None,
                    lower=fraction(known), upper=fraction(known+unknown))
    report['metrics'] = dict(duration_ns=durations,
                             time_fraction={k: fraction(v) for k, v in durations.items()},
                             coordinate_availability=bounds(durations['present'], durations['unknown']),
                             fresh_coordinate_availability=bounds(durations['fresh'], durations['unknown']+durations['age_unknown']))
    report['coordinate_gaps'] = _series(segments, {'fresh', 'stale', 'age_unknown'}, {'absent'}, start, stop)
    report['fresh_coordinate_gaps'] = _series(segments, {'fresh'}, {'absent', 'stale'}, start, stop)
    report['unknown_reasons'] = sorted({s['uncertainty'] for s in segments if s['uncertainty']})
    if duration == 0:
        report['unavailable_reasons'].append('zero duration: fractions undefined')
    return report


def write_episode_csv(report, path):
    """Write both episode series as UTF-8 CSV; null fields use literal null."""
    import csv
    fields = ['gap_type', 'start_ns', 'end_ns', 'duration_ns', 'recovered', 'recovery_ns',
              'left_uncertain', 'right_uncertain', 'right_censored', 'duration_is_lower_bound', 'transitions']
    with path.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for name in ('coordinate_gaps', 'fresh_coordinate_gaps'):
            for e in (report[name] or {}).get('episodes', []):
                writer.writerow({'gap_type': name, **{k: json.dumps(v, ensure_ascii=False) for k, v in e.items()}})


def main():
    """Run the standalone continuity CLI, preserving the legacy analyzer modes."""
    import argparse
    from decimal import Decimal, InvalidOperation
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Coordinate continuity and analytical freshness over the full timeline')
    parser.add_argument('input', type=Path)
    parser.add_argument('--max-coordinate-age-ms', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--episodes-csv', required=True, type=Path)
    args = parser.parse_args()
    try:
        ns = Decimal(args.max_coordinate_age_ms) * 1000000
        if not ns.is_finite() or ns < 0 or ns != ns.to_integral_value():
            raise ValueError('age threshold must be nonnegative with integer nanosecond precision')
        if args.input.resolve() in (args.output.resolve(), args.episodes_csv.resolve()) or args.output.resolve() == args.episodes_csv.resolve():
            raise ValueError('input and output paths must be distinct')
        report = analyze_timeline(args.input, max_coordinate_age_ns=int(ns))
    except (ValueError, InvalidOperation) as exc:
        parser.error(str(exc))
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    write_episode_csv(report, args.episodes_csv)
    print(f"Session {report['session_id']}: {report['interval']['scope']}; complete={report['recording_complete']}; experiment={report['experiment_status']}")
    if report['metrics'] is None:
        print('; '.join(report['unavailable_reasons']))
    else:
        d = report['metrics']['duration_ns']
        print(f"Duration {report['interval']['duration_ns']} ns; present={d['present']}, absent={d['absent']}, unknown={d['unknown']} ns")
        print(f"Fresh={d['fresh']}, stale={d['stale']}, age_unknown={d['age_unknown']} ns")
        for key in ('coordinate_gaps', 'fresh_coordinate_gaps'):
            s = report[key]['summary']
            print(f"{key}: observed starts={s['observed_start_count']}, recoveries={s['completed_recovery_count']}, unfinished={s['unfinished_at_stop_count']}, count_exact={s['total_count_exact']}")


if __name__ == '__main__':
    main()

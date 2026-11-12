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

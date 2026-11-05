#!/usr/bin/env python3
"""Recompute and validate Android diagnostics schema 1; no third-party dependencies."""
import argparse
import hashlib
import json
import math
import statistics
from pathlib import Path

STAGES = {'conversion': 'conversion_ms', 'preprocessing': 'preprocess_ms',
          'ort_including_tensor_copy': 'ort_ms', 'postprocessing_nms': 'postprocess_ms',
          'analyzer_pipeline': 'pipeline_ms'}


def summary(values):
    if not values:
        return None
    if any(not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x) or x < 0 for x in values):
        raise ValueError('invalid timing')
    ordered = sorted(values)
    n = len(ordered)
    return {'count': n, 'mean': statistics.mean(ordered), 'median': statistics.median(ordered),
            'p95_nearest_rank': ordered[math.ceil(.95 * n)-1] if n >= 20 else None,
            'min': ordered[0], 'max': ordered[-1]}


def equal(a, b):
    if a is None or b is None:
        return a is b
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6)


def analyze_target_signals(d, errors):
    if d.get('target_signal_schema_version') != 1:
        raise ValueError('unsupported target_signal_schema_version')
    signals = [f['target_signal'] for f in d['frames'] if f.get('target_signal') is not None]
    seen = set()
    for s in signals:
        if s['frame_id'] in seen: errors.append('target_signal: duplicate frame_id')
        seen.add(s['frame_id'])
        capture, entry, dispatch = s['capture_ns'], s['analyzer_entry_ns'], s['signal_dispatch_ns']
        if not all(type(x) is int and x >= 0 for x in (entry, dispatch)):
            raise ValueError('invalid target signal timestamps')
        issue = ('unsynchronized_camera_clock' if s['timestamp_source'] != 'elapsed_realtime' else
                 'missing_capture_timestamp' if capture is None or capture <= 0 else
                 'capture_after_analyzer' if capture > entry else
                 'non_monotonic_dispatch_clock' if dispatch < entry else None)
        if s['timestamp_source'] not in ('elapsed_realtime', 'unknown'): errors.append('target_signal: unknown timestamp_source')
        if s['timing_issue'] != issue: errors.append('target_signal: timing_issue mismatch')
        expected = {'capture_to_signal_ms': (dispatch-capture)/1e6 if issue is None else None,
                    'capture_to_analyzer_ms': (entry-capture)/1e6 if issue is None else None,
                    'analyzer_to_signal_ms': (dispatch-entry)/1e6 if dispatch >= entry else None}
        for key, value in expected.items():
            if not equal(s[key], value): errors.append('target_signal: mismatch ' + key)
        if s['coordinate_space'] != 'upright_crop_pixels': errors.append('target_signal: unknown coordinate space')
        if s['width'] <= 0 or s['height'] <= 0: errors.append('target_signal: invalid dimensions')
        points = ([s['observed']] if s['observed'] is not None else []) + [f['point'] for f in s['forecast']]
        for point in points:
            if not (0 <= point['x'] <= s['width']-1 and 0 <= point['y'] <= s['height']-1):
                errors.append('target_signal: point outside image')
        if s['status'] not in ('observed', 'lost', 'no_target'): errors.append('target_signal: unknown status')
        if (s['status'] == 'observed') != (s['observed'] is not None): errors.append('target_signal: status/observation mismatch')
        for f in s['forecast']:
            if (issue is not None or s['status'] != 'observed' or f['after_signal_ms'] not in (0, 100, 200) or
                    expected['capture_to_signal_ms'] + f['after_signal_ms'] > 1000):
                errors.append('target_signal: invalid forecast horizon or clock')
    timings = {}
    for stage in ('capture_to_signal', 'capture_to_analyzer', 'analyzer_to_signal'):
        calculated = summary([s[stage+'_ms'] for s in signals if s[stage+'_ms'] is not None])
        timings[stage] = calculated
        exported = d['timing_summary_ms'].get(stage)
        if calculated is None or exported is None:
            if calculated != exported: errors.append(stage + ': empty summary mismatch')
        elif any(not equal(v, exported.get(k)) for k, v in calculated.items()): errors.append(stage + ': summary mismatch')
    prediction_error = summary([s['one_step_prediction_error_px'] for s in signals if s['one_step_prediction_error_px'] is not None])
    exported = d.get('one_step_prediction_error_px')
    if prediction_error is None or exported is None:
        if prediction_error != exported: errors.append('prediction error: empty summary mismatch')
    elif any(not equal(v, exported.get(k)) for k, v in prediction_error.items()): errors.append('prediction error: summary mismatch')
    stale = d.get('application_stale_frames_discarded', 0)
    if type(stale) is not int or stale < 0: errors.append('invalid application stale counter')
    return {'count': len(signals), 'without_exposure_latency': sum(s['capture_to_signal_ms'] is None for s in signals),
            'timings_ms': timings, 'one_step_prediction_error_px': prediction_error, 'application_stale_frames_discarded': stale}


def analyze(d, filename='', digest=''):
    errors, warnings = [], []
    if d.get('schema_version') != 1:
        raise ValueError('unsupported schema_version')
    duration = d['duration_ms']
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration < 0:
        raise ValueError('invalid duration')
    frames, resources = d['frames'], d['resources']
    for name, rows in [('frames', frames), ('resources', resources)]:
        offsets = [r['offset_ms'] for r in rows]
        if any(not isinstance(x, (float, int)) or isinstance(x, bool) or not math.isfinite(x) or x < 0 or x > duration for x in offsets):
            errors.append(name + ': invalid offset')
        if any(b < a for a, b in zip(offsets, offsets[1:])):
            errors.append(name + ': non-monotonic offsets')
    n = d['completed_frames']; un = d['unstored_frames']; accepted = d['analyzer_callbacks_accepted']
    if not all(isinstance(x, int) and not isinstance(x, bool) and x >= 0 for x in (n, un, accepted)):
        raise ValueError('invalid frame counters')
    if n != len(frames) + un: errors.append('completed != stored + unstored')
    if accepted < n or d['accepted_callbacks_not_completed'] != accepted - n: errors.append('callback counters disagree')
    fps = n * 1000 / duration if duration else None
    if not equal(fps, d['processed_fps_session']): errors.append('FPS differs from counters/duration')
    if un: warnings.append('frame samples truncated; distributions cover stored frames only')
    if d['interrupted']: warnings.append('session interrupted: ' + str(d['reason']))
    if not duration: warnings.append('zero-duration session')
    stats = {}
    for name, field in STAGES.items():
        s = summary([r[field] for r in frames]); stats[name] = s
        old = d['timing_summary_ms'].get(name)
        if s is None or old is None:
            if s != old: errors.append(name + ': empty summary mismatch')
        else:
            for k in s:
                if not equal(s[k], old.get(k)): errors.append(name + ': mismatch ' + k)
    def series(key):
        return [r[key] for r in resources if r.get(key) is not None]
    res = {}
    for key in ['pss_kb', 'thermal_status', 'battery_percent', 'battery_status', 'battery_temperature_c']:
        vals = series(key)
        res[key] = {'count': len(vals), 'first': vals[0] if vals else None, 'last': vals[-1] if vals else None,
                    'min': min(vals) if vals else None, 'max': max(vals) if vals else None,
                    'distinct': sorted(set(vals))}
    pss = series('pss_kb'); delta = pss[-1] - pss[0] if len(pss) >= 2 else None
    if not equal(delta, d.get('pss_first_to_last_sample_delta_kb')): errors.append('PSS delta mismatch')
    windows = []
    for start in range(0, math.ceil(duration), 60000):
        end = min(start + 60000, duration)
        selected = [r for r in frames if start <= r['offset_ms'] < end or (end == duration and r['offset_ms'] == end)]
        windows.append({'start_ms': start, 'end_ms': end, 'frames': len(selected),
                        'fps': len(selected)*1000/(end-start),
                        'pipeline': summary([r['pipeline_ms'] for r in selected]),
                        'ort': summary([r['ort_ms'] for r in selected])})
    if un: warnings.append('window FPS excludes unstored frames')
    if frames:
        total_pipeline = sum(r['pipeline_ms'] for r in frames)
        ort_share = sum(r['ort_ms'] for r in frames) / total_pipeline if total_pipeline else None
    else: ort_share = None
    result = {'file': filename, 'sha256': digest, 'started_epoch_ms': d['started_epoch_ms'],
            'device': d['device'], 'android_release': d['android_release'], 'android_sdk': d['android_sdk'],
            'app_version': d['app_version'], 'model': d['model'], 'duration_ms': duration,
            'interrupted': d['interrupted'], 'reason': d['reason'], 'accepted': accepted,
            'completed': n, 'unstored': un, 'accepted_not_completed': d['accepted_callbacks_not_completed'],
            'fps': fps, 'stages_ms': stats, 'ort_share_of_pipeline': ort_share, 'resources': res,
            'pss_delta_kb': delta, 'minute_windows': windows, 'errors': errors, 'warnings': warnings}
    # Preserve the stage 5.2 output for old files, expose the additive 5.3 metadata when present.
    if 'build_type' in d: result['build_type'] = d['build_type']
    if 'warmup' in d: result['warmup'] = d['warmup']
    if 'target_signal_schema_version' in d: result['target_signals'] = analyze_target_signals(d, errors)
    return result


def thread_comparison_key(run):
    model = dict(run['model'])
    n = model.pop('intra_op_threads', None)
    backend = model.pop('backend', None)
    if type(n) is not int or n not in (1, 2, 4): raise ValueError('explicit intra_op_threads required')
    if backend != f'ONNX Runtime CPU, intra-op {n}, inter-op 1': raise ValueError('backend inconsistent with explicit threads')
    if model.get('inter_op_threads') != 1 or model.get('execution_mode') != 'SEQUENTIAL' or model.get('execution_provider') != 'CPU':
        raise ValueError('unexpected ORT configuration')
    if not isinstance(run.get('build_type'), str) or not run['build_type'] or run['build_type'] == 'unknown':
        raise ValueError('explicit build_type required')
    warmup = run.get('warmup')
    if not isinstance(warmup, dict) or warmup.get('method') != 'manual' or type(warmup.get('completed_frames_before_session')) is not int or warmup['completed_frames_before_session'] < 0:
        raise ValueError('explicit manual warmup required')
    return (run['device'], run['android_release'], run['android_sdk'], run['app_version'], run['build_type'], model)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('inputs', nargs='+', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--compare-threads', action='store_true', help='allow only explicit 1/2/4 intra-op differences in 5.3 reports')
    args = p.parse_args()
    runs = []
    for path in args.inputs:
        raw = path.read_bytes()
        d = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('non-finite JSON')))
        runs.append(analyze(d, path.as_posix(), hashlib.sha256(raw).hexdigest()))
    runs.sort(key=lambda x: (x['started_epoch_ms'], x['file']))
    config_fields = ('device','android_release','android_sdk','app_version','model')
    if args.compare_threads:
        keys = [thread_comparison_key(r) for r in runs]
        mismatches = [r['file'] for r, key in zip(runs[1:], keys[1:]) if key != keys[0]]
    else:
        mismatches = [r['file'] for r in runs[1:] if any(r[k] != runs[0][k] for k in config_fields)]
    output = {'schema_version': 1, 'config_mismatches': mismatches, 'sessions': runs}
    if args.compare_threads:
        groups = {}
        excluded = [r['file'] for r in runs if r['interrupted'] or r['unstored'] or not r['completed'] or r['duration_ms'] <= 0 or r['errors']]
        output['excluded_sessions'] = excluded
        for r in runs:
            if r['file'] in excluded:
                continue
            n = str(r['model']['intra_op_threads'])
            groups.setdefault(n, []).append(r)
        output['thread_groups'] = {n: {'sessions': len(rs),
            'median_session_fps': statistics.median([r['fps'] for r in rs if r['fps'] is not None]) if any(r['fps'] is not None for r in rs) else None,
            'median_session_pipeline_median_ms': statistics.median([r['stages_ms']['analyzer_pipeline']['median'] for r in rs if r['stages_ms']['analyzer_pipeline']]) if any(r['stages_ms']['analyzer_pipeline'] for r in rs) else None,
            'median_session_pipeline_p95_ms': statistics.median([r['stages_ms']['analyzer_pipeline']['p95_nearest_rank'] for r in rs if r['stages_ms']['analyzer_pipeline'] and r['stages_ms']['analyzer_pipeline']['p95_nearest_rank'] is not None]) if any(r['stages_ms']['analyzer_pipeline'] and r['stages_ms']['analyzer_pipeline']['p95_nearest_rank'] is not None for r in rs) else None}
            for n, rs in sorted(groups.items())} 
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    if mismatches or any(r['errors'] for r in runs) or (args.compare_threads and output['excluded_sessions']):
        raise SystemExit('Integrity errors or incomparable configuration; see output')

if __name__ == '__main__': main()

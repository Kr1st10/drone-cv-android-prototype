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
        selected = [r for r in frames if start <= r['offset_ms'] < end]
        windows.append({'start_ms': start, 'end_ms': end, 'frames': len(selected),
                        'fps': len(selected)*1000/(end-start),
                        'pipeline': summary([r['pipeline_ms'] for r in selected]),
                        'ort': summary([r['ort_ms'] for r in selected])})
    if un: warnings.append('window FPS excludes unstored frames')
    if frames:
        total_pipeline = sum(r['pipeline_ms'] for r in frames)
        ort_share = sum(r['ort_ms'] for r in frames) / total_pipeline if total_pipeline else None
    else: ort_share = None
    return {'file': filename, 'sha256': digest, 'started_epoch_ms': d['started_epoch_ms'],
            'device': d['device'], 'android_release': d['android_release'], 'android_sdk': d['android_sdk'],
            'app_version': d['app_version'], 'model': d['model'], 'duration_ms': duration,
            'interrupted': d['interrupted'], 'reason': d['reason'], 'accepted': accepted,
            'completed': n, 'unstored': un, 'accepted_not_completed': d['accepted_callbacks_not_completed'],
            'fps': fps, 'stages_ms': stats, 'ort_share_of_pipeline': ort_share, 'resources': res,
            'pss_delta_kb': delta, 'minute_windows': windows, 'errors': errors, 'warnings': warnings}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('inputs', nargs='+', type=Path)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    runs = []
    for path in args.inputs:
        raw = path.read_bytes()
        d = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('non-finite JSON')))
        runs.append(analyze(d, path.as_posix(), hashlib.sha256(raw).hexdigest()))
    runs.sort(key=lambda x: (x['started_epoch_ms'], x['file']))
    config_fields = ('device','android_release','android_sdk','app_version','model')
    mismatches = [r['file'] for r in runs[1:] if any(r[k] != runs[0][k] for k in config_fields)]
    output = {'schema_version': 1, 'config_mismatches': mismatches, 'sessions': runs}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    if mismatches or any(r['errors'] for r in runs):
        raise SystemExit('Integrity errors or incomparable configuration; see output')

if __name__ == '__main__': main()

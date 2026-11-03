#!/usr/bin/env python3
"""Produce chart-builder specifications from checked analysis and original resources."""
import argparse
import hashlib
import json
import statistics
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('summary', type=Path)
p.add_argument('--output-dir', type=Path, required=True)
a = p.parse_args()
r = json.loads(a.summary.read_text())['sessions'][-1]
if r['errors'] or r['unstored']:
    raise SystemExit('Selected session has errors or truncated frames')
data = Path(r['file']).read_bytes()
if hashlib.sha256(data).hexdigest() != r['sha256']:
    raise SystemExit('Source file hash does not match analysis')
raw = json.loads(data)
windows = [w for w in r['minute_windows'] if w['end_ms']-w['start_ms'] == 60000]
if len(windows) < 4:
    raise SystemExit('Need at least four complete minutes')
labels = [f'{i+1} мин' for i in range(len(windows))]
temps = []
for w in windows:
    values = [x['battery_temperature_c'] for x in raw['resources'] if w['start_ms'] <= x['offset_ms'] < w['end_ms'] and x['battery_temperature_c'] is not None]
    temps.append(statistics.mean(values) if values else None)
specs = [dict(version=1,layout='report',form='trend-line',title='В долгой сессии среднее время цикла выросло к 17-й минуте',aside='Mi 8 Lite; 17 полных минут, среднее по завершённым кадрам',labels=labels,axis={'floor':1500},fill='none',series=[dict(label='Pipeline, среднее',valueKind='durationMs',role='subject',data=[w['pipeline']['mean'] if w['pipeline'] else None for w in windows],derived=True,derivationReason='Арифметическое среднее сохранённых кадров в каждой минуте')]),dict(version=1,layout='report',form='trend-line',title='Температура батареи в долгом прогоне выросла',aside='Mi 8 Lite; 17 полных минут, среднее по пробам; °C, не температура CPU',labels=labels,axis={'floor':35},fill='none',series=[dict(label='Температура батареи, °C',valueKind='number',role='subject',data=temps,derived=True,derivationReason='Арифметическое среднее доступных проб батареи в каждой минуте')])]
if len(windows) != 17:
    raise SystemExit('These chart titles describe exactly 17 full minutes; adjust for another run')
a.output_dir.mkdir(parents=True, exist_ok=True)
for name, obj in zip(['pipeline','battery'], specs):
    (a.output_dir/(name+'_spec.json')).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

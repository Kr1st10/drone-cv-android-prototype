"""Validation-only ONNX comparison; uses the existing stage 4.5 matcher.

Never reads final test images for inference and never tunes on test.
"""
from __future__ import annotations
import argparse
import json
import platform
import time
from pathlib import Path
import numpy as np
from ml.dataset45.cli import image_path
from ml.dataset45.core import load_manifest, sha256_bytes
from ml.dataset45.evaluate import evaluate_records
from ml.dataset45.splits import make_split
from ml.training62 import preflight
from ml.train62 import digest
from ml.scripts import drone_detector as dd
from ml.scripts.evaluate import match, iou_matrix

THRESHOLDS=(.05,.1,.15,.2,.25,.35,.5,.7,.9)


def localization(records, predictions):
    """Per-FP overlaps, geometric rather than semantic attribution; categories can overlap."""
    byid = {p['id']: p for p in predictions}
    counts = {'fp_partial_drone_iou_0.1_to_lt_0.5': 0, 'fp_overlap_bird_iou_ge_0.1': 0,
              'fp_overlap_airplane_iou_ge_0.1': 0, 'fp_no_overlap_ge_0.1': 0}
    for r in records:
        boxes = byid[r['id']]['predictions']
        xy = np.asarray([b[:4] for b in boxes], dtype=float).reshape(-1, 4)
        scores = np.asarray([b[4] for b in boxes])
        gt = np.asarray([a['xyxy'] for a in r['annotations'] if a['class'] == 'drone'], dtype=float).reshape(-1, 4)
        tp, _, _ = match(xy, scores, gt, .5)
        overlaps = {}
        for kind in ('drone', 'bird', 'airplane'):
            truth = np.asarray([a['xyxy'] for a in r['annotations'] if a['class'] == kind], dtype=float).reshape(-1, 4)
            m = iou_matrix(xy, truth)
            overlaps[kind] = m.max(axis=1) if m.shape[1] else np.zeros(len(xy))
        for i in np.flatnonzero(~tp):
            if .1 <= overlaps['drone'][i] < .5: counts['fp_partial_drone_iou_0.1_to_lt_0.5'] += 1
            if overlaps['bird'][i] >= .1: counts['fp_overlap_bird_iou_ge_0.1'] += 1
            if overlaps['airplane'][i] >= .1: counts['fp_overlap_airplane_iou_ge_0.1'] += 1
            if all(overlaps[k][i] < .1 for k in overlaps): counts['fp_no_overlap_ge_0.1'] += 1
    return counts


def curve(records, predictions):
    """post-NMS predictions captured at >.05; scene slices are not FP attribution."""
    results=[]
    for t in THRESHOLDS:
        selected=[dict(p, predictions=[b for b in p['predictions'] if b[4] > t]) for p in predictions]
        overall=evaluate_records(records, selected, t, .5)
        byid={p['id']:p for p in selected}
        groups={}
        for kind in ('bird','airplane'):
            group=[r for r in records if not any(a['class']=='drone' for a in r['annotations']) and any(a['class']==kind for a in r['annotations'])]
            if group:
                ev=evaluate_records(group,[byid[r['id']] for r in group],t,.5)
                groups[kind]={'images':len(group),'fp':ev['counts'].get('fp',0), 'images_with_fp':ev['negative_images'].get('images_with_fp',0)}
            else: groups[kind]={'images':0,'fp':0,'images_with_fp':0}
        results.append({'confidence':t,'metrics':overall,'negative_class_slices':groups, 'fp_geometry': localization(records, selected)})
    return results


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest',type=Path,required=True);p.add_argument('--lock',type=Path,required=True)
    p.add_argument('--reference',type=Path,action='append',default=[]);p.add_argument('--onnx',type=Path,required=True)
    p.add_argument('--model-id',required=True);p.add_argument('--expected-sha256',required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--threads',type=int,default=2)
    a=p.parse_args(argv)
    if a.threads<1:raise ValueError('threads must be positive')
    if digest(a.onnx)!=a.expected_sha256:raise ValueError('model SHA mismatch')
    if a.output.resolve().is_relative_to(a.manifest.parent.resolve()):raise ValueError('output must be outside dataset directory')
    report=preflight(a.manifest,a.lock,a.reference)
    records=load_manifest(a.manifest)['records']; lock=json.loads(a.lock.read_text());lock=lock.get('lock',lock)
    assign,_,_=make_split(records,lock['seed'],lock)
    records=sorted((r for r in records if assign[r['id']]=='validation'),key=lambda r:r['id'])
    detector=dd.DroneDetector(a.onnx,threads=a.threads)
    ins=detector.session.get_inputs();outs=detector.session.get_outputs()
    if len(ins)!=1 or ins[0].shape != [1,3,640,640] or len(outs)!=1 or outs[0].shape != [1,5,8400]:raise ValueError('only single-class static YOLO11 640 output is supported')
    # Warm-up with the first validation frame; excluded from per-image timing.
    rgb=dd.load_rgb(image_path(a.manifest,records[0]))
    for _ in range(3):detector.detect(rgb,conf=.05,iou=.7)
    predictions=[]
    for r in records:
        rgb=dd.load_rgb(image_path(a.manifest,r));start=time.perf_counter()
        detections=detector.detect(rgb,conf=.05,iou=.7); elapsed=1000*(time.perf_counter()-start)
        boxes=[[d.x1,d.y1,d.x2,d.y2,d.score] for d in detections if d.x2>d.x1 and d.y2>d.y1]
        predictions.append({'id':r['id'],'predictions':boxes,'ms':elapsed})
    import onnxruntime as ort
    result={'split':'validation','purpose':'development','model_id':a.model_id,'model_sha256':digest(a.onnx),
            'dataset':report,'prediction_floor':.05,'nms_iou':.7,'match_iou':.5,
            'timing_conditions':{'backend':'CPUExecutionProvider','threads':a.threads,'warmup_frames':3,
               'scope':'preprocess, ORT and postprocess/NMS; image decode excluded', 'platform':platform.platform(), 'onnxruntime':ort.__version__},
            'curve':curve(records,predictions),'predictions':predictions,
            'warning':'Validation-only exploratory curve. Threshold choice requires a later untouched test. Bird/airplane scene slices are image-level; overlap counts are non-exclusive geometric indicators, not verified causes. Frames may be correlated.'}
    a.output.parent.mkdir(parents=True,exist_ok=True)
    if a.output.exists():raise ValueError('refusing to overwrite output')
    a.output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n'); print(f'Wrote {a.output}')
    return 0

if __name__=='__main__':raise SystemExit(main())

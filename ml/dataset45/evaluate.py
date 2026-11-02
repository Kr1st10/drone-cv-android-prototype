"""Evaluate *saved post-NMS predictions* using the project's shared matcher.

No model inference is performed here. Test access requires a frozen split and
an explicit 'final' purpose. This guard cannot police later human reuse.
"""
from __future__ import annotations
import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path
import numpy as np
from ml.scripts.evaluate import match
from .core import load_manifest, sha256_bytes
from .cli import check
from .splits import make_split


def evaluate_records(records, predictions, confidence, match_iou=.5):
    if not isinstance(confidence,(int,float)) or isinstance(confidence,bool) or not math.isfinite(confidence) or not 0<=confidence<=1:raise ValueError('invalid confidence threshold')
    if not isinstance(match_iou,(int,float)) or not 0<match_iou<=1:raise ValueError('invalid matching IoU')
    byid={x['id']:x for x in predictions}
    if len(byid)!=len(predictions) or set(byid)!={r['id'] for r in records}:raise ValueError('predictions must contain exactly one entry per split image')
    total=Counter();buckets={k:Counter() for k in ('<16','16-<24','24-<30','>=30')};negative=Counter();times=[]
    for r in records:
        entry=byid[r['id']];p=entry['predictions']
        if not isinstance(p,list):raise ValueError('predictions must be a list')
        for box in p:
            if not isinstance(box,list) or len(box)!=5 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in box):raise ValueError('invalid prediction')
            x1,y1,x2,y2,score=box
            if not (0<=x1<x2<=r['width'] and 0<=y1<y2<=r['height'] and confidence<score<=1):raise ValueError('prediction outside image or threshold')
        gt=[a for a in r['annotations'] if a['class']=='drone']
        boxes=np.array([x[:4] for x in p],dtype=float).reshape(-1,4);scores=np.array([x[4] for x in p],dtype=float)
        truth=np.array([x['xyxy'] for x in gt],dtype=float).reshape(-1,4)
        tp,hit,_=match(boxes,scores,truth,match_iou)
        t=int(tp.sum());f=int((~tp).sum());n=int((~hit).sum());total.update(tp=t,fp=f,fn=n,images=1)
        if not gt:negative.update(images=1,fp=f,images_with_fp=int(f>0))
        for a,h in zip(gt,hit):
            x1,y1,x2,y2=a['xyxy'];size=math.sqrt((x2-x1)*(y2-y1))
            k='<16' if size<16 else '16-<24' if size<24 else '24-<30' if size<30 else '>=30'
            buckets[k].update(n=1,tp=int(h))
        if 'ms' in entry:
            v=entry['ms']
            if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0:raise ValueError('invalid time')
            times.append(v)
    if times and len(times)!=len(records):raise ValueError('timings must cover all images or none')
    tp,fp,fn=total['tp'],total['fp'],total['fn']
    return {'counts':dict(total),'precision_all':tp/(tp+fp) if tp+fp else None,'recall':tp/(tp+fn) if tp+fn else None,
            'recall_by_size':{k:{'n':v['n'],'tp':v['tp'],'recall':v['tp']/v['n'] if v['n'] else None} for k,v in buckets.items()},
            'negative_images':dict(negative),'timing_ms':{'mean':float(np.mean(times)),'median':float(np.median(times))} if times else None}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--lock',type=Path,required=True)
    p.add_argument('--predictions',type=Path,required=True);p.add_argument('--split',choices=['train','validation','test'],required=True)
    p.add_argument('--purpose',choices=['development','final'],required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args(argv)
    if (a.split=='test')!=(a.purpose=='final'):raise ValueError('test requires purpose=final; development uses only train/validation')
    data=load_manifest(a.manifest);valid=check(a.manifest,data)
    if valid['error_count']:raise ValueError('invalid manifest/images')
    lock=json.loads(a.lock.read_text());lock=lock.get('lock',lock)
    if a.split=='test' and not lock.get('test_frozen'):raise ValueError('final test is not frozen')
    assignments,_,_=make_split(data['records'],lock['seed'],lock)
    selected=[r for r in data['records'] if assignments[r['id']]==a.split]
    if not selected:raise ValueError('empty selected split')
    pred=json.loads(a.predictions.read_text());config=pred['config']
    if not re.fullmatch(r'[0-9a-f]{64}',config.get('model_sha256','')):raise ValueError('model_sha256 required')
    if not str(config.get('model_id','')).strip():raise ValueError('model_id required')
    if not isinstance(config.get('nms_iou'),(int,float)) or not 0<=config['nms_iou']<=1:raise ValueError('nms_iou required')
    if any('ms' in x for x in pred['records']) and not str(config.get('timing_conditions','')).strip():raise ValueError('timing_conditions required')
    result=evaluate_records(selected,pred['records'],config['confidence'],config.get('matching_iou',.5))
    result.update({'split':a.split,'purpose':a.purpose,'config':config,'test_frozen':lock['test_frozen'], 'reference_sha256':lock.get('reference_sha256',[]),
                   'manifest_sha256':sha256_bytes(a.manifest.read_bytes()), 'lock_sha256':sha256_bytes(a.lock.read_bytes()),
                   'predictions_sha256':sha256_bytes(a.predictions.read_bytes()),
                   'limitation':'Predictions and timing are supplied externally, not verified inference. Independence depends on provenance evidence and prior-use declarations.'})
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2));return 0
if __name__=='__main__':raise SystemExit(main())

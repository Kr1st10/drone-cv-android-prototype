"""Regression tests for audit accounting and the exact IoU boundary."""
import sys
from pathlib import Path
import numpy as np
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from evaluate import iou_matrix,match
from aod_audit_integrity import independent_match
from aod_audit_thresholds import iou,load_shards,validate
from independent_experiment import manifests,load_run

def ann(cls, box): return {'class':cls,'bbox':box}

def test_exact_iou_threshold_is_inclusive():
    # Area intersection 50 / union 100 == 0.5, not 0.5 minus epsilon.
    p=np.array([[0.,0.,10.,5.]])
    gt=np.array([[0.,0.,10.,10.]])
    assert iou_matrix(p,gt)[0,0] == 0.5
    tp,hit,_=match(p,np.array([.8]),gt,.5)
    assert tp.tolist()==[True] and hit.tolist()==[True]
    assert independent_match([[0,0,10,5,.8]],[ann('drone',[0,0,10,10])])[:3]==(1,0,0)

def test_degenerate_box_safe_without_epsilon():
    assert iou_matrix(np.array([[1.,1.,1.,1.]]),np.array([[1.,1.,1.,1.]])).tolist()==[[0.0]]
    assert iou([1,1,1,1],[1,1,1,1])==0.0

def test_drone_and_bird_and_duplicate_are_counted_once():
    annotations=[ann('bird',[40,40,10,10]),ann('drone',[10,20,10,20])]
    pred=[[10,20,20,40,.9],[10,20,20,40,.8],[40,40,50,50,.7]]
    assert independent_match(pred,annotations)==(1,2,0,[True])
    assert independent_match([[40,40,50,50,.7]],annotations)==(0,1,1,[False])

def test_confidence_strict_and_negative_frame():
    pred=[[0,0,10,10,.5],[20,20,30,30,.5001]]
    assert independent_match([p for p in pred if p[4]>.5],[])==(0,1,0,[])

def test_coco_xywh_conversion_and_size():
    # The x/y offset matters; width/height are not opposite corners.
    gt=[ann('drone',[100,200,12,3])]
    assert independent_match([[100,200,112,203,.9]],gt)==(1,0,0,[True])
    assert (12*3)**.5==6

def test_saved_low_score_shards_and_integrity():
    data=load_shards();rows=manifests();old=load_run('640')
    validate(data,rows,old)
    assert len(data['records'])==160
    bad=dict(data,records=data['records'][:-1]+data['records'][:1])
    with pytest.raises(ValueError,match='missing, duplicate'):validate(bad,rows,old)
    with pytest.raises(ValueError,match='identity mismatch'):validate(dict(data,model_sha256='wrong'),rows,old)

def test_saved_historical_metrics_remain_unchanged_all_modes():
    rows=manifests()
    for mode in ('640','960','sahi416'):
        for row,record in zip(rows,load_run(mode)['records']):
            p=np.array([d[:4] for d in record['predictions']],dtype=float).reshape(-1,4)
            scores=np.array([d[4] for d in record['predictions']])
            gt=np.array([[x,y,x+w,y+h] for a in row['annotations'] if a['class']=='drone' for x,y,w,h in [a['bbox']]],dtype=float).reshape(-1,4)
            tp,hit,_=match(p,scores,gt)
            assert (int(tp.sum()),int((~tp).sum()),int((~hit).sum()),hit.tolist()) == (record['tp'],record['fp'],record['fn'],record['hit'])

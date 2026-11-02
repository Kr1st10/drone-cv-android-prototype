"""Validation and leakage regression tests: all images below are synthetic."""
import copy
import json
import sys
from pathlib import Path
import cv2
import numpy as np
import pytest
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from ml.dataset45.core import ingest_image, validate_record, save_manifest, load_manifest
from ml.dataset45.duplicates import duplicate_pairs
from ml.dataset45.splits import make_split
from ml.dataset45.cli import check, main


def metadata(i=0):
    return {'source_url':f'https://example.org/{i}', 'license':'CC0', 'rights_note':'test fixture only',
            'source_group':f'source:{i}','sequence_id':f'seq:{i}','source_group_verified':True,
            'scene':['sky'],'independence':'verified','independence_evidence':'synthetic',
            'usage_history':'unused','annotations':[{'class':'drone','xyxy':[2,3,12,13]}]}

def record(tmp_path,i=0, pixels=None):
    if pixels is None: pixels=np.random.default_rng(i).integers(0,256,(32,32,3),dtype=np.uint8)
    p=tmp_path/f'source_{i}.png';Image.fromarray(pixels).save(p)
    r=ingest_image(p,metadata(i),tmp_path/'dataset')
    r.update(review_status='reviewed',reviewer='test-reviewer')
    return r

def test_ingestion_never_auto_approves_or_discards_suggestions(tmp_path):
    p=tmp_path/'in.png';Image.new('RGB',(32,32),'red').save(p)
    m=metadata();m.update(review_status='reviewed',reviewer='not trusted')
    r=ingest_image(p,m,tmp_path/'ds')
    assert r['review_status']=='unreviewed' and 'reviewer' not in r
    assert r['annotations']==m['annotations']

def test_box_checks_and_suspicious_labels(tmp_path):
    r=record(tmp_path)
    for box in ([-1,2,5,6],[5,4,5,8],[0,0,33,20],[0,0,float('nan'),1]):
        bad=copy.deepcopy(r);bad['annotations']=[{'class':'drone','xyxy':box}]
        assert validate_record(bad)[0]
    r['annotations']=[{'class':'drone','xyxy':[0,0,1,1]}]
    err,warn=validate_record(r)
    assert not err and any('below 2' in w for w in warn) and any('edge' in w for w in warn)

def test_mixed_classes_and_sizes(tmp_path):
    r=record(tmp_path);r['annotations']=[{'class':'drone','xyxy':[1,1,17,17]},{'class':'bird','xyxy':[20,20,25,25]}]
    p=tmp_path/'dataset'/'manifest.json';save_manifest(p,[r]);s=check(p,load_manifest(p))
    assert s['error_count']==0 and s['counts']['drone_images']==1 and s['drone_size_px_sqrt_area']['16-<24']==1

def test_empty_or_bird_only_requires_negative_review(tmp_path):
    r=record(tmp_path);r['annotations']=[]
    assert any('negative_verified' in e for e in validate_record(r)[0])
    r['annotations']=[{'class':'bird','xyxy':[0,0,5,5]}]
    assert any('negative_verified' in e for e in validate_record(r)[0])
    r['negative_verified']=True;assert not validate_record(r)[0]

def test_hashes_and_path_escape_are_checked(tmp_path):
    r=record(tmp_path);p=tmp_path/'dataset'/'manifest.json';save_manifest(p,[r]);assert check(p,load_manifest(p))['error_count']==0
    bad=copy.deepcopy(r);bad['file']='../../secret';assert check(p,{'records':[bad]})['error_count']>0
    q=tmp_path/'dataset'/r['file'];q.write_bytes(q.read_bytes()+b'altered')
    assert check(p,load_manifest(p))['error_count']>0

def test_identical_pixel_different_sources_retains_both(tmp_path):
    pixels=np.random.default_rng(8).integers(0,256,(32,32,3),dtype=np.uint8)
    a=record(tmp_path,1,pixels);b=record(tmp_path,2,pixels)
    assert a['id']!=b['id'] and a['pixel_sha256']==b['pixel_sha256']
    assert duplicate_pairs([a,b])[0]['kind']=='exact_pixels_or_file'
    assignments,_,_=make_split([a,b]);assert assignments[a['id']]==assignments[b['id']]

def test_near_candidate_merged_and_not_deleted(tmp_path):
    a=record(tmp_path,1);b=record(tmp_path,2)
    # One flipped dHash bit and 1/255 colour difference — explicit near candidate.
    b['dhash64']=f"{int(a['dhash64'],16)^1:016x}"
    b['mean_rgb_hex']=bytes(min(v+1,255) for v in bytes.fromhex(a['mean_rgb_hex'])).hex()
    pairs=duplicate_pairs([a,b]);assert len(pairs)==1 and pairs[0]['kind']=='near_candidate'
    ass,_,_=make_split([a,b]);assert ass[a['id']]==ass[b['id']]

def test_same_source_same_sequence_and_video_are_atomic(tmp_path):
    a,b,c,d=[record(tmp_path,i) for i in range(4)]
    b['source_group']=a['source_group'];c['sequence_id']=b['sequence_id']
    c['video_sha256']='a'*64;c['frame_index']=1;d['video_sha256']='a'*64;d['frame_index']=2
    ass,_,_=make_split([a,b,c,d])
    assert len({ass[r['id']] for r in [a,b,c,d]})==1

def test_split_rejects_unreviewed_unverified_and_exposed(tmp_path):
    a=record(tmp_path)
    for k,v in [('review_status','unreviewed'),('independence','unknown'),('usage_history','exposed'),('source_group_verified',False)]:
        b=copy.deepcopy(a);b[k]=v
        with pytest.raises(ValueError,match='quarantine'):make_split([b])

def test_independence_claim_requires_evidence(tmp_path):
    a=record(tmp_path);a['independence_evidence']=''
    assert any('requires evidence' in e for e in validate_record(a)[0])

def test_split_deterministic_and_frozen_test_unchanged(tmp_path):
    rows=[record(tmp_path,i) for i in range(30)]
    a,lock,_=make_split(rows,freeze=True)
    assert set(a.values())=={'train','validation','test'} and lock['test_frozen']
    assert make_split(list(reversed(rows)),previous=lock)[0]==a
    new=record(tmp_path,1000);assigned,lock2,_=make_split(rows+[new],previous=lock)
    assert all(assigned[k]==v for k,v in a.items()) and assigned[new['id']]!='test' and lock2['test_frozen']

def test_frozen_test_related_new_record_rejected(tmp_path):
    rows=[record(tmp_path,i) for i in range(30)];a,lock,_=make_split(rows,freeze=True)
    test=next(r for r in rows if a[r['id']]=='test');new=record(tmp_path,1000);new['source_group']=test['source_group']
    with pytest.raises(ValueError,match='frozen test'):make_split(rows+[new],previous=lock)

def test_locked_annotations_cannot_silently_change(tmp_path):
    rows=[record(tmp_path,i) for i in range(30)];_,lock,_=make_split(rows,freeze=True)
    rows[0]['annotations'][0]['xyxy']=[1,2,10,20]
    with pytest.raises(ValueError,match='locked record changed'):make_split(rows,previous=lock)

def test_bridge_between_locked_splits_rejected(tmp_path):
    rows=[record(tmp_path,i) for i in range(30)];a,lock,_=make_split(rows)
    x=next(r for r in rows if a[r['id']]=='train');y=next(r for r in rows if a[r['id']]=='validation')
    bridge=record(tmp_path,1000);bridge['source_group']=x['source_group'];bridge['sequence_id']=y['sequence_id']
    with pytest.raises(ValueError,match='different splits'):make_split(rows+[bridge],previous=lock)

def test_video_extraction_is_frame_indexed_and_unreviewed(tmp_path):
    path=tmp_path/'capture.avi';writer=cv2.VideoWriter(str(path),cv2.VideoWriter_fourcc(*'MJPG'),5,(32,32))
    assert writer.isOpened()
    for i in range(7):writer.write(np.full((32,32,3),i*30,dtype=np.uint8))
    writer.release();m=metadata(40);m['review_status']='reviewed';meta=tmp_path/'meta.json';meta.write_text(json.dumps(m));manifest=tmp_path/'ds'/'manifest.json'
    assert main(['import-video','--input',str(path),'--metadata',str(meta),'--manifest',str(manifest),'--every','3','--limit','3'])==0
    rec=load_manifest(manifest)['records'];assert [r['frame_index'] for r in rec]==[0,3,6]
    assert len({r['video_sha256'] for r in rec})==1
    assert all(r['review_status']=='unreviewed' and r['annotations']==[] for r in rec)
    assert check(manifest,{'records':rec})['error_count']==0

def test_cli_lock_wrapper_and_validation(tmp_path):
    rows=[record(tmp_path,i) for i in range(30)];manifest=tmp_path/'dataset'/'manifest.json';save_manifest(manifest,rows)
    out=tmp_path/'dataset'/'split.json';out2=tmp_path/'dataset'/'frozen.json'
    assert main(['split','--manifest',str(manifest),'--out',str(out)])==0
    assert main(['split','--manifest',str(manifest),'--out',str(out2),'--lock',str(out),'--freeze-test'])==0
    assert json.loads(out2.read_text())['lock']['test_frozen']

def test_exif_rotation_is_applied_before_boxes(tmp_path):
    p=tmp_path/'rotated.jpg';im=Image.new('RGB',(20,40),'blue');exif=Image.Exif();exif[274]=6;im.save(p,exif=exif)
    m=metadata(600);m['annotations']=[{'class':'drone','xyxy':[0,0,39,19]}]
    r=ingest_image(p,m,tmp_path/'dataset')
    assert (r['width'],r['height'])==(40,20) and not validate_record(r)[0]

def test_video_import_cannot_enter_test_without_review(tmp_path):
    r=record(tmp_path);r.update(review_status='unreviewed',annotations=[],negative_verified=False)
    with pytest.raises(ValueError,match='quarantine'):make_split([r])

def test_freeze_requires_all_partitions(tmp_path):
    row=record(tmp_path)
    with pytest.raises(ValueError,match='nonempty'):make_split([row],freeze=True)

def test_evaluation_uses_shared_matching_and_negative_counts(tmp_path):
    from ml.dataset45.evaluate import evaluate_records
    a=record(tmp_path,1);b=record(tmp_path,2);b['annotations']=[{'class':'bird','xyxy':[4,4,10,10]}];b['negative_verified']=True
    result=evaluate_records([a,b],[{'id':a['id'],'predictions':[[2,3,12,13,.9],[2,3,12,13,.8]]},
                                   {'id':b['id'],'predictions':[[4,4,10,10,.7]]}],.5)
    assert (result['counts']['tp'],result['counts']['fp'],result['counts']['fn'])==(1,2,0)
    assert result['precision_all']==pytest.approx(1/3) and result['recall']==1
    assert result['negative_images']=={'images':1,'fp':1,'images_with_fp':1}
    assert result['recall_by_size']['<16']=={'n':1,'tp':1,'recall':1}
    assert result['timing_ms'] is None

def test_evaluation_rejects_missing_or_subthreshold_predictions(tmp_path):
    from ml.dataset45.evaluate import evaluate_records
    a=record(tmp_path)
    with pytest.raises(ValueError,match='exactly one'):evaluate_records([a],[],.5)
    with pytest.raises(ValueError,match='threshold'):evaluate_records([a],[{'id':a['id'],'predictions':[[2,3,12,13,.5]]}],.5)

def test_reference_dataset_conflicts_are_not_silently_ignored(tmp_path):
    from ml.dataset45.duplicates import reference_conflicts
    pixels=np.random.default_rng(700).integers(0,256,(32,32,3),dtype=np.uint8)
    candidate=record(tmp_path,1,pixels); reference=record(tmp_path,2,pixels)
    matches=reference_conflicts([candidate],[reference]);assert 'exact_pixels_or_file' in matches[0]['reasons']
    other=record(tmp_path,3);other['sequence_id']=candidate['sequence_id']
    assert 'sequence_id' in reference_conflicts([candidate],[other])[0]['reasons']

def test_end_to_end_final_eval_requires_frozen_holdout(tmp_path):
    from ml.dataset45.evaluate import main as evaluate_main
    rows=[record(tmp_path,i) for i in range(30)];manifest=tmp_path/'dataset'/'manifest.json';save_manifest(manifest,rows)
    ass,lock,_=make_split(rows,freeze=True);lock_path=tmp_path/'split.json';lock_path.write_text(json.dumps({'lock':lock}))
    test=[r for r in rows if ass[r['id']]=='test'];pred=tmp_path/'pred.json'
    pred.write_text(json.dumps({'config':{'model_id':'synthetic','model_sha256':'a'*64,'confidence':.5,'nms_iou':.7},
                                'records':[{'id':r['id'],'predictions':[]} for r in test]}))
    output=tmp_path/'result.json'
    assert evaluate_main(['--manifest',str(manifest),'--lock',str(lock_path),'--predictions',str(pred),'--split','test','--purpose','final','--output',str(output)])==0
    result=json.loads(output.read_text());assert result['counts']['fn']==len(test) and result['test_frozen'] and result['timing_ms'] is None
    with pytest.raises(ValueError,match='requires purpose'):evaluate_main(['--manifest',str(manifest),'--lock',str(lock_path),'--predictions',str(pred),'--split','test','--purpose','development','--output',str(output)])

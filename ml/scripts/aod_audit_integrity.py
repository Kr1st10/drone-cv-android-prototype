#!/usr/bin/env python3
"""Reconcile stage-4.3 manifest, source COCO, actual JPEGs, ONNX and saved 640 counts."""
import argparse,ast,collections,json,zipfile
import numpy as np
import cv2,onnxruntime as ort
from independent_prepare import ML,DATA,OUT,SHA,sha
from independent_experiment import manifests,load_run

AUDIT=ML/'results/aod_audit'

def independent_match(pred, annotations, threshold=.5):
 """Independent scalar implementation, descending-confidence, one-to-one greedy IoU."""
 gt=[[x,y,x+w,y+h] for a in annotations if a['class']=='drone' for x,y,w,h in [a['bbox']]]
 pred=sorted(enumerate(pred),key=lambda v:(-v[1][4],v[0])); used=set(); flags={}
 for i,p in pred:
  x1,y1,x2,y2=p[:4];best=-1;bj=None
  for j,(a,b,c,d) in enumerate(gt):
   if j in used:continue
   area=max(0,min(x2,c)-max(x1,a))*max(0,min(y2,d)-max(y1,b)); union=(x2-x1)*(y2-y1)+(c-a)*(d-b)-area
   overlap=area/union if union>0 else 0
   if overlap>best:best=overlap;bj=j
  flags[i]=bj is not None and best>=threshold
  if flags[i]:used.add(bj)
 return len(used),len(pred)-len(used),len(gt)-len(used),[i in used for i in range(len(gt))]

def run(archive):
 if sha(archive)!=SHA:raise ValueError('AOD archive SHA mismatch')
 rows=manifests(); old=load_run('640');rec={(r['split'],r['id']):r for r in old['records']}
 session=ort.InferenceSession(str(ML/'weights/yolo11s-drone-640.onnx'),providers=['CPUExecutionProvider'])
 names=ast.literal_eval(session.get_modelmeta().custom_metadata_map['names']); assert names=={0:'drone'}
 sizes=collections.Counter(); counts=collections.Counter(); differences=[]; combos=collections.Counter()
 with zipfile.ZipFile(archive) as z:
  for split in ('train','test','valid'):
   coco=json.loads(z.read(f'AOD 4/Annotations/COCO Annotation format/{split}/_annotations.coco.json'))
   cats={c['id']:c['name'] for c in coco['categories']};assert {i:cats[i] for i in (1,2,3,4)}=={1:'airplane',2:'bird',3:'drone',4:'helicopter'}
   imap={i['id']:i for i in coco['images']}; aa=collections.defaultdict(list)
   for a in coco['annotations']:aa[a['image_id']].append({'class':cats[a['category_id']],'bbox':a['bbox']})
   for r in (x for x in rows if x['split']==split):
    im=imap[r['id']];assert im['file_name']==r['file'];assert aa[r['id']]==r['annotations']
    p=DATA/'images'/r['file']; assert sha(p)==r['sha256']; image=cv2.imread(str(p)); assert image is not None
    assert [image.shape[1],image.shape[0]]==[im['width'],im['height']]
    combos[','.join(sorted({a['class'] for a in r['annotations']})) or 'empty']+=1
    oldrow=rec[r['split'],r['id']];t,f,n,hit=independent_match(oldrow['predictions'],r['annotations'])
    if (t,f,n,hit)!=(oldrow['tp'],oldrow['fp'],oldrow['fn'],oldrow['hit']):differences.append(r['file'])
    counts.update(tp=t,fp=f,fn=n,images=1)
    for a in r['annotations']:
     if a['class']=='drone':
      x,y,w,h=a['bbox']; actual=((x+w-x)*(y+h-y))**.5; assert abs(actual-(w*h)**.5)<1e-9
      sizes['<16' if actual<16 else '16-24' if actual<24 else '24-30' if actual<30 else '>=30']+=1
 if differences:raise AssertionError('saved counts differ on '+str(differences))
 out={'aod_archive_sha256':SHA,'model_sha256':sha(ML/'weights/yolo11s-drone-640.onnx'),'model_names':names,'aod_coco_category_names':cats,
      'source_annotations_match_manifest':True,'actual_image_dimensions_match':True,'image_hashes_match':True,
      'size_definition':'sqrt(w*h) at delivered 1024x1024; not pre-resize physical pixels','sizes':dict(sizes),'class_combinations':dict(combos),
      'independent_scalar_match_of_saved_predictions':dict(counts),'differences':differences,
      'limitations':'No assertion that the labels are exhaustive or visually correct; saved predictions have 3 decimal rounding; match is only checked on those.'}
 AUDIT.mkdir(parents=True,exist_ok=True);(AUDIT/'integrity.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--archive',required=True,type=__import__('pathlib').Path);a=p.parse_args();run(a.archive)

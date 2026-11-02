#!/usr/bin/env python3
"""Audit 640 confidence on same AOD4 images; one low-floor inference, independent matches."""
import argparse,json,math,platform
from pathlib import Path
from collections import Counter
import numpy as np
import onnxruntime as ort
import drone_detector as dd
from independent_experiment import manifests,load_run
from independent_prepare import DATA,ML,sha
from aod_audit_integrity import AUDIT,independent_match

FLOOR=.05; THRESHOLDS=(.05,.1,.25,.5,.75,.9); IOU=.5

def iou(a,b):
 x1=max(a[0],b[0]);y1=max(a[1],b[1]);x2=min(a[2],b[2]);y2=min(a[3],b[3]);inter=max(0,x2-x1)*max(0,y2-y1)
 union=max(0,a[2]-a[0])*max(0,a[3]-a[1])+max(0,b[2]-b[0])*max(0,b[3]-b[1])-inter
 return inter/union if union else 0.0

def predict():
 rows=manifests();model=ML/'weights/yolo11s-drone-640.onnx'; det=dd.DroneDetector(model,threads=2)
 preds=[]
 for i,r in enumerate(rows):
  p=DATA/'images'/r['file']
  if sha(p)!=r['sha256']:raise ValueError('image SHA mismatch')
  img=dd.load_rgb(p); d=det.detect(img,conf=FLOOR,iou=.7)
  preds.append({'file':r['file'],'split':r['split'],'id':r['id'], 'predictions':[[float(x.x1),float(x.y1),float(x.x2),float(x.y2),float(x.score)] for x in d]})
  if (i+1)%40==0:print('inference',i+1,'/',len(rows),flush=True)
 result={'floor':FLOOR,'nms_iou':.7,'model_sha256':sha(model),'manifest_sha256':{p.name:sha(p) for p in sorted((ML/'results/independent').glob('manifest_*.json'))},
         'environment':{'python':platform.python_version(),'onnxruntime':ort.__version__,'numpy':np.__version__},'records':preds}
 AUDIT.mkdir(parents=True,exist_ok=True); (AUDIT/'low_conf_raw.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
 return result

def summary_stats(values):
 return {'n':len(values),'min':min(values) if values else None,'median':float(np.median(values)) if values else None,'max':max(values) if values else None}

def load_shards():
 data=json.loads((AUDIT/'low_conf_metadata.json').read_text())
 data['records']=sum((json.loads((AUDIT/f'low_conf_records_{i}.json').read_text()) for i in range(1,5)),[])
 return data

def save_shards(data):
 meta={k:v for k,v in data.items() if k!='records'}
 (AUDIT/'low_conf_metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
 for i in range(4):
  (AUDIT/f'low_conf_records_{i+1}.json').write_text(json.dumps(data['records'][40*i:40*(i+1)],separators=(',',':'))+'\n')

def validate(data,rows,old):
 if data['floor']!=FLOOR or data['nms_iou']!=.7:raise ValueError('unexpected floor or NMS')
 if data['model_sha256']!=old['model_sha256'] or data['manifest_sha256']!=old['manifest_sha256']:raise ValueError('model or manifest identity mismatch')
 actual={p.name:sha(p) for p in sorted((ML/'results/independent').glob('manifest_*.json'))}
 if actual!=data['manifest_sha256']:raise ValueError('manifest checksum mismatch')
 expected={(r['split'],r['id'],r['file']) for r in rows}
 observed=[(r['split'],r['id'],r['file']) for r in data['records']]
 if len(observed)!=len(expected) or set(observed)!=expected:raise ValueError('missing, duplicate or unexpected image')
 if any(not math.isfinite(v) for r in data['records'] for p in r['predictions'] for v in p):raise ValueError('non-finite prediction')
 if any(p[4]<=FLOOR for r in data['records'] for p in r['predictions']):raise ValueError('prediction below saved floor')

def analyze(data):
 rows=manifests();old=load_run('640'); lookup={(r['split'],r['id']):r for r in rows}; historical={(r['split'],r['id']):r for r in old['records']}
 validate(data,rows,old)
 score_tp=[];score_fp=[]; fn=[]; sums={str(t):Counter() for t in THRESHOLDS}; diff=[]; bysize={x:Counter() for x in ('<16','16-24','24-30','30-64','64-96','>=96')}
 for r in data['records']:
  key=(r['split'],r['id']);meta=lookup[key]; allpred=r['predictions']; annotations=meta['annotations']; gt=[a for a in annotations if a['class']=='drone']
  for t in THRESHOLDS:
   pp=[p for p in allpred if p[4]>t];tp,fp,miss,hits=independent_match(pp,annotations)
   sums[str(t)].update(tp=tp,fp=fp,fn=miss,fp_negative=fp if not gt else 0)
   if t==.5:
    h=historical[key]
    if (tp,fp,miss,hits)!=(h['tp'],h['fp'],h['fn'],h['hit']):diff.append(meta['file'])
    # Compare independent scalar GT matches with the canonical vector matcher.
    import sahi_experiment as se
    from evaluate import match
    d=[dd.Detection(*p) for p in pp]; boxes,scores=se.to_arr(d);g=np.array([[x,y,x+w,y+h] for a in gt for x,y,w,h in [a['bbox']]],float).reshape(-1,4)
    flags,hit2,_=match(boxes,scores,g,IOU)
    assert hit2.tolist()==hits
    score_tp += [p[4] for p,yes in zip(pp,flags) if yes];score_fp += [p[4] for p,yes in zip(pp,flags) if not yes]
    for j,(a,hit) in enumerate(zip(gt,hits)):
     x,y,w,h=a['bbox'];size=math.sqrt(w*h); bucket='<16' if size<16 else '16-24' if size<24 else '24-30' if size<30 else '30-64' if size<64 else '64-96' if size<96 else '>=96'
     bysize[bucket].update(n=1,tp=int(hit),fn=int(not hit))
     if not hit:
      xyxy=[x,y,x+w,y+h]; matching=[p for p in allpred if iou(p,xyxy)>=IOU]
      best=max((p[4] for p in matching),default=None); max_iou=max((iou(p,xyxy) for p in allpred),default=0)
      fn.append({'file':r['file'],'split':r['split'],'gt_index':j,'size_px':size,'gt_bbox':a['bbox'],'best_iou_any_above_floor':max_iou,'best_score_iou_ge_05':best})
 if diff:raise ValueError('0.5 differs from stage4.3: '+str(diff))
 table=[]
 for t in THRESHOLDS:
  c=sums[str(t)];tp,fp,miss=c['tp'],c['fp'],c['fn'];table.append({'confidence_strictly_greater':t,'tp':tp,'fp':fp,'fn':miss,'fp_negative':c['fp_negative'], 'precision':tp/(tp+fp) if tp+fp else None,'recall':tp/(tp+miss) if tp+miss else None})
 matched=[r['best_score_iou_ge_05'] for r in fn if r['best_score_iou_ge_05'] is not None]
 out={'floor_strictly_greater':FLOOR,'matching_iou':IOU,'nms_iou':data['nms_iou'],'model_sha256':data['model_sha256'],'manifest_sha256':data['manifest_sha256'],'environment':data['environment'],
      'same_05_as_stage43':True,'thresholds':table,'score_distribution_at_05':{'tp':summary_stats(score_tp),'fp':summary_stats(score_fp)},'size_buckets_at_05':{k:dict(v) for k,v in bysize.items()},
      'fn_at_05':{'total':len(fn),'candidate_iou_ge_05_with_score_above_floor':len(matched),'no_candidate_iou_ge_05_above_floor':len(fn)-len(matched),'matched_candidate_score':summary_stats(matched)},
      'limitations':'Exploratory threshold sweep on same sample, no independent validation. FN scores are post-NMS retained candidates only, not raw class scores; absence above floor is not zero confidence.'}
 (AUDIT/'thresholds.json').write_text(json.dumps(out,indent=2)+'\n');(AUDIT/'missed_gt.json').write_text(json.dumps(fn,separators=(',',':'))+'\n');print(json.dumps(out,indent=2))

if __name__=='__main__':
 p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group();g.add_argument('--from-raw',action='store_true');g.add_argument('--from-shards',action='store_true');a=p.parse_args();data=load_shards() if a.from_shards else json.loads((AUDIT/'low_conf_raw.json').read_text()) if a.from_raw else predict();analyze(data);save_shards(data)

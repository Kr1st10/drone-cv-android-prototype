#!/usr/bin/env python3
"""Compare 640, 960 and SAHI 416 on the frozen AOD4 sample."""
import argparse,hashlib,json,platform,time,resource
from collections import Counter
from pathlib import Path
import numpy as np
import drone_detector as dd
import sahi_experiment as se
from evaluate import match,iou_matrix
from independent_prepare import DATA,OUT,ML,sha

CONF=0.5; IOU=0.5; THREADS=2; MODES=('640','960','sahi416')

def manifests():
 files=sorted(OUT.glob('manifest_*.json'))
 if len(files)!=4:raise ValueError('expected four manifests')
 rows=sum([json.loads(p.read_text()) for p in files],[])
 if len(rows)!=160 or len({x['file'] for x in rows})!=160:raise ValueError('invalid or duplicated manifest')
 return rows

def boxes(annotations, cls):
 return np.array([[x,y,x+w,y+h] for a in annotations if a['class']==cls for x,y,w,h in [a['bbox']]],float).reshape(-1,4)

def evaluate(dets, anns):
 gt=boxes(anns,'drone'); pred,scores=se.to_arr(dets); tp,hit,_=match(pred,scores,gt,IOU)
 fp=pred[~tp]; others={}
 for cat in ('bird','airplane'):
  ov=iou_matrix(fp,boxes(anns,cat)); others[cat]=int((ov>=IOU).any(axis=1).sum()) if ov.size else 0
 sizes=np.sqrt((gt[:,2]-gt[:,0])*(gt[:,3]-gt[:,1]))
 return {'tp':int(tp.sum()),'fp':int((~tp).sum()),'fn':int(len(gt)-hit.sum()),'hit':hit.tolist(),
         'sizes':sizes.tolist(),'fp_overlap':others,
         'predictions':[[round(float(v),3) for v in [d.x1,d.y1,d.x2,d.y2,d.score]]+[bool(t)] for d,t in zip(dets,tp)]}

def run(mode):
 import onnxruntime as ort,cv2
 if mode not in MODES:raise ValueError(mode)
 rows=manifests(); imgs=[]
 for r in rows:
  path=DATA/'images'/r['file']
  if sha(path)!=r['sha256']:raise ValueError('input hash mismatch: '+r['file'])
  imgs.append(dd.load_rgb(path))
 model=ML/'weights'/f'yolo11s-drone-{960 if mode=="960" else 640}.onnx'
 detector=se.OnnxDetect(model,threads=THREADS)
 expected=960 if mode=='960' else 640
 if detector.det.session.get_inputs()[0].shape != [1,3,expected,expected]:raise ValueError('wrong model size')
 def predict(img):return se.sahi_predict(img,detector,CONF,416,0.2,True,'IOS') if mode=='sahi416' else detector(img,CONF)
 for _ in range(3):predict(imgs[0])
 records=[]
 for i,(r,img) in enumerate(zip(rows,imgs)):
  t=time.perf_counter();dets=predict(img);ms=(time.perf_counter()-t)*1000
  val=evaluate(dets,r['annotations']); records.append({'id':r['id'],'split':r['split'],'file':r['file'],'group':r['group'],'ms':ms,**val})
  if (i+1)%20==0:print(mode,i+1,'/',len(rows),flush=True)
 cpu='unknown'
 for line in Path('/proc/cpuinfo').read_text().splitlines():
  if line.startswith('model name'):cpu=line.split(':',1)[1].strip();break
 obj={'mode':mode,'model_sha256':sha(model),'manifest_sha256':{p.name:sha(p) for p in sorted(OUT.glob('manifest_*.json'))},
      'environment':{'cpu':cpu,'logical_cpus':__import__('os').cpu_count(),'platform':platform.platform(),'python':platform.python_version(), 'onnxruntime':ort.__version__,'numpy':np.__version__,'opencv':cv2.__version__},
      'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'records':records}
 (OUT/f'raw_{mode}.json').write_text(json.dumps(obj,separators=(',',':'))+'\n')
 meta={k:v for k,v in obj.items() if k!='records'}
 (OUT/f'metadata_{mode}.json').write_text(json.dumps(meta,indent=1)+'\n')
 for i in range(0,len(records),40):
  (OUT/f'records_{mode}_{i//40+1}.json').write_text(json.dumps(records[i:i+40],separators=(',',':'))+'\n')
 print('saved',mode,flush=True)

def summarize(data,rows):
 rs=data['records']; tp=sum(x['tp'] for x in rs);fp=sum(x['fp'] for x in rs);fn=sum(x['fn'] for x in rs)
 size_records=[(s,h) for r in rs for s,h in zip(r['sizes'],r['hit'])]; bins={}
 for name,lo,hi in [('<16',0,16),('16-24',16,24),('24-30',24,30),('>=30',30,float('inf'))]:
  h=[v for s,v in size_records if lo<=s<hi]; bins[name]={'n':len(h),'tp':sum(h),'recall':sum(h)/len(h) if h else None}
 groups={}
 for g in ('bird','airplane','empty'):
  a=[r for r in rs if r['group']==g]
  groups[g]={'images':len(a),'images_with_fp':sum(r['fp']>0 for r in a),'fp':sum(r['fp'] for r in a)}
 negative=[r for r in rs if not any(a['class']=='drone' for a in rows[(r['split'],r['id'])]['annotations'])]
 t=[r['ms'] for r in rs]
 return {'images':len(rs),'gt':tp+fn,'tp':tp,'fp':fp,'fn':fn,'precision':tp/(tp+fp) if tp+fp else None,'recall':tp/(tp+fn) if tp+fn else None,
         'recall_by_size':bins,'fp_negative':sum(r['fp'] for r in negative),'negative_images':len(negative),'groups':groups,
         'fp_overlap_iou_05':{cat:sum(r['fp_overlap'][cat] for r in rs) for cat in ('bird','airplane')},
         'latency_ms':{'mean':float(np.mean(t)),'median':float(np.median(t))},'peak_rss_kib':data['peak_rss_kib'],'model_sha256':data['model_sha256']}

def load_run(mode):
 meta=json.loads((OUT/f'metadata_{mode}.json').read_text())
 chunks=sorted(OUT.glob(f'records_{mode}_*.json'))
 if len(chunks)!=4:raise ValueError('expected four record chunks')
 meta['records']=sum([json.loads(p.read_text()) for p in chunks],[])
 if len(meta['records'])!=160:raise ValueError('invalid record count')
 return meta

def report():
 rows=manifests(); lookup={(r['split'],r['id']):r for r in rows};raw={m:load_run(m) for m in MODES}
 if len({json.dumps(v['manifest_sha256'],sort_keys=True) for v in raw.values()})!=1 or len({json.dumps(v['environment'],sort_keys=True) for v in raw.values()})!=1:raise ValueError('manifest/environment differs')
 ids=[(x['split'],x['id']) for x in raw['640']['records']]
 if any([(x['split'],x['id']) for x in d['records']]!=ids for d in raw.values()):raise ValueError('different images')
 summary={'confidence':CONF,'match_iou':IOU,'nms_iou':se.NMS_IOU,'sahi':{'slice':416,'overlap':0.2,'full_frame':True,'merge':'GREEDYNMM IOS 0.5'},'environment':raw['640']['environment'],
          'timing':'Full preprocessing/inference/postprocessing, excludes image decode. Warmup 3; fresh process per mode.',
          'results':{m:summarize(raw[m],lookup) for m in MODES}}
 (OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 # Save reconstructible, labelled examples, not source images. Representative diagnostics, not randomized.
 examples=[]
 for mode in MODES:
  recs=raw[mode]['records']
  for category,arr in [('missed_drone',[r for r in recs if r['fn'] and r['group']!='lt16']),('uncertain_tiny_label',[r for r in recs if r['fn'] and r['group']=='lt16']),('bird_fp',[r for r in recs if r['group']=='bird' and r['fp']]),('airplane_fp',[r for r in recs if r['group']=='airplane' and r['fp']])]:
   for r in arr[:2]:
    meta=lookup[(r['split'],r['id'])]
    examples.append({'mode':mode,'kind':category,'file':r['file'],'split':r['split'],'sequence':meta['sequence'],'annotations':meta['annotations'],'predictions':r['predictions']})
 (OUT/'examples.json').write_text(json.dumps(examples,indent=1)+'\n')
 print(json.dumps(summary,indent=2))

if __name__=='__main__':
 p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True); runp=sub.add_parser('run');runp.add_argument('--mode',choices=MODES,required=True);sub.add_parser('report');a=p.parse_args();run(a.mode) if a.cmd=='run' else report()

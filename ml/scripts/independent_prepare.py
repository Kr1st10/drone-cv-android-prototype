#!/usr/bin/env python3
"""Deterministically prepare a small AOD4 cross-source evaluation sample, no images committed."""
import argparse
import hashlib
import json
import math
import re
import urllib.request
import zipfile
from collections import defaultdict, Counter
from pathlib import Path

ML=Path(__file__).resolve().parents[1]
OUT=ML/'results/independent'
DATA=ML/'data/independent'
URL='https://data.mendeley.com/public-files/datasets/cd5z895tr2/files/fb36418a-ca4d-4628-8e42-c6e5b2575ac2/file_downloaded'
SHA='fac56b9c0494312bcd4c63dfefcbcd8ed07ab55d4b00584131c0b55273d24518'
SPLITS=('train','test','valid')
QUOTAS={'lt16': 100, '16to24': 100, '24to30': 100, 'large': 80, 'bird':30, 'airplane':30, 'empty':20}

def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()

def sequence(name):
 base=name.split('_jpg.rf.')[0]
 m=re.match(r'^yt-(.{11})-(\d+)$',base)
 if m:return 'youtube:'+m[1]
 m=re.match(r'^(V_[A-Z]+_\d+)_(\d+)_png$',base)
 if m:return 'source-video:'+m[1]
 m=re.match(r'^(\d{8}_\d{6}_\d+_\d+)_(\d+)$',base)
 if m:return 'anti-uav:'+m[1]
 return 'unknown:'+base

def classify(anns):
 ids={a['category_id'] for a in anns}; sizes=[math.sqrt(a['bbox'][2]*a['bbox'][3]) for a in anns if a['category_id']==3]
 if sizes:
  m=min(sizes)
  return 'lt16' if m<16 else '16to24' if m<24 else '24to30' if m<30 else 'large'
 if 2 in ids:return 'bird'
 if 1 in ids:return 'airplane'
 if not ids:return 'empty'
 return 'other'

def order(split,name):return hashlib.sha256(('stage4.3-seed0:'+split+':'+name).encode()).hexdigest()

def choose(candidates, archive):
 import cv2
 import numpy as np
 # Prioritize the rarest positives. Max one identified sequence across all splits and strata.
 selected=[]; seen=set(); counts=Counter(); fingerprints=[]
 for group in ('lt16','16to24','24to30','large','bird','airplane','empty'):
  for r in sorted((x for x in candidates if x['group']==group),key=lambda x:order(x['split'],x['file'])):
   if group in ('lt16','16to24','24to30','large') and sum(counts[g] for g in ('lt16','16to24','24to30','large'))>=80: break
   if counts[group]>=QUOTAS[group]:break
   if r['sequence'] in seen:continue
   raw=archive.read(f"AOD 4/Images/{r['split']}/{r['file']}")
   im=cv2.imdecode(np.frombuffer(raw,np.uint8),cv2.IMREAD_COLOR)
   if im is None:raise ValueError('image decode failed')
   gray=cv2.resize(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),(9,8),interpolation=cv2.INTER_AREA)
   dh=int.from_bytes(np.packbits((gray[:,1:]>gray[:,:-1]).ravel()).tobytes(),'big')
   tiny=cv2.resize(im,(32,32),interpolation=cv2.INTER_AREA).astype(np.int16)
   if any((dh ^ h).bit_count()<=4 and float(np.abs(tiny-t).mean())<5 for h,t in fingerprints):continue
   fingerprints.append((dh,tiny)); seen.add(r['sequence']); selected.append(r); counts[group]+=1
 return selected

def main():
 p=argparse.ArgumentParser();p.add_argument('--archive',type=Path,default=DATA/'AOD4.zip');p.add_argument('--download',action='store_true');args=p.parse_args()
 if args.download and not args.archive.exists():
  args.archive.parent.mkdir(parents=True,exist_ok=True)
  with urllib.request.urlopen(URL) as r, args.archive.open('wb') as w:
   while b:=r.read(1<<20):w.write(b)
 if sha(args.archive)!=SHA:raise SystemExit('AOD4 archive SHA-256 mismatch')
 candidates=[]
 with zipfile.ZipFile(args.archive) as z:
  for split in SPLITS:
   coco=json.loads(z.read(f'AOD 4/Annotations/COCO Annotation format/{split}/_annotations.coco.json'))
   cats={c['id']:c['name'] for c in coco['categories']}
   if any(cats.get(i)!=name for i,name in [(1,'airplane'),(2,'bird'),(3,'drone'),(4,'helicopter')]):raise ValueError(cats)
   by=defaultdict(list)
   for a in coco['annotations']:
    x,y,w,h=a['bbox']
    if a.get('iscrowd',0) or min(w,h)<=0 or x<0 or y<0 or x+w>1024.01 or y+h>1024.01: raise ValueError(f'Invalid/crowd bbox {a}')
    by[a['image_id']].append({'class':cats[a['category_id']],'bbox':[x,y,w,h]})
   # category_id needed only during selection
   for im in coco['images']:
    if (im['width'],im['height']) != (1024,1024):raise ValueError('unexpected image size')
    ann0=by[im['id']]; ids={v:k for k,v in cats.items()}
    group=classify([{'category_id':ids[a['class']],'bbox':a['bbox']} for a in ann0])
    candidates.append({'split':split,'id':im['id'],'file':im['file_name'],'sequence':sequence(im['file_name']),'group':group,'annotations':ann0})
  selected=choose(candidates,z); DATA.joinpath('images').mkdir(parents=True,exist_ok=True)
  for r in selected:
   b=z.read(f"AOD 4/Images/{r['split']}/{r['file']}")
   r['sha256']=hashlib.sha256(b).hexdigest(); (DATA/'images'/r['file']).write_bytes(b)
 OUT.mkdir(parents=True,exist_ok=True)
 # Multiple bounded files keep connector uploads small; all values human and machine readable.
 for i in range(0,len(selected),40):
  (OUT/f'manifest_{i//40+1}.json').write_text(json.dumps(selected[i:i+40],ensure_ascii=False,separators=(',',':'))+'\n')
 print('Selected',len(selected),'groups',dict(Counter(r['group'] for r in selected)),flush=True)
 print('Full pools',dict(Counter(r['group'] for r in candidates)),flush=True)
 print('Unknown sequence names',sum(r['sequence'].startswith('unknown:') for r in selected))

if __name__=='__main__':main()

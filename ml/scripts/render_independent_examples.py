#!/usr/bin/env python3
"""Render saved examples locally from the original, verified AOD4 images (not redistributed)."""
import json
from collections import Counter
from pathlib import Path
import cv2
from independent_prepare import DATA,OUT,sha
from independent_experiment import manifests

def main():
 refs={(r['split'],r['file']):r for r in manifests()}; counts=Counter(); out=OUT/'examples';out.mkdir(parents=True,exist_ok=True)
 for x in json.loads((OUT/'examples.json').read_text()):
  meta=refs[(x['split'],x['file'])]; p=DATA/'images'/x['file']
  if sha(p)!=meta['sha256']:raise ValueError('image hash mismatch')
  img=cv2.imread(str(p));
  if img is None:raise ValueError('cannot decode image')
  for a in x['annotations']:
   bx,by,w,h=a['bbox'];p1=(int(round(bx)),int(round(by)));p2=(int(round(bx+w)),int(round(by+h)))
   cv2.rectangle(img,p1,p2,(0,255,0) if a['class']=='drone' else (255,180,0),2)
   cv2.putText(img,'GT '+a['class'],(p1[0],max(12,p1[1]-4)),cv2.FONT_HERSHEY_SIMPLEX,.4,(0,255,0),1)
  for x1,y1,x2,y2,score,tp in x['predictions']:
   p1=(int(round(x1)),int(round(y1)));p2=(int(round(x2)),int(round(y2)));color=(0,255,255) if tp else (0,0,255)
   cv2.rectangle(img,p1,p2,color,2);cv2.putText(img,f'{"TP" if tp else "FP"} {score:.2f}',(p1[0],min(1020,p1[1]+14)),cv2.FONT_HERSHEY_SIMPLEX,.4,color,1)
  key=(x['mode'],x['kind']);counts[key]+=1; dest=out/f'{x["mode"]}_{x["kind"]}_{counts[key]}.jpg'
  if not cv2.imwrite(str(dest),img):raise ValueError('cannot write '+str(dest))
 print('Rendered',sum(counts.values()),'local examples in',out)
if __name__=='__main__':main()

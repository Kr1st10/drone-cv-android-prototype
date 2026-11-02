#!/usr/bin/env python3
"""Candidate AOD4 near-duplicates against both pinned pathikg splits; heuristic, not proof."""
import hashlib,json,sys,urllib.request
from pathlib import Path
import cv2,numpy as np,pyarrow.parquet as pq
from independent_prepare import ML, DATA, OUT, sha
from prepare_eval_data import DS_REV, DS_TEST_URL

def fp(b):
 g=cv2.imdecode(np.frombuffer(b,np.uint8),cv2.IMREAD_GRAYSCALE)
 if g is None:raise ValueError('decode error')
 a=cv2.resize(g,(9,8),interpolation=cv2.INTER_AREA)
 return int.from_bytes(np.packbits((a[:,1:]>a[:,:-1]).ravel()).tobytes(),'big')

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--train',action='store_true');p.add_argument('--keep-shards',action='store_true'); args=p.parse_args()
 rows=sum([json.loads(f.read_text()) for f in sorted(OUT.glob('manifest_*.json'))],[])
 if not rows:raise ValueError('missing manifests')
 target=[]
 for r in rows:
  f=DATA/'images'/r['file']; b=f.read_bytes()
  if hashlib.sha256(b).hexdigest()!=r['sha256']:raise ValueError('image digest mismatch')
  target.append((hashlib.sha1(b).hexdigest(),np.uint64(fp(b))))
 best=[{'file':r['file'],'distance':65,'pathikg_path':None,'split':None,'exact':False} for r in rows]; scans=[]
 paths=[('test',DS_TEST_URL,ML/'data/cache/pathikg_test.parquet')]
 if args.train:
  paths += [('train',f'https://huggingface.co/datasets/pathikg/drone-detection-dataset/resolve/{DS_REV}/data/train-{i:05d}-of-00009.parquet',ML/f'data/cache/pathikg_train_{i}.parquet') for i in range(9)]
 for split,url,path in paths:
  path.parent.mkdir(parents=True,exist_ok=True)
  if not path.exists():
   temp=path.with_suffix('.part')
   with urllib.request.urlopen(url) as rr,temp.open('wb') as w:
    while b:=rr.read(1<<20):w.write(b)
   temp.replace(path)
  hashes=[]; names=[]; shas=[]
  for batch in pq.ParquetFile(path).iter_batches(columns=['image'],batch_size=128):
   for row in batch.to_pylist():
    b=row['image']['bytes'];hashes.append(fp(b));names.append(row['image']['path']);shas.append(hashlib.sha1(b).hexdigest())
  hv=np.array(hashes,dtype=np.uint64); sha_map=set(shas)
  for i,(digest,h) in enumerate(target):
   diff=np.bitwise_count(hv ^ h); j=int(diff.argmin()); distance=int(diff[j]);
   if distance<best[i]['distance']:best[i].update(distance=distance,pathikg_path=names[j],split=split)
   best[i]['exact'] |= digest in sha_map
  scans.append({'split':split,'file':path.name,'sha256':sha(path),'rows':len(hashes)})
  print(split,path.name,len(hashes),flush=True)
  if split=='train' and not args.keep_shards:path.unlink()
 out={'pathikg_revision':DS_REV,'method':'64-bit dHash grayscale 9x8 INTER_AREA; nearest Hamming distance; SHA1 exact compressed bytes', 'scans':scans,'results':best,
      'near_le4':sum(x['distance']<=4 for x in best),'exact_byte_matches':sum(x['exact'] for x in best),
      'caveat':'dHash is a heuristic, can flag flat backgrounds and miss crops, re-encodes or temporal variants; unknown model training split/source origins prevent a guarantee of independence'}
 results=out.pop('results')
 (OUT/'overlap.json').write_text(json.dumps(out,indent=1)+'\n')
 for i in range(0,len(results),80):
  (OUT/f'overlap_candidates_{i//80+1}.json').write_text(json.dumps(results[i:i+80],separators=(',',':'))+'\n')
 print('done near<=4',out['near_le4'],'exact',out['exact_byte_matches'],flush=True)
if __name__=='__main__':main()

"""Provenance-preserving image/video intake, review, validation and splitting."""
from __future__ import annotations
import argparse
import json
import math
from collections import Counter
from pathlib import Path
import cv2
from PIL import Image, ImageDraw
from .core import ingest_image, ingest_pixels, load_manifest, save_manifest, validate_record, sha256_bytes, fingerprints
from .duplicates import duplicate_pairs, reference_conflicts
from .splits import make_split


def image_path(manifest:Path, record:dict) -> Path:
    root=manifest.parent.resolve();p=(root/record['file']).resolve()
    if not p.is_relative_to(root/'images'):raise ValueError('image path escapes dataset images directory')
    return p


def check(manifest:Path, data:dict) -> dict:
    counts=Counter();sizes=Counter();scenes=Counter();issues=[];seen=set()
    for r in data['records']:
        errors,warnings=validate_record(r)
        if r.get('id') in seen: errors.append('duplicate record id')
        seen.add(r.get('id'))
        if not errors:
            try:
                p=image_path(manifest,r);raw=p.read_bytes()
                if sha256_bytes(raw)!=r['sha256']:raise ValueError('image SHA mismatch')
                with Image.open(p) as im:
                    if (im.width,im.height)!=(r['width'],r['height']):raise ValueError('image dimensions mismatch')
                    actual=fingerprints(im)
                if any(actual[k]!=r[k] for k in actual):raise ValueError('pixel fingerprint mismatch')
            except (OSError,ValueError) as e:errors.append(str(e))
        if errors or warnings:issues.append({'id':r.get('id'),'errors':errors,'warnings':warnings})
        counts['images']+=1
        annotations=r.get('annotations') if isinstance(r.get('annotations'),list) else []
        counts['drone_images']+=int(any(isinstance(a,dict) and a.get('class')=='drone' for a in annotations))
        counts['unreviewed']+=int(r.get('review_status')!='reviewed')
        counts['split_eligible']+=int(not errors and r.get('review_status')=='reviewed' and r.get('independence')=='verified' and r.get('usage_history')=='unused' and r.get('source_group_verified') is True)
        if isinstance(r.get('scene'),list):scenes.update(x for x in r['scene'] if isinstance(x,str))
        if not errors:
            for a in r['annotations']:
                if a['class']=='drone':
                    x,y,x2,y2=a['xyxy'];s=math.sqrt((x2-x)*(y2-y))
                    sizes['<16' if s<16 else '16-<24' if s<24 else '24-<30' if s<30 else '>=30']+=1
    errors=sum(len(x['errors']) for x in issues)
    pairs=duplicate_pairs(data['records']) if not errors else []
    return {'counts':dict(counts),'drone_size_px_sqrt_area':dict(sizes),'scenes_multilabel':dict(scenes),
            'duplicate_pairs':pairs,'issues':issues,'error_count':errors,
            'note':'Metadata and annotations may be incorrect. Hash matching cannot prove independence or visual truth.'}


def append_records(path, new):
    old=load_manifest(path)['records'] if path.exists() else []
    ids={r['id'] for r in old}
    if len(ids)!=len(old) or any(r['id'] in ids for r in new) or len({r['id'] for r in new})!=len(new):raise ValueError('duplicate record identity; no manifest changes')
    save_manifest(path,old+new)


def import_video(path,meta,root,every,limit):
    if every<1 or limit<1: raise ValueError('every and limit must be positive')
    h=__import__('hashlib').sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1<<20),b''):h.update(chunk)
    video_sha=h.hexdigest(); cap=cv2.VideoCapture(str(path))
    if not cap.isOpened():raise ValueError('cannot open video')
    if hasattr(cv2,'CAP_PROP_ORIENTATION_AUTO'):cap.set(cv2.CAP_PROP_ORIENTATION_AUTO,1)
    fps=cap.get(cv2.CAP_PROP_FPS);result=[];i=0
    try:
        while len(result)<limit:
            ok,bgr=cap.read()
            if not ok:break
            if i%every==0:
                frame=Image.fromarray(cv2.cvtColor(bgr,cv2.COLOR_BGR2RGB))
                m=dict(meta,annotations=[],video_sha256=video_sha,frame_index=i,frame_time_seconds=(i/fps if math.isfinite(fps) and fps>0 else None))
                result.append(ingest_pixels(frame,m,root,video_sha))
            i+=1
    finally:cap.release()
    if not result:raise ValueError('no decoded frames')
    return result


def render(manifest,records,out):
    out.mkdir(parents=True,exist_ok=True)
    for r in records:
        path=image_path(manifest,r)
        if sha256_bytes(path.read_bytes())!=r['sha256']:raise ValueError('image SHA mismatch')
        with Image.open(path) as im:img=im.convert('RGB')
        d=ImageDraw.Draw(img)
        for a in r['annotations']:
            color={'drone':'lime','bird':'cyan','airplane':'orange'}[a['class']]
            d.rectangle(a['xyxy'],outline=color,width=2);d.text((a['xyxy'][0],max(0,a['xyxy'][1]-12)),a['class'],fill=color)
        img.save(out/(r['id']+'.png'))


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    for kind in ('import-image','import-video'):
        q=sub.add_parser(kind);q.add_argument('--manifest',required=True,type=Path);q.add_argument('--metadata',required=True,type=Path);q.add_argument('--input',required=True,type=Path)
        if kind=='import-video':q.add_argument('--every',required=True,type=int,help='minimum step in decoded frames');q.add_argument('--limit',type=int,default=100)
    for kind in ('validate','duplicates','visualize','split'):
        q=sub.add_parser(kind);q.add_argument('--manifest',required=True,type=Path)
        if kind in ('duplicates','split'):q.add_argument('--reference',type=Path,action='append',default=[],help='compare with a known external dataset manifest')
        if kind=='visualize':q.add_argument('--out',required=True,type=Path)
        if kind=='split':
            q.add_argument('--out',required=True,type=Path);q.add_argument('--lock',type=Path);q.add_argument('--seed',default='stage45-v1');q.add_argument('--freeze-test',action='store_true')
    args=p.parse_args(argv)
    if args.command.startswith('import-'):
        meta=json.loads(args.metadata.read_text())
        records=[ingest_image(args.input,meta,args.manifest.parent)] if args.command=='import-image' else import_video(args.input,meta,args.manifest.parent,args.every,args.limit)
        append_records(args.manifest,records);print(json.dumps({'imported':len(records),'reviewed':0}));return 0
    data=load_manifest(args.manifest); result=check(args.manifest,data)
    if args.command=='validate':print(json.dumps(result,ensure_ascii=False,indent=2));return int(result['error_count']>0)
    if result['error_count']:raise ValueError('invalid manifest or images; run validate')
    if args.command in ('duplicates','split'):
        external=[];reference_hashes=[]
        for ref in args.reference:
            reference_hashes.append(sha256_bytes(ref.read_bytes()))
            rd=load_manifest(ref);report=check(ref,rd)
            if report['error_count']:raise ValueError('invalid reference manifest/images')
            external.extend(reference_conflicts(data['records'],rd['records']))
        if args.command=='duplicates':
            print(json.dumps({'within':result['duplicate_pairs'],'reference_conflicts':external},ensure_ascii=False,indent=2));return 0
        if external:raise ValueError(f'{len(external)} potential conflicts with reference data; quarantine and review')
    if args.command=='visualize':render(args.manifest,data['records'],args.out);print('rendered',len(data['records']));return 0
    previous=json.loads(args.lock.read_text()) if args.lock else None
    if previous and 'lock' in previous:previous=previous['lock']
    if previous and previous.get('reference_sha256',[])!=sorted(reference_hashes):raise ValueError('reference manifest set differs from locked set')
    assignments,lock,pairs=make_split(data['records'],args.seed,previous,args.freeze_test)
    lock['reference_sha256']=sorted(reference_hashes)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    if args.lock and args.out.resolve()==args.lock.resolve():raise ValueError('output must differ from input lock')
    args.out.write_text(json.dumps({'assignments':assignments,'lock':lock,'candidate_pairs':pairs},indent=2)+'\n')
    print(json.dumps({'split_counts':dict(Counter(assignments.values())),'possible_duplicate_pairs':len(pairs),'test_frozen':lock['test_frozen']}));return 0

if __name__=='__main__':raise SystemExit(main())

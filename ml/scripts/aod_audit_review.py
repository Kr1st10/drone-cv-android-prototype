#!/usr/bin/env python3
"""Recreate the AOD4 stage-4.4 visual review and geometric FP accounting.

All JPEG-derived overlays stay local. Predicted boxes are the archived stage-4.3
rounded boxes; quantitative labels use those same saved TP flags.
"""
import json
from collections import Counter
from pathlib import Path
import cv2
from independent_prepare import DATA, sha
from independent_experiment import manifests, load_run
from aod_audit_integrity import AUDIT
from aod_audit_thresholds import iou

# Deliberately selected for difficult tiny GT, localization, positive detections,
# crowded scenes and non-drone errors; not a random estimate of prevalence.
POSITIVE = [0,1,2,3,4,5,6,7,8,9,10,11,13,21,29,42,50,69,75,76,79]
NEGATIVE_DETAIL = [83,87,93,96,97,98,101,102,107,110,111,113,115]


def annotations_to_box(a):
    x,y,w,h = a['bbox']
    return [x,y,x+w,y+h]


def review(rows, records):
    assert len(rows) == len(records) == 160
    fp_rows=[]; counts=Counter()
    for idx,(row,record) in enumerate(zip(rows,records)):
        if (row['split'],row['id'],row['file']) != (record['split'],record['id'],record['file']):
            raise ValueError('manifest and prediction order do not match')
        drone=[annotations_to_box(a) for a in row['annotations'] if a['class']=='drone']
        for pidx,p in enumerate(record['predictions']):
            if p[5]: continue
            best=max((iou(p,g) for g in drone), default=0.0)
            group=row['group'] if not drone else ('positive_iou_0.1_to_0.5' if .1<=best<.5 else 'positive_iou_below_0.1' if best<.1 else 'positive_iou_at_least_0.5')
            counts[group]+=1
            fp_rows.append({'number':len(fp_rows),'index':idx,'prediction_index':pidx,'split':row['split'],'file':row['file'],'box':p[:4],'score':p[4],'max_drone_iou':best,'group':group})
    return fp_rows,dict(counts)


def render(rows,records,fp_rows):
    base=AUDIT/'visuals';base.mkdir(parents=True,exist_ok=True)
    # Inspect all 80 source-negative whole frames and 75 FP crops. Selected
    # positive/negative frames supplement them with original-resolution boxes.
    negative=[i for i,r in enumerate(rows) if not any(a['class']=='drone' for a in r['annotations'])]
    selected=set(POSITIVE+NEGATIVE_DETAIL+negative)
    for idx in sorted(selected):
        row,record=rows[idx],records[idx]; path=DATA/'images'/row['file']
        if sha(path)!=row['sha256']: raise ValueError('image hash mismatch: '+str(path))
        im=cv2.imread(str(path))
        if im is None: raise ValueError('image decode failed: '+str(path))
        for a in row['annotations']:
            x1,y1,x2,y2=map(lambda x:int(round(x)),annotations_to_box(a))
            cv2.rectangle(im,(x1,y1),(x2,y2),(0,255,0) if a['class']=='drone' else (255,255,0),2)
        for x1,y1,x2,y2,score,tp in record['predictions']:
            cv2.rectangle(im,(round(x1),round(y1)),(round(x2),round(y2)),(0,255,255) if tp else (0,0,255),2)
        if not cv2.imwrite(str(base/f'frame_{idx:03}.jpg'),im): raise ValueError('cannot write overlay')
    for item in fp_rows:
        row=rows[item['index']]; im=cv2.imread(str(DATA/'images'/row['file']));x1,y1,x2,y2=item['box']
        cx,cy=(x1+x2)/2,(y1+y2)/2; side=max(128,2*max(x2-x1,y2-y1))
        l,t=max(0,int(cx-side/2)),max(0,int(cy-side/2)); r,b=min(im.shape[1],int(cx+side/2)),min(im.shape[0],int(cy+side/2))
        cv2.rectangle(im,(round(x1),round(y1)),(round(x2),round(y2)),(0,0,255),2)
        crop=im[t:b,l:r]
        if crop.size==0 or not cv2.imwrite(str(base/f'fp_{item["number"]:02}.jpg'),crop): raise ValueError('cannot write FP crop')
    print('Rendered',len(selected),'frames and',len(fp_rows),'FP crops in',base)


def main():
    rows=manifests();records=load_run('640')['records']; fp,counts=review(rows,records)
    if counts != {'positive_iou_below_0.1':3,'positive_iou_0.1_to_0.5':36,'bird':8,'airplane':28}: raise ValueError('FP categories differ')
    subset=POSITIVE+NEGATIVE_DETAIL
    examples=[{'index':i,'split':rows[i]['split'],'id':rows[i]['id'],'file':rows[i]['file'],'sha256':rows[i]['sha256'], 'annotations':rows[i]['annotations'],'predictions':records[i]['predictions']} for i in subset]
    result={'method':'archived 640 predictions at conf >0.5; original GT; max drone IoU is geometry, not a semantic class',
            'fp_count_by_frame_and_gt_overlap':counts,
            'visual_review_scope':'All 75 FP crops and 80 no-drone-annotation frames visually inspected at contact-sheet scale; 21 selected positive frames and frame 107 at full resolution. Sample is purposive, one reviewer, not adjudicated.',
            'manual_findings':[
              {'index':2,'finding':'Two aerial drone-like predicted objects do not overlap the tiny drone GT at the bottom edge. Suspect incomplete annotation and/or erroneous edge label; object identities need source verification.'},
              {'index':4,'finding':'One predicted drone-like object overlaps its GT at IoU 0.493, counted as FP+FN; a further small predicted object does not overlap a GT and needs review.'},
              {'index':5,'finding':'15 annotated drone objects; 5 predictions partially overlap GT, but none reaches IoU 0.5. A high FN concentration in one scene.'},
              {'index':11,'finding':'A detection encloses visible drone content inside a noticeably larger GT box; IoU 0.300 produces both FP and FN. Cannot decide intended box tightness without labeling policy.'},
              {'index':76,'finding':'Crowded source frame contains nine GT; seven FN and two TP. Some GT boxes overlap and object identity/type is unclear from this still; inspect source and policy before corrections.'},
              {'index':107,'finding':'Source negative labelled bird shows a held winged device and text THIS MAY LOOK LIKE A BIRD; possible artificial bird/ornithopter, class and drone inclusion need source/policy verification. No 640, 960, or SAHI prediction at threshold 0.5.'},
              {'index':0,'finding':'Tiny GT overlaps text area; visually ambiguous, not corrected.'},
              {'index':1,'finding':'Tiny GT appears on ground near larger detected object; visually ambiguous, not corrected.'},
              {'index':2,'finding':'Tiny GT is on bottom edge and visually ambiguous, not corrected.'},
              {'index':83,'finding':'A predicted box surrounds several birds; drone error despite low IoU with individual bird annotations.'},
              {'index':113,'finding':'Two unmatched model boxes correspond to the same visible airplane, so FP count is boxes rather than distinct planes.'}
            ],'limitations':'No verification of all negative frames at native resolution; object identity, annotations and exhaustiveness are not guaranteed. Manual observations are hypotheses, not relabeling.'}
    (AUDIT/'review_fps.json').write_text(json.dumps(fp,ensure_ascii=False,separators=(',',':'))+'\n')
    (AUDIT/'review_examples.json').write_text(json.dumps(examples,ensure_ascii=False,separators=(',',':'))+'\n')
    (AUDIT/'review.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
    render(rows,records,fp); print(json.dumps(counts))

if __name__=='__main__': main()

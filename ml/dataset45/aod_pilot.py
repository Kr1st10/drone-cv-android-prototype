"""Reconstruct a small, explicitly non-independent AOD4 pipeline pilot.

Images and annotation source are the stage-4.3 manifests and SHA-verified JPEGs.
The pilot is quarantined: never train/tune/final-test on it. No model is run.
"""
import argparse
import json
from pathlib import Path
from .core import ingest_image, save_manifest, sha256_bytes

# Purposeful stress cases, not a random or representative independent sample.
# All indexes refer to the concatenated stage-4.3 manifest, which is saved in git.
INDEXES = [0,4,12,14,27,34,47,59,87,93,107,110,113,115,140,145,151,153,156]
EXPECTED_MANIFESTS={
    1:'e163dad3e8f3bf9131b73b2b297c57444fe7c95dc05903f666fc18b62b3180a1',
    2:'472b4c741ee871b1f4a0195063b4d69c65843a2aae87b1156f91db15078a7371',
    3:'e2ecef89e5797fe05e6b0a8457ba92a324f49d22eb4b6dd2abadfbdb1ced3615',
    4:'c9874cbadb4f7e7080155665e6b999c917da9ea28f007a3311174571d8a9d31a',
}
SCENES={140:['nature'],145:['forest'],151:['clouds'],153:['buildings'],156:['field']}


def build(old_manifest_dir:Path, image_dir:Path, output:Path):
    rows=[]
    for i in range(1,5):
        raw=(old_manifest_dir/f'manifest_{i}.json').read_bytes()
        if sha256_bytes(raw)!=EXPECTED_MANIFESTS[i]:raise ValueError(f'stage 4.3 manifest {i} checksum mismatch')
        rows.extend(json.loads(raw))
    if len(rows)!=160:raise ValueError('expected complete stage 4.3 manifests')
    records=[]
    for idx in INDEXES:
        row=rows[idx];p=image_dir/row['file']
        if sha256_bytes(p.read_bytes())!=row['sha256']:raise ValueError('AOD image SHA mismatch: '+row['file'])
        ann=[]
        for a in row['annotations']:
            if a['class'] not in {'drone','bird','airplane'}:raise ValueError('unsupported AOD class in selected pilot')
            x,y,w,h=a['bbox'];ann.append({'class':a['class'],'xyxy':[x,y,x+w,y+h]})
        group=row['group']
        scene=SCENES.get(idx, [group if group in ('bird','airplane') else 'drone' if ann else 'unclassified'])
        m={'source_url':'https://data.mendeley.com/datasets/cd5z895tr2/1',
           'license':'CC BY 4.0 (dataset record)',
           'rights_note':'AOD source collection is CC BY 4.0; underlying videos may carry separate rights. Review before use or redistribution.',
           'source_group':'AOD4:'+row['sequence'],'sequence_id':'AOD4:'+row['sequence'],
           'source_group_verified':False,'scene':scene,'independence':'unknown','usage_history':'exposed',
           'annotations':ann,'origin_dataset':'AOD4','origin_file':row['file'],'origin_split':row['split'],
           'origin_id':row['id'],'origin_annotation_format':'COCO xywh converted to continuous xyxy'}
        records.append(ingest_image(p,m,output.parent))
    save_manifest(output,records)
    return records

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--images',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--source-manifests',type=Path,default=Path('ml/results/independent'));a=p.parse_args()
    records=build(a.source_manifests,a.images,a.output);print('quarantined AOD pilot images:',len(records))

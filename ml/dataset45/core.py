"""Stage 4.5: provenance-preserving dataset intake and annotation validation.

Bounding boxes are continuous xyxy coordinates on the canonical upright PNG.
Review flags are claims requiring a real human; import never approves labels.
"""
from __future__ import annotations
import hashlib
import io
import json
import math
from pathlib import Path
from PIL import Image, ImageOps, ImageStat

SCHEMA_VERSION = 1
CLASSES = {'drone', 'bird', 'airplane'}
REVIEW_STATES = {'unreviewed', 'reviewed', 'rejected'}
INDEPENDENCE_STATES = {'unknown', 'verified', 'overlap'}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_image(image: Image.Image) -> Image.Image:
    """Canonical pixels: EXIF-transposed, RGB, no resize; coordinates refer here."""
    return ImageOps.exif_transpose(image).convert('RGB')


def fingerprints(image: Image.Image) -> dict:
    image = canonical_image(image)
    pixel_hash = sha256_bytes(f'{image.width}x{image.height}:RGB:'.encode() + image.tobytes())
    gray = image.convert('L').resize((9, 8), Image.Resampling.LANCZOS)
    p = list(gray.get_flattened_data())
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | int(p[y*9+x] > p[y*9+x+1])
    mean = bytes(round(v) for v in ImageStat.Stat(image).mean)
    # Mean colour is a weak candidate filter, not a visual duplicate proof.
    return {'pixel_sha256': pixel_hash, 'dhash64': f'{value:016x}',
            'mean_rgb_hex': mean.hex()}


def validate_record(record: dict) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    required = ('id', 'file', 'sha256', 'source_sha256', 'pixel_sha256', 'dhash64', 'mean_rgb_hex',
                'width', 'height', 'source_url', 'license', 'rights_note', 'source_group',
                'sequence_id', 'scene', 'review_status', 'independence', 'usage_history', 'annotations', 'source_group_verified')
    for key in required:
        if key not in record or record[key] in ('', None): errors.append(f'missing {key}')
    w,h=record.get('width'),record.get('height')
    if not isinstance(w,int) or isinstance(w,bool) or w<=0 or not isinstance(h,int) or isinstance(h,bool) or h<=0:
        errors.append('invalid width/height');w=h=0
    for key in ('file','source_url','license','rights_note','source_group','sequence_id'):
        if not isinstance(record.get(key),str) or not record[key].strip(): errors.append(f'invalid {key}')
    if record.get('video_sha256') is not None:
        v=record['video_sha256']
        if not isinstance(v,str) or len(v)!=64 or any(c not in '0123456789abcdef' for c in v): errors.append('invalid video_sha256')
        if not isinstance(record.get('frame_index'),int) or isinstance(record.get('frame_index'),bool) or record['frame_index']<0: errors.append('invalid frame_index')
    if not isinstance(record.get('scene'),list) or not record['scene'] or not all(isinstance(x,str) and x.strip() for x in record['scene']): errors.append('scene must be a non-empty string list')
    if not isinstance(record.get('source_group_verified'),bool): errors.append('source_group_verified must be boolean')
    for key,length in [('id',64),('sha256',64),('source_sha256',64),('pixel_sha256',64),('dhash64',16),('mean_rgb_hex',6)]:
        try:
            value=record[key]
            if not isinstance(value,str) or len(value)!=length or value.lower()!=value or len(bytes.fromhex(value))*2!=length: raise ValueError()
        except (KeyError,ValueError,TypeError): errors.append(f'invalid {key}')
    if record.get('review_status') not in REVIEW_STATES: errors.append('invalid review_status')
    if record.get('independence') not in INDEPENDENCE_STATES: errors.append('invalid independence')
    if record.get('usage_history') not in {'unused','exposed','unknown'}: errors.append('invalid usage_history')
    if record.get('review_status')=='reviewed' and not str(record.get('reviewer','')).strip(): errors.append('reviewed annotation requires reviewer')
    if record.get('review_status')=='reviewed' and isinstance(record.get('annotations'),list) and not any(isinstance(a,dict) and a.get('class')=='drone' for a in record['annotations']) and record.get('negative_verified') is not True: errors.append('reviewed no-drone image requires negative_verified=true')
    if record.get('independence')=='verified' and not str(record.get('independence_evidence','')).strip(): errors.append('verified independence requires evidence')
    a=record.get('annotations')
    if not isinstance(a,list): errors.append('annotations must be a list');a=[]
    if not a: warnings.append('empty annotations: review negative image explicitly')
    for i, box in enumerate(a):
        if not isinstance(box,dict): errors.append(f'annotation {i}: must be object');continue
        if box.get('class') not in CLASSES: errors.append(f'annotation {i}: invalid class')
        v=box.get('xyxy')
        if not isinstance(v,list) or len(v)!=4 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in v):
            errors.append(f'annotation {i}: xyxy must contain four finite numbers');continue
        x1,y1,x2,y2=v
        if not (0<=x1<x2<=w and 0<=y1<y2<=h): errors.append(f'annotation {i}: out of bounds or non-positive extent');continue
        if min(x2-x1,y2-y1)<2: warnings.append(f'annotation {i}: dimension below 2 px')
        if (x2-x1)*(y2-y1) > .8*w*h: warnings.append(f'annotation {i}: covers over 80% of image')
        if x1==0 or y1==0 or x2==w or y2==h: warnings.append(f'annotation {i}: touches image edge')
    if len({json.dumps(x,sort_keys=True) for x in a}) < len(a): warnings.append('duplicate annotations within image')
    if record.get('review_status')!='reviewed': warnings.append('not reviewed by a human')
    if record.get('independence')!='verified': warnings.append('independence from training is not verified')
    if record.get('usage_history')!='unused': warnings.append('prior use is not known to be unused')
    return errors,warnings


def ingest_image(path: Path, metadata: dict, root: Path) -> dict:
    """Copy the original photo as canonical upright PNG and preserve its digest.

    Supplied annotation coordinates must refer to the upright canonical image.
    Automatic suggestions, if any, are unreviewed; user-supplied status is ignored.
    """
    raw=path.read_bytes()
    with Image.open(io.BytesIO(raw)) as img:
        image=canonical_image(img)
    return ingest_pixels(image, metadata, root, sha256_bytes(raw))


def ingest_pixels(image: Image.Image, metadata: dict, root: Path, source_sha: str) -> dict:
    image=canonical_image(image)
    out=io.BytesIO();image.save(out,format='PNG',compress_level=6);data=out.getvalue()
    sha=sha256_bytes(data); root.mkdir(parents=True,exist_ok=True); (root/'images').mkdir(exist_ok=True)
    dest=root/'images'/f'{sha}.png'
    if dest.exists() and sha256_bytes(dest.read_bytes())!=sha: raise ValueError('existing destination hash mismatch')
    if not dest.exists(): dest.write_bytes(data)
    # Preserve caller's provenance values, but do not accept pre-approval at ingestion.
    keep=('source_url','license','rights_note','source_group','sequence_id','scene','independence','independence_evidence','usage_history','annotations','video_sha256','frame_index','frame_time_seconds','source_group_verified')
    record={k:metadata[k] for k in keep if k in metadata}
    identity=json.dumps([metadata.get('source_group'),metadata.get('sequence_id'),source_sha,metadata.get('frame_index')],separators=(',',':')).encode()
    record.update({'id': sha256_bytes(identity), 'file':str(Path('images')/dest.name), 'sha256':sha,
                   'source_sha256':source_sha, 'width':image.width, 'height':image.height,
                   'review_status':'unreviewed', **fingerprints(image)})
    errors,_=validate_record(record)
    if errors: raise ValueError('; '.join(errors))
    return record


def load_manifest(path: Path) -> dict:
    data=json.loads(path.read_text())
    if data.get('version')!=SCHEMA_VERSION or not isinstance(data.get('records'),list): raise ValueError('unsupported manifest')
    return data


def save_manifest(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(json.dumps({'version':SCHEMA_VERSION,'records':records},ensure_ascii=False,indent=2)+'\n')
    tmp.replace(path)

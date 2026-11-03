#!/usr/bin/env python3
"""Reproduce the small DUT tracking audit sample using dataset45 ingestion.

Six evenly spaced frames per pinned video shard (independent of detector output).
Images stay local. Source bbox is xywh on the original JPEG. Labels stay
unreviewed/quarantined: this tool cannot approve them.
"""
from __future__ import annotations
import argparse, hashlib, io, json
from pathlib import Path
import pyarrow.parquet as pq
from PIL import Image
from ml.dataset45.core import ingest_image, save_manifest
from ml.dataset45.cli import check


def sha(path):
    with path.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def positions(n, k=6):
    return sorted({round((n - 1) * i / (k - 1)) for i in range(k)})


def xywh_to_xyxy(box, w, h):
    x, y, bw, bh = box
    if not (x >= 0 and y >= 0 and bw > 0 and bh > 0 and x + bw <= w and y + bh <= h):
        raise ValueError(f'invalid original bbox {box}')
    return [x, y, x + bw, y + bh]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-dir', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--sources', type=Path, default=Path('ml/results/dut63/sources.json'))
    args = p.parse_args(argv); spec = json.loads(args.sources.read_text()); records = []
    if args.output.exists(): raise ValueError('output must not already exist')
    args.output.mkdir(parents=True); raw = args.output / 'source-jpeg'; raw.mkdir()
    for item in spec['files']:
        file = args.source_dir / item['path']
        if sha(file) != item['sha256']: raise ValueError(f'checksum mismatch for {file}')
        rows = pq.read_table(file).to_pylist()
        for pos in positions(len(rows)):
            row = rows[pos]; v = row['video_id']; frame = row['frame_index']; box = row['bbox']
            if box == [-100.0] * 4: continue  # invisible is NOT a verified drone-free frame
            xyxy = xywh_to_xyxy(box, row['width'], row['height'])
            content = row['image']['bytes']; path = raw / f'{v}-{frame:05}.jpg'; path.write_bytes(content)
            with Image.open(io.BytesIO(content)) as im:
                if im.size != (row['width'], row['height']): raise ValueError(f'image shape mismatch {v}:{frame}')
                if im.getexif().get(274, 1) != 1: raise ValueError(f'EXIF orientation needs manual review {v}:{frame}')
            meta = {'source_url': spec['source'] + '/blob/' + spec['revision'] + '/' + item['path'],
                    'license': 'Apache-2.0 (mirror and primary repository); image rights not separately stated',
                    'rights_note': 'Images are not redistributed by this project',
                    'source_group': 'DUT-' + v, 'sequence_id': 'DUT-' + v, 'source_group_verified': False,
                    'scene': ['unknown'], 'independence': 'unknown', 'usage_history': 'unknown',
                    'annotations': [{'class': 'drone', 'xyxy': xyxy}], 'frame_index': frame,
                    'origin_dataset': 'DUT Anti-UAV tracking', 'origin_file': f'{v}/{frame:05}.jpg',
                    'origin_split': 'tracking', 'origin_id': str(frame), 'origin_annotation_format': 'xywh pixels'}
            records.append(ingest_image(path, meta, args.output))
    manifest = args.output / 'manifest.json'; save_manifest(manifest, records)
    report = check(manifest, {'version': 1, 'records': records})
    if report['error_count']: raise ValueError('dataset45 validation failed')
    (args.output / 'validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'selected': len(records), 'sizes': report['drone_size_px_sqrt_area'],
                      'duplicate_pairs': report['duplicate_pairs'], 'errors': report['error_count']}, ensure_ascii=False))

if __name__ == '__main__': main()

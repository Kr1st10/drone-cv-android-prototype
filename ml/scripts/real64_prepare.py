#!/usr/bin/env python3
"""Stage 6.4: import Halmstad visible videos (CC0) and the Flying Object Dataset (MIT)
into dataset45 manifests. Images stay local; every record stays `unreviewed`.

Halmstad labels: MATLAB groundTruth [x y w h], 1-based -> xyxy 0-based (x-1, y-1, x-1+w, y-1+h).
Flying Object: YOLO normalised cx cy w h. Helicopters are not a dataset45 class and are kept in
`other_objects` (non-drone negatives). Frames whose label says "target absent" are kept only as
`label_absent` evidence, never as verified negatives.
"""
from __future__ import annotations
import argparse, hashlib, json, math, re
from pathlib import Path
import cv2
from PIL import Image
from ml.dataset45.core import ingest_pixels, ingest_image, save_manifest

CLASS_MAP = {'DRONE': 'drone', 'BIRD': 'bird', 'AIRPLANE': 'airplane', 'HELICOPTER': 'helicopter'}
SKY_CLASSES = {'0': 'bird', '1': 'helicopter', '2': 'airplane'}


def sha_file(p: Path) -> str:
    with p.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def matlab_xywh_to_xyxy(b, w, h):
    x, y, bw, bh = b; x1, y1 = x - 1, y - 1
    box = [max(0.0, x1), max(0.0, y1), min(float(w), x1 + bw), min(float(h), y1 + bh)]
    return box if box[2] > box[0] and box[3] > box[1] else None


def yolo_to_xyxy(cx, cy, bw, bh, w, h):
    box = [max(0.0, (cx - bw / 2) * w), max(0.0, (cy - bh / 2) * h), min(float(w), (cx + bw / 2) * w), min(float(h), (cy + bh / 2) * h)]
    return box if box[2] > box[0] and box[3] > box[1] else None


def sky_sequences(names, gap_s=10.0):
    """Group timestamped file names (YYYYmmddHHMMSSffffff) into sequences split by gaps > gap_s."""
    def t(n):
        s = re.search(r'(\d{20})', n).group(1)
        return int(s[8:10]) * 3600 + int(s[10:12]) * 60 + int(s[12:14]) + int(s[14:]) / 1e6
    out, seq, last = {}, 0, None
    for n in sorted(names, key=t):
        if last is not None and t(n) - last > gap_s: seq += 1
        out[n] = seq; last = t(n)
    return out


def read_description(xlsx):
    import openpyxl
    ws = openpyxl.load_workbook(xlsx, read_only=True).worksheets[0]; rows = list(ws.iter_rows(values_only=True))[1:]
    return {f'V_{r[1]}_{int(r[2]):03d}': {'distance_bin': r[3], 'source_note': r[5]} for r in rows if r[0] == 'V'}


def halmstad(video_dir: Path, xlsx: Path, out: Path, every: int):
    from mcos_decoder import load_groundtruth
    desc = read_description(xlsx); records, videos = [], []
    for mp4 in sorted(video_dir.glob('V_*.mp4')):
        name = mp4.stem; cls = CLASS_MAP[name.split('_')[1]]; meta = desc.get(name, {})
        labels = load_groundtruth(str(mp4.with_name(name + '_LABELS.mat')))
        cap = cv2.VideoCapture(str(mp4)); frames = []
        while True:
            ok, bgr = cap.read()
            if not ok: break
            frames.append(bgr)
        cap.release()
        internet = bool(meta.get('source_note') and 'http' in str(meta['source_note']))
        info = {'video': name, 'class': cls, 'frames': len(frames), 'labels': len(labels), 'distance_bin': meta.get('distance_bin'),
                'source_note': meta.get('source_note'), 'video_sha256': sha_file(mp4), 'internet_sourced': internet}
        # dataset README: labels per frame; off-by-one (decoder vs frame count) accepted, larger gaps quarantined
        info['status'] = 'ok' if abs(len(labels) - len(frames)) <= 1 else 'label_length_mismatch'
        videos.append(info)
        if info['status'] != 'ok': continue
        for i in range(0, min(len(frames), len(labels)), every):
            h, w = frames[i].shape[:2]; b = labels[i]
            box = matlab_xywh_to_xyxy(b, w, h) if b is not None else None
            ann = [{'class': cls, 'xyxy': [round(v, 2) for v in box]}] if box and cls != 'helicopter' else []
            other = [{'class': 'helicopter', 'xyxy': [round(v, 2) for v in box]}] if box and cls == 'helicopter' else []
            m = {'source_url': 'https://doi.org/10.5281/zenodo.5500576', 'license': 'CC0-1.0',
                 'rights_note': 'Third-party internet video (YouTube) per dataset description; local evaluation only' if internet else 'Own recordings of dataset authors (Svanström et al.), CC0',
                 'source_group': 'halmstad:' + name, 'sequence_id': 'halmstad:' + name, 'scene': [cls, str(meta.get('distance_bin', 'unknown')).lower()],
                 'independence': 'unknown', 'usage_history': 'unknown', 'source_group_verified': False, 'annotations': ann,
                 'video_sha256': info['video_sha256'], 'frame_index': i, 'frame_time_seconds': i / 30.0,
                 'origin_dataset': 'Halmstad Drone-detection-dataset v1.0.0 (visible)', 'origin_file': mp4.name,
                 'origin_annotation_format': 'MATLAB groundTruth xywh, 1-based'}
            r = ingest_pixels(Image.fromarray(cv2.cvtColor(frames[i], cv2.COLOR_BGR2RGB)), m, out, info['video_sha256'])
            r.update({'other_objects': other, 'label_absent': b is None, 'video_class': cls, 'distance_bin': meta.get('distance_bin'),
                      'internet_sourced': internet, 'dataset': 'halmstad'})
            records.append(r)
    return records, videos


def flying(src: Path, out: Path):
    names = [p.name for p in sorted(src.glob('*.jpg'))]; seq = sky_sequences(names); records = []
    for n in names:
        p = src / n
        with Image.open(p) as im: w, h = im.size
        ann, other = [], []
        for line in (src / (p.stem + '.txt')).read_text().split('\n'):
            if not line.strip(): continue
            c, cx, cy, bw, bh = line.split()[:5]; box = yolo_to_xyxy(float(cx), float(cy), float(bw), float(bh), w, h)
            if box is None: continue
            (other if SKY_CLASSES[c] == 'helicopter' else ann).append({'class': SKY_CLASSES[c], 'xyxy': [round(v, 2) for v in box]})
        m = {'source_url': 'https://github.com/sekilab/FlyingObjectDataset', 'license': 'MIT',
             'rights_note': 'Images from a fixed camera on Roppongi Hills (Mori Building cooperation); MIT per repository LICENSE',
             'source_group': 'flying:roppongi-20191206', 'sequence_id': f'flying:seq{seq[n]:03d}', 'scene': ['sky', 'city'],
             'independence': 'unknown', 'usage_history': 'unknown', 'source_group_verified': False, 'annotations': ann,
             'origin_dataset': 'Flying Object Dataset (sekilab)', 'origin_file': n, 'origin_split': n.split('_')[0],
             'origin_annotation_format': 'YOLO normalised cx cy w h'}
        r = ingest_image(p, m, out); r.update({'other_objects': other, 'label_absent': False, 'dataset': 'flying'}); records.append(r)
    return records


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--halmstad-videos', type=Path, required=True); a.add_argument('--halmstad-xlsx', type=Path, required=True)
    a.add_argument('--flying-dir', type=Path, required=True); a.add_argument('--output', type=Path, required=True)
    a.add_argument('--every', type=int, default=30); args = a.parse_args(argv)
    if args.output.exists(): raise ValueError('output must not exist')
    recs, videos = halmstad(args.halmstad_videos, args.halmstad_xlsx, args.output, args.every)
    recs += flying(args.flying_dir, args.output)
    save_manifest(args.output / 'manifest.json', recs)
    (args.output / 'videos.json').write_text(json.dumps(videos, indent=1, ensure_ascii=False) + '\n')
    print(len(recs), sum(v['status'] == 'ok' for v in videos), len(videos))

if __name__ == '__main__': main()

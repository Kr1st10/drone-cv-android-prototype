#!/usr/bin/env python3
"""Stage 6.3: real DUT-Anti-UAV detection data -> audit -> baseline -> limited fine-tune.

Subcommands (images and weights stay local, never committed):
  prepare   verify pinned shard SHA-256, extract JPEGs, automatic label checks,
            near-duplicate clusters and train->validation leakage filtering.
  predict   run an Ultralytics checkpoint over the validation split.
  evaluate  P/R/TP/FP/FN and size buckets via ml.dataset45.evaluate (shared matcher).
  train     limited fine-tune on the leakage-filtered train split only; no
            validation is used for checkpoint selection (val=False, last.pt).

Validation = official DUT *val* split (shard pinned in sources.json); it is a
development validation set, NOT an independent test. Automatic checks are not
human annotation review.
"""
from __future__ import annotations
import argparse, hashlib, io, json, math, platform, time
from pathlib import Path
from PIL import Image
from ml.dataset45.core import fingerprints
from ml.dataset45.evaluate import evaluate_records

SIZE_BINS = ('<16', '16-<24', '24-<30', '>=30')


def sha_file(path: Path) -> str:
    with path.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def size_bin(xyxy) -> str:
    s = math.sqrt(max(0.0, xyxy[2] - xyxy[0]) * max(0.0, xyxy[3] - xyxy[1]))
    return '<16' if s < 16 else '16-<24' if s < 24 else '24-<30' if s < 30 else '>=30'


def box_issues(box, category, w, h, tol=1.0):
    """Automatic checks for one source box (xyxy pixels). Returns list of issue codes."""
    out = []
    if category != 0: out.append('unexpected_category')
    if len(box) != 4 or any(not math.isfinite(v) for v in box): return out + ['malformed']
    x1, y1, x2, y2 = box
    if not (x2 > x1 and y2 > y1): out.append('non_positive_size')
    if x1 < -tol or y1 < -tol or x2 > w + tol or y2 > h + tol: out.append('outside_image')
    elif x1 < 0 or y1 < 0 or x2 > w or y2 > h: out.append('clipped_within_tolerance')
    if (x2 - x1) * (y2 - y1) > 0.5 * w * h: out.append('implausibly_large')
    return out


def clip(box, w, h):
    x1, y1, x2, y2 = box
    return [min(max(x1, 0.0), w), min(max(y1, 0.0), h), min(max(x2, 0.0), w), min(max(y2, 0.0), h)]


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count('1')


def clusters(items, max_h):
    """Union-find over dHash Hamming <= max_h. items: list of (id, dhash). Returns list of id lists (size>1)."""
    parent = {i: i for i, _ in items}
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if hamming(items[i][1], items[j][1]) <= max_h: parent[find(items[i][0])] = find(items[j][0])
    groups = {}
    for i, _ in items: groups.setdefault(find(i), []).append(i)
    return sorted((sorted(g) for g in groups.values() if len(g) > 1), key=lambda g: g[0])


def leakage(train, val, max_h):
    """train/val: list of records with pixel_sha256, dhash64. Returns {train_id: (min_hamming, val_id)} for leaks."""
    out = {}
    exact = {v['pixel_sha256']: v['id'] for v in val}
    for t in train:
        if t['pixel_sha256'] in exact: out[t['id']] = (0, exact[t['pixel_sha256']]); continue
        best = min(((hamming(t['dhash64'], v['dhash64']), v['id']) for v in val), default=(65, None))
        if best[0] <= max_h: out[t['id']] = best
    return out


def read_shard(path: Path, split: str, image_dir: Path):
    import pyarrow.parquet as pq
    records = []
    pf = pq.ParquetFile(path)
    for rg in range(pf.num_row_groups):
        for row in pf.read_row_group(rg).to_pylist():
            content = row['image']['bytes']; rid = f'dut-det-{split}-{row["image_id"]}'
            with Image.open(io.BytesIO(content)) as im:
                im.load(); size = im.size; exif = im.getexif().get(274, 1); fp = fingerprints(im)
            issues = []
            if size != (row['width'], row['height']): issues.append('declared_size_mismatch')
            if exif != 1: issues.append('exif_orientation')
            w, h = size; anns = []
            for box, cat in zip(row['objects']['bbox'], row['objects']['category']):
                bi = box_issues(list(box), cat, w, h); issues += bi
                if 'malformed' in bi or 'non_positive_size' in bi or 'outside_image' in bi: continue
                xyxy = clip([float(v) for v in box], w, h)
                anns.append({'class': 'drone', 'xyxy': xyxy, 'size_bin': size_bin(xyxy)})
            if not row['objects']['bbox']: issues.append('no_boxes')
            path_out = image_dir / split / f'{rid}.jpg'; path_out.parent.mkdir(parents=True, exist_ok=True)
            path_out.write_bytes(content)  # original bytes, no re-encode
            records.append({'id': rid, 'origin_split': split, 'origin_image_id': row['image_id'], 'origin_shard': path.name,
                            'file': str(path_out), 'sha256': hashlib.sha256(content).hexdigest(), 'width': w, 'height': h,
                            'pixel_sha256': fp['pixel_sha256'], 'dhash64': fp['dhash64'], 'annotations': anns,
                            'auto_issues': sorted(set(issues)), 'review_status': 'auto_checked_unreviewed'})
    return records


def cmd_prepare(a):
    spec = json.loads(a.sources.read_text()); det = spec['detection_files']; out = {}
    if a.output.exists(): raise ValueError('output must not already exist')
    a.output.mkdir(parents=True)
    for split in ('validation', 'train'):
        out[split] = []
        for item in det[split]:
            f = a.source_dir / item['path']
            if sha_file(f) != item['sha256']: raise ValueError(f'checksum mismatch {f}')
            out[split] += read_shard(f, split, a.output / 'images')
    val, train = out['validation'], out['train']
    leaks = leakage(train, val, a.leak_hamming)
    exact_within = {}
    for s in (val, train):
        for r in s: exact_within.setdefault(r['pixel_sha256'], []).append(r['id'])
    report = {'sources_sha256': sha_file(a.sources), 'leak_max_hamming': a.leak_hamming, 'cluster_max_hamming': a.cluster_hamming}
    for name, recs in (('validation', val), ('train', train)):
        bins = {k: 0 for k in SIZE_BINS}; issues = {}
        for r in recs:
            for x in r['annotations']: bins[x['size_bin']] += 1
            for i in r['auto_issues']: issues[i] = issues.get(i, 0) + 1
        cl = clusters([(r['id'], r['dhash64']) for r in recs], a.cluster_hamming)
        report[name] = {'images': len(recs), 'boxes': sum(len(r['annotations']) for r in recs), 'size_bins_sqrt_area': bins,
                        'auto_issue_counts': issues, 'images_with_issues': sum(bool(r['auto_issues']) for r in recs),
                        'near_duplicate_clusters': len(cl), 'images_in_clusters': sum(map(len, cl)),
                        'effective_images_after_cluster_collapse': len(recs) - sum(map(len, cl)) + len(cl),
                        'largest_clusters': [g[:5] + (['...'] if len(g) > 5 else []) for g in sorted(cl, key=len, reverse=True)[:5]]}
    report['exact_pixel_duplicates'] = [v for v in exact_within.values() if len(v) > 1]
    dist = {}
    for t in train:
        d = 0 if t['id'] in leaks and leaks[t['id']][0] == 0 else min(hamming(t['dhash64'], v['dhash64']) for v in val)
        dist[d] = dist.get(d, 0) + 1
    report['train_to_val_min_dhash_hamming_histogram'] = dict(sorted(dist.items()))
    report['train_excluded_for_leakage'] = len(leaks)
    for r in train:
        if r['id'] in leaks: r['excluded'] = {'reason': 'near_duplicate_of_validation', 'hamming': leaks[r['id']][0], 'val_id': leaks[r['id']][1]}
        elif r['auto_issues'] and set(r['auto_issues']) - {'clipped_within_tolerance'}: r['excluded'] = {'reason': 'auto_issue'}
    report['train_usable'] = sum('excluded' not in r for r in train)
    manifest = {'version': 1, 'note': 'Local paths; images are not committed. review_status is automatic only.', 'records': val + train}
    (a.output / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
    (a.output / 'audit.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(report, indent=2, ensure_ascii=False))


def load(manifest: Path, split: str):
    recs = json.loads(manifest.read_text())['records']
    return [r for r in recs if r['origin_split'] == split and 'excluded' not in r]


def cmd_predict(a):
    from ultralytics import YOLO
    import ultralytics, torch
    torch.set_num_threads(a.threads)
    model = YOLO(str(a.weights)); recs = load(a.manifest, 'validation'); out = []
    for r in recs:
        t = time.perf_counter()
        res = model.predict(r['file'], imgsz=a.imgsz, conf=a.min_conf, iou=a.nms_iou, device='cpu', verbose=False, max_det=100)[0]
        ms = (time.perf_counter() - t) * 1000; preds = []
        for (x1, y1, x2, y2), s in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist()):
            b = clip([x1, y1, x2, y2], r['width'], r['height'])
            if b[2] > b[0] and b[3] > b[1]: preds.append([round(v, 1) for v in b] + [round(s, 4)])
        out.append({'id': r['id'], 'predictions': preds, 'ms': round(ms, 1)})
    cfg = {'model_id': a.model_id, 'model_sha256': sha_file(a.weights), 'imgsz': a.imgsz, 'confidence': a.min_conf,
           'nms_iou': a.nms_iou, 'matching_iou': 0.5, 'ultralytics': ultralytics.__version__, 'torch': torch.__version__,
           'timing_conditions': f'{platform.machine()} CPU, {a.threads} torch threads, Ultralytics predict incl. pre/post, sandbox (not phone)',
           'manifest_sha256': sha_file(a.manifest)}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps({'config': cfg, 'records': out}, separators=(',', ':')) + '\n'); print(a.output, len(out))


def threshold(preds, conf):
    return [{**e, 'predictions': [p for p in e['predictions'] if p[4] > conf]} for e in preds]


def max_iou(box, gt):
    from ml.scripts.evaluate import iou_matrix
    import numpy as np
    return float(iou_matrix(np.array([box], float), gt).max()) if len(gt) else 0.0


def cluster_bootstrap(recs, preds, conf, groups, n=2000, seed=63):
    """95% percentile CI for P and R resampling near-duplicate clusters (correlated frames) as units."""
    import numpy as np
    from ml.scripts.evaluate import match
    by = {e['id']: e for e in preds}; per = {}
    for r in recs:
        p = [x for x in by[r['id']]['predictions'] if x[4] > conf]
        gt = np.array([x['xyxy'] for x in r['annotations']], float).reshape(-1, 4)
        tp, hit, _ = match(np.array([x[:4] for x in p], float).reshape(-1, 4), np.array([x[4] for x in p], float), gt, 0.5)
        c = per.setdefault(groups.get(r['id'], r['id']), [0, 0, 0]); c[0] += int(tp.sum()); c[1] += int((~tp).sum()); c[2] += int((~hit).sum())
    arr = np.array(list(per.values()), float); rng = np.random.default_rng(seed); P, R = [], []
    for _ in range(n):
        s = arr[rng.integers(0, len(arr), len(arr))].sum(0)
        P.append(s[0] / (s[0] + s[1]) if s[0] + s[1] else np.nan); R.append(s[0] / (s[0] + s[2]) if s[0] + s[2] else np.nan)
    q = lambda v: [round(float(np.nanpercentile(v, 2.5)), 4), round(float(np.nanpercentile(v, 97.5)), 4)]
    return {'units': len(arr), 'precision_ci95': q(P), 'recall_ci95': q(R), 'resamples': n, 'seed': seed}


def examples(recs, preds, conf, k=8):
    from ml.scripts.evaluate import match
    import numpy as np
    by = {e['id']: e for e in preds}; fps, fns = [], []
    for r in recs:
        p = [x for x in by[r['id']]['predictions'] if x[4] > conf]
        gt = np.array([x['xyxy'] for x in r['annotations']], float).reshape(-1, 4)
        tp, hit, _ = match(np.array([x[:4] for x in p], float).reshape(-1, 4), np.array([x[4] for x in p], float), gt, 0.5)
        fps += [{'id': r['id'], 'box': x[:4], 'score': x[4], 'size_bin': size_bin(x[:4]), 'max_iou_gt': round(max_iou(x[:4], gt), 3)} for x, t in zip(p, tp) if not t]
        fns += [{'id': r['id'], 'box': g['xyxy'], 'size_bin': g['size_bin'],
                 'best_pred_score': max((x[4] for x in by[r['id']]['predictions']), default=None)} for g, h in zip(r['annotations'], hit) if not h]
    fps.sort(key=lambda x: -x['score']); fns.sort(key=lambda x: (SIZE_BINS.index(x['size_bin']), x['id']))
    return fps, fns


def cmd_evaluate(a):
    recs = load(a.manifest, 'validation'); data = json.loads(a.predictions.read_text()); result = {'config': data['config'], 'by_confidence': {}}
    groups = {i: g[0] for g in clusters([(r['id'], r['dhash64']) for r in recs], 4) for i in g}
    for conf in a.conf:
        r = evaluate_records(recs, threshold(data['records'], conf), conf)
        fps, fns = examples(recs, data['records'], conf)
        loose = evaluate_records(recs, threshold(data['records'], conf), conf, 0.3)
        r['diagnostic_match_iou_0.3'] = {k: loose[k] for k in ('counts', 'precision_all', 'recall', 'recall_by_size')}
        r['fp_by_pred_size'] = {k: sum(x['size_bin'] == k for x in fps) for k in SIZE_BINS}
        r['fn_by_size'] = {k: sum(x['size_bin'] == k for x in fns) for k in SIZE_BINS}
        r['fp_localization'] = {'overlaps_gt_iou_0.1_to_0.5': sum(0.1 <= x['max_iou_gt'] < 0.5 for x in fps), 'no_gt_overlap_iou_lt_0.1': sum(x['max_iou_gt'] < 0.1 for x in fps)}
        r['cluster_bootstrap'] = cluster_bootstrap(recs, data['records'], conf, groups)
        r['examples'] = {'top_fp': fps[:a.examples], 'fn': fns[:a.examples * 2]}
        result['by_confidence'][str(conf)] = r
    result['split'] = 'DUT official val shard (development validation, not independent test)'
    result['predictions_sha256'] = sha_file(a.predictions)
    a.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({c: {k: v[k] for k in ('counts', 'precision_all', 'recall', 'recall_by_size')} for c, v in result['by_confidence'].items()}, indent=1))


def yolo_label(r):
    w, h = r['width'], r['height']
    return ''.join(f'0 {(x1+x2)/(2*w):.8f} {(y1+y2)/(2*h):.8f} {(x2-x1)/w:.8f} {(y2-y1)/h:.8f}\n' for x1, y1, x2, y2 in (x['xyxy'] for x in r['annotations']))


def cmd_train(a):
    config = json.loads(a.config.read_text())
    if sha_file(a.weights) != config['checkpoint_sha256']: raise ValueError('checkpoint SHA mismatch')
    recs = load(a.manifest, 'train')
    if a.limit: recs = recs[:a.limit]
    d = a.workdir / 'data'
    if d.exists(): raise ValueError('workdir/data must not exist')
    (d / 'images' / 'train').mkdir(parents=True); (d / 'labels' / 'train').mkdir(parents=True)
    for r in recs:
        (d / 'images' / 'train' / Path(r['file']).name).symlink_to(Path(r['file']).resolve())
        (d / 'labels' / 'train' / (r['id'] + '.txt')).write_text(yolo_label(r))
    # Ultralytics requires a 'val' key; val=False means it is never evaluated or used for selection.
    (d / 'data.yaml').write_text(json.dumps({'path': str(d.resolve()), 'train': 'images/train', 'val': 'images/train', 'names': {0: 'drone'}}) + '\n')
    (a.workdir / 'train_ids.json').write_text(json.dumps(sorted(r['id'] for r in recs)) + '\n')
    from ultralytics import YOLO
    import torch; torch.set_num_threads(a.threads)
    model = YOLO(str(a.weights))
    model.train(data=str(d / 'data.yaml'), project=str(a.workdir.resolve()), name='run', exist_ok=False, device=a.device, val=False, plots=False, **config['train'])


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__); s = p.add_subparsers(dest='cmd', required=True)
    q = s.add_parser('prepare'); q.add_argument('--source-dir', type=Path, required=True); q.add_argument('--output', type=Path, required=True)
    q.add_argument('--sources', type=Path, default=Path('ml/results/dut63/sources.json'))
    q.add_argument('--leak-hamming', type=int, default=10); q.add_argument('--cluster-hamming', type=int, default=4)
    q = s.add_parser('predict'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--weights', type=Path, required=True)
    q.add_argument('--model-id', required=True); q.add_argument('--output', type=Path, required=True); q.add_argument('--imgsz', type=int, default=640)
    q.add_argument('--min-conf', type=float, default=0.1); q.add_argument('--nms-iou', type=float, default=0.45); q.add_argument('--threads', type=int, default=2)
    q = s.add_parser('evaluate'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--predictions', type=Path, required=True)
    q.add_argument('--output', type=Path, required=True); q.add_argument('--conf', type=float, nargs='+', default=[0.25, 0.5]); q.add_argument('--examples', type=int, default=8)
    q = s.add_parser('train'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--weights', type=Path, required=True)
    q.add_argument('--config', type=Path, default=Path('ml/results/dut63/finetune_config.json')); q.add_argument('--workdir', type=Path, required=True)
    q.add_argument('--limit', type=int, default=0); q.add_argument('--threads', type=int, default=2); q.add_argument('--device', default='cpu')
    a = p.parse_args(argv); {'prepare': cmd_prepare, 'predict': cmd_predict, 'evaluate': cmd_evaluate, 'train': cmd_train}[a.cmd](a)

if __name__ == '__main__': main()

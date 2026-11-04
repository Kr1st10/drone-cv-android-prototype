#!/usr/bin/env python3
"""Stage 6.5: useful small-drone data for YOLO11s (statistics, leak-free group splits, small controlled test).

build     lightweight manifest over locally downloaded sources (no re-encoding); every record gets
          dataset, group (independence unit for splits), scene (bootstrap unit), split, license.
stats     box sizes (native and at the 640 letterbox the model sees), groups/scenes, cross-split dHash.
predict   Ultralytics checkpoint over selected splits (never the Stage 6.4 sealed test, never
          the reserved test parts of the new sources: they are not in the manifest at all).
evaluate  recall by 640-letterbox size at IoU 0.5/0.3, response, FP on drone-free frames by class,
          scene bootstrap.
train     small fixed-epoch fine-tune on the train split only, final last.pt (no checkpoint selection).
compare   paired scene bootstrap baseline vs candidate (recall@0.3, response, negative FP-frame share).
"""
from __future__ import annotations
import argparse, hashlib, io, json, math, platform, random, re
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from ml.scripts.evaluate import iou_matrix, match

BINS = ('<8', '8-<16', '16-<24', '24-<30', '>=30')
SPLITS = ('train', 'validation', 'eval_only')
SEED = 'stage65-v1'
UAVDB_RESERVED_CAMERAS = {'d2c0', 'd3c4', 'd4c0', 'd4c6'}  # official UAVDB test cameras, never extracted
LICENSES = {
    'uavdb': 'CC-BY-4.0 on Zenodo, derived from CenekAlbl/drone-tracking-datasets (CC BY-NC-SA 4.0) -> treated as CC BY-NC-SA 4.0',
    'antiuav300': 'project/code MIT, no separate image licence -> research use only, no redistribution',
    'uavcb': 'CC BY-NC 4.0 (images and annotations), non-commercial',
    'vdd': 'Zenodo CC-BY-4.0, Roboflow export marked "license: Private" -> eval only, no redistribution',
    'halmstad': 'CC0-1.0 (own recordings); YouTube-sourced clips: rights of uploaders, eval only',
    'dut': 'DUT Anti-UAV (research use, see Stage 6.3)',
    'pathikg': 'MIT (pathikg/drone-detection-dataset, baseline training data)',
}


def sha_file(p):
    with Path(p).open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def side(b): return math.sqrt(max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1]))


def bin_of(s): return '<8' if s < 8 else '8-<16' if s < 16 else '16-<24' if s < 24 else '24-<30' if s < 30 else '>=30'


def size640(b, w, h, imgsz=640): return side(b) * min(imgsz / w, imgsz / h)


def dhash64(path):
    from PIL import Image
    im = Image.open(path).convert('L'); im.draft('L', (max(1, im.width // 8), max(1, im.height // 8)))
    a = np.asarray(im.resize((9, 8), Image.BILINEAR), dtype=float)
    return int(''.join('1' if x else '0' for x in (a[:, 1:] > a[:, :-1]).flatten()), 2)


def rank(key, seed=SEED): return hashlib.sha256((seed + ':' + key).encode()).hexdigest()


def rec(dataset, rid, file, w, h, group, scene, split, anns, **kw):
    r = {'id': f'{dataset}:{rid}', 'dataset': dataset, 'file': str(file), 'width': int(w), 'height': int(h), 'group': group,
         'scene': scene, 'split': split, 'annotations': anns, 'other_objects': kw.pop('other_objects', []),
         'label_absent': kw.pop('label_absent', False), 'license': LICENSES[dataset]}
    r.update(kw); return r


def drone(xyxy, w, h):
    x0, y0, x1, y1 = (float(v) for v in xyxy)
    return {'class': 'drone', 'xyxy': [round(max(0, x0), 2), round(max(0, y0), 2), round(min(w, x1), 2), round(min(h, y1), 2)]}


# ---------------------------------------------------------------- sources
def src_uavdb(sel_dir: Path, label_dir: Path):
    from PIL import Image
    out = []
    for img in sorted(sel_dir.glob('datasets/*/*.jpg')):
        cam, idx = img.stem.split('_'); flight = cam[:2]
        if cam in UAVDB_RESERVED_CAMERAS: raise ValueError(f'reserved UAVDB test camera present: {img}')
        with Image.open(img) as im: w, h = im.size
        anns = []
        for line in (label_dir / img.parent.name / (img.stem + '.txt')).read_text().split('\n'):
            if not line.strip(): continue
            c, cx, cy, bw, bh = (float(v) for v in line.split())
            anns.append(drone([(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h], w, h))
        out.append(rec('uavdb', img.stem, img, w, h, f'uavdb:{flight}', f'uavdb:{cam}', 'validation' if flight == 'd1' else 'train', anns,
                       origin_split=img.parent.name, frame_index=int(idx)))
    return out


def src_antiuav(meta: Path):
    out = []
    for m in json.loads(meta.read_text()):
        seq = m['sequence']; day = seq[:8]; sess = seq[:15]; x, y, bw, bh = m['gt_rect'] if m['exist'] else (0, 0, 0, 0)
        anns = [drone([x, y, x + bw, y + bh], 1920, 1080)] if m['exist'] and bw > 0 and bh > 0 else []
        out.append(rec('antiuav300', Path(m['file']).stem, m['file'], 1920, 1080, f'antiuav300:{day}', f'antiuav300:{sess}',
                       'train' if day == '20190925' else 'validation', anns, origin_split=m['split_official'], sequence=seq, frame_index=m['frame']))
    return out


def src_uavcb(root: Path):
    out = []
    for js in sorted(root.glob('*/visible/*.json')):
        d = json.loads(js.read_text()); w, h = d['imageWidth'], d['imageHeight']; anns = []
        for s in d['shapes']:
            p = np.array(s['points'], float); anns.append(drone([p[:, 0].min(), p[:, 1].min(), p[:, 0].max(), p[:, 1].max()], w, h))
        scene = re.sub(r'_\d+$', '', js.stem)  # e.g. building_visible_1 (camouflage background x recording part)
        out.append(rec('uavcb', js.stem, js.with_suffix('.jpg'), w, h, 'uavcb:site', f'uavcb:{scene}', 'validation', anns, background=js.parts[-3]))
    return out


def src_vdd(root: Path):
    """One copy per original (Roboflow augmentation copies share the prefix before '.rf.')."""
    from PIL import Image
    seen = {}; out = []
    for img in sorted(root.glob('*/images/*.jpg')):
        orig = img.name.split('.rf.')[0]
        if orig in seen: continue
        seen[orig] = img
        with Image.open(img) as im: w, h = im.size
        anns = []
        lab = img.parent.parent / 'labels' / (img.stem + '.txt')
        for line in (lab.read_text().split('\n') if lab.exists() else []):
            if not line.strip(): continue
            v = [float(t) for t in line.split()]
            if len(v) != 5: continue
            _, cx, cy, bw, bh = v; anns.append(drone([(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h], w, h))
        out.append(rec('vdd', orig, img, w, h, 'vdd:site', 'vdd:' + re.sub(r'_\d+.*$', '', orig), 'eval_only', anns, origin_split=img.parts[-3]))
    return out


def src_halmstad_neg(manifest: Path, split64: Path):
    """Bird/airplane/helicopter frames only; split follows Stage 6.4 groups; 6.4 sealed-test groups are dropped."""
    lock = json.loads(split64.read_text())['groups']['halmstad']; seq2g = {}
    for g, seqs in lock['group_sequences'].items():
        for q in seqs: seq2g[q] = g
    out = []; dropped = Counter()
    for r in json.loads(manifest.read_text())['records']:
        if any(a['class'] == 'drone' for a in r['annotations']): raise ValueError('drone frame in the negative import')
        g = seq2g.get(r['sequence_id'], r['sequence_id'])
        s64 = lock['group_splits'].get(g)
        if r['internet_sourced']: split = 'eval_only'
        elif s64 is None: dropped['unknown_group'] += 1; continue
        elif s64 == 'test': dropped['stage64_sealed_test'] += 1; continue
        else: split = s64
        out.append(rec('halmstad', r['id'][:16], manifest.parent / r['file'], r['width'], r['height'], g, g, split, [],
                       other_objects=r['annotations'] + r.get('other_objects', []), label_absent=r['label_absent'],
                       video_class=r['video_class'], internet_sourced=r['internet_sourced']))
    return out, dict(dropped)


def src_dut(parquet: Path, image_dir: Path):
    from ml.scripts.dut63 import read_shard
    out = []
    for r in read_shard(parquet, 'val', image_dir):
        out.append(rec('dut', r['origin_image_id'], r['file'], r['width'], r['height'], 'dut:val', f'dut:{r["dhash64"][:3]}', 'eval_only',
                       [{'class': 'drone', 'xyxy': a['xyxy']} for a in r['annotations']], scene_note='dut val has no sequence ids; scene = dHash prefix'))
    return out


def src_pathikg(parquet: Path, image_dir: Path, n_train=500, n_check=300):
    """Baseline training data (replay against forgetting + forgetting check; not a generalisation set)."""
    import pyarrow.parquet as pq
    from PIL import Image
    t = pq.read_table(parquet, columns=['image_id']).column('image_id').to_pylist()
    order = sorted(t, key=lambda i: rank(f'pathikg:{i}')); pick = {i: 'train' for i in order[:n_train]}
    pick.update({i: 'eval_only' for i in order[n_train:n_train + n_check]})
    image_dir.mkdir(parents=True, exist_ok=True); out = []; pf = pq.ParquetFile(parquet)
    for g in range(pf.num_row_groups):
        for row in pf.read_row_group(g).to_pylist():
            if row['image_id'] not in pick: continue
            b = row['image']['bytes']; p = image_dir / f'pathikg_{row["image_id"]}.jpg'; p.write_bytes(b)
            with Image.open(io.BytesIO(b)) as im: w, h = im.size
            anns = [drone([x, y, x + bw, y + bh], w, h) for x, y, bw, bh in row['objects']['bbox'] if bw > 0 and bh > 0]
            s = pick[row['image_id']]
            out.append(rec('pathikg', row['image_id'], p, w, h, f'pathikg:{s}', f'pathikg:{rank(str(row["image_id"]))[:2]}', s, anns,
                           role='replay' if s == 'train' else 'forgetting_check'))
    return out


def cmd_build(a):
    recs = []; recs += src_uavdb(a.uavdb_sel, a.uavdb_labels); recs += src_antiuav(a.antiuav_meta); recs += src_uavcb(a.uavcb)
    recs += src_vdd(a.vdd); hn, dropped = src_halmstad_neg(a.halmstad_manifest, a.split64); recs += hn
    recs += src_dut(a.dut, a.workdir / 'dut'); recs += src_pathikg(a.pathikg, a.workdir / 'pathikg')
    for r in recs: r['dhash64'] = f'{dhash64(r["file"]):016x}'
    ids = Counter(r['id'] for r in recs)
    if max(ids.values()) > 1: raise ValueError('duplicate ids')
    a.output.write_text(json.dumps({'version': 1, 'seed': SEED, 'halmstad_dropped': dropped, 'records': recs}, separators=(',', ':')) + '\n')
    print(Counter((r['dataset'], r['split']) for r in recs), dropped)


def load(manifest, splits=SPLITS):
    if 'test' in splits: raise ValueError('test parts are sealed and not in the manifest')
    return [r for r in json.loads(Path(manifest).read_text())['records'] if r['split'] in splits]


# ---------------------------------------------------------------- stats
def hamming_pairs(A, B, max_h):
    """Count pairs (i in A, j in B) with Hamming(dhash) <= max_h. A, B: uint64 arrays."""
    n = 0; hit_a = np.zeros(len(A), bool)
    for i in range(0, len(A), 512):
        x = np.bitwise_xor(A[i:i + 512, None], B[None, :]); d = np.bitwise_count(x)
        m = d <= max_h; n += int(m.sum()); hit_a[i:i + 512] |= m.any(1)
    return n, int(hit_a.sum())


def thumb(path, n=32):
    """Mean/std-normalised 32x32 grayscale thumbnail (second-stage duplicate check behind the coarse dHash)."""
    from PIL import Image
    im = Image.open(path).convert('L'); im.draft('L', (max(1, im.width // 8), max(1, im.height // 8)))
    a = np.asarray(im.resize((n, n), Image.BILINEAR), dtype=np.float32); return (a - a.mean()) / (a.std() + 8.0)


def pair_candidates(A, B, max_h):
    """Index pairs (i, j) with Hamming(dhash) <= max_h."""
    out = []
    for i in range(0, len(A), 512):
        ii, jj = np.nonzero(np.bitwise_count(np.bitwise_xor(A[i:i + 512, None], B[None, :])) <= max_h); out += list(zip(ii + i, jj))
    return out


def near_duplicates(train, other, max_h=6, max_mad=0.12):
    """dHash candidates confirmed by a normalised-thumbnail mean absolute difference.

    Plain sky frames collide in dHash across unrelated datasets, so dHash alone is only a candidate filter.
    """
    A = np.array([int(r['dhash64'], 16) for r in train], np.uint64); B = np.array([int(r['dhash64'], 16) for r in other], np.uint64)
    cand = pair_candidates(A, B, max_h); cache = {}; res = []
    def t(r):
        if r['id'] not in cache: cache[r['id']] = thumb(r['file'])
        return cache[r['id']]
    for i, j in cand:
        d = float(np.abs(t(train[i]) - t(other[j])).mean())
        if d <= max_mad: res.append((train[i]['id'], other[j]['id'], round(d, 4)))
    return len(cand), res


def cmd_stats(a):
    recs = load(a.manifest); out = {'by_dataset': {}, 'cross_split_dhash': {}}
    for ds in sorted({r['dataset'] for r in recs}):
        sub = [r for r in recs if r['dataset'] == ds]; d = {}
        for sp in SPLITS:
            s = [r for r in sub if r['split'] == sp]
            if not s: continue
            n640, nnat = Counter(), Counter(); boxes = 0
            for r in s:
                for x in r['annotations']:
                    boxes += 1; n640[bin_of(size640(x['xyxy'], r['width'], r['height']))] += 1; nnat[bin_of(side(x['xyxy']))] += 1
            small = [r for r in s if any(size640(x['xyxy'], r['width'], r['height']) < 16 for x in r['annotations'])]
            d[sp] = {'images': len(s), 'images_with_drone': sum(1 for r in s if r['annotations']), 'drone_free_images': sum(1 for r in s if not r['annotations'] and not r['label_absent']),
                     'label_absent': sum(1 for r in s if r['label_absent']), 'drone_boxes': boxes,
                     'boxes_by_size_640': {k: n640[k] for k in BINS}, 'boxes_by_size_native': {k: nnat[k] for k in BINS},
                     'groups': len({r['group'] for r in s}), 'scenes': len({r['scene'] for r in s}),
                     'scenes_with_small_lt16_at640': len({r['scene'] for r in small}),
                     'resolutions': dict(Counter(f'{r["width"]}x{r["height"]}' for r in s).most_common(6)),
                     'negative_classes': dict(Counter(o['class'] for r in s if not r['annotations'] for o in r['other_objects']))}
        out['by_dataset'][ds] = d
    H = {sp: np.array([int(r['dhash64'], 16) for r in recs if r['split'] == sp], np.uint64) for sp in SPLITS}
    for other in ('validation', 'eval_only'):
        for t in (0, 2, 4):
            n, k = hamming_pairs(H['train'], H[other], t)
            out['cross_split_dhash'][f'train_vs_{other}@<={t}'] = {'pairs': n, 'train_images_with_match': k}
    per = {}
    tr = [r for r in recs if r['split'] == 'train']
    for ds in sorted({r['dataset'] for r in recs if r['split'] != 'train'}):
        E = np.array([int(r['dhash64'], 16) for r in recs if r['split'] != 'train' and r['dataset'] == ds], np.uint64)
        per[ds] = {}
        for tds in sorted({r['dataset'] for r in tr}):
            T = np.array([int(r['dhash64'], 16) for r in tr if r['dataset'] == tds], np.uint64)
            per[ds][tds] = hamming_pairs(T, E, 2)[0]
    out['cross_split_dhash']['eval_dataset_vs_train_dataset_pairs@<=2'] = per
    tr = [r for r in recs if r['split'] == 'train']; ev = [r for r in recs if r['split'] != 'train']
    n_cand, dup = near_duplicates(tr, ev)
    split = {r['id']: r['split'] for r in ev}
    agg = Counter((x.split(':')[0], y.split(':')[0], split[y]) for x, y, _ in dup)
    if a.pairs_output: a.pairs_output.write_text(json.dumps(dup) + '\n')
    sh = defaultdict(set)
    for r in recs: sh[sha_file(r['file'])].add(r['split'])
    out['exact_byte_duplicates_across_splits'] = sum(1 for v in sh.values() if len(v) > 1)
    out['images_total'] = len(recs); out['unique_file_sha256'] = len(sh)
    out['near_duplicates_train_vs_heldout'] = {'rule': 'dHash Hamming <= 6, then normalised 32x32 thumbnail MAD <= 0.12', 'candidates': n_cand,
        'similar_pairs': len(dup),
        'interpretation': 'similarity candidates, not proven copies: low-texture sky frames and same static camera/site backgrounds pass both filters; see visual_review_agent.json', 'by_train_dataset_to_heldout': {f'{k[0]}->{k[1]}/{k[2]}': v for k, v in sorted(agg.items())},
        'heldout_images_affected_by_set': dict(Counter(f"{y.split(':')[0]}/{split[y]}" for y in {y for _, y, _ in dup})),
        'heldout_images_affected': len({y for _, y, _ in dup}), 'train_images_affected': len({x for x, _, _ in dup}), 'cross_dataset_pairs': [p for p in dup if p[0].split(':')[0] != p[1].split(':')[0]]}
    out['manifest_sha256'] = sha_file(a.manifest)
    a.output.write_text(json.dumps(out, indent=1) + '\n'); print(json.dumps(out, indent=1)[:6000])


# ---------------------------------------------------------------- predict / evaluate
def cmd_predict(a):
    from ultralytics import YOLO
    import torch, ultralytics; torch.set_num_threads(2)
    recs = [r for r in load(a.manifest, a.splits) if not a.datasets or r['dataset'] in a.datasets]
    done = {}
    if a.output.exists():
        done = {e['id']: e for e in json.loads(a.output.read_text())['records']}
    model = YOLO(str(a.weights)); out = [done[r['id']] for r in recs if r['id'] in done]; todo = [r for r in recs if r['id'] not in done]
    cfg = {'model_id': a.model_id, 'model_sha256': sha_file(a.weights), 'imgsz': a.imgsz, 'min_conf': a.min_conf, 'nms_iou': 0.45,
           'ultralytics': ultralytics.__version__, 'torch': torch.__version__, 'splits': a.splits, 'datasets': a.datasets, 'platform': platform.machine()}
    for i, r in enumerate(todo):
        res = model.predict(r['file'], imgsz=a.imgsz, conf=a.min_conf, iou=0.45, device='cpu', verbose=False, max_det=100)[0]
        out.append({'id': r['id'], 'predictions': [[round(v, 1) for v in b] + [round(s, 4)] for b, s in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist())]})
        if (i + 1) % 500 == 0 or i + 1 == len(todo):
            a.output.write_text(json.dumps({'config': cfg, 'records': out}, separators=(',', ':')) + '\n'); print(i + 1, len(todo), flush=True)
    a.output.write_text(json.dumps({'config': cfg, 'records': out}, separators=(',', ':')) + '\n')


def near(p, g):
    """Response: prediction centre inside the GT box expanded to 3x its size (min 4 px half-size)."""
    cx, cy = (p[0] + p[2]) / 2, (p[1] + p[3]) / 2; w, h = g[2] - g[0], g[3] - g[1]
    return abs(cx - (g[0] + g[2]) / 2) <= 1.5 * max(w, 4) and abs(cy - (g[1] + g[3]) / 2) <= 1.5 * max(h, 4)


def frame_eval(r, preds, conf):
    p = [x for x in preds if x[4] > conf]; P = np.array([x[:4] for x in p], float).reshape(-1, 4); S = np.array([x[4] for x in p], float)
    gt = [x['xyxy'] for x in r['annotations']]; G = np.array(gt, float).reshape(-1, 4)
    t5, h5, _ = match(P, S, G, 0.5); t3, h3, _ = match(P, S, G, 0.3)
    gts = [{'bin': bin_of(size640(g, r['width'], r['height'])), 'h5': bool(h5[j]), 'h3': bool(h3[j]), 'resp': any(near(x, g) for x in p)} for j, g in enumerate(gt)]
    fp = Counter()
    for x, t in zip(p, t3):
        if t: continue
        hit = [o['class'] for o in r['other_objects'] if near(x, o['xyxy']) or iou_matrix(np.array([x[:4]]), np.array([o['xyxy']]))[0, 0] > 0.1]
        fp[hit[0] if hit else 'drone_localisation' if any(near(x, g) for g in gt) else 'background'] += 1
    return gts, len(p), fp, int((~t3).sum()) if len(p) else 0


def unit_table(recs, preds, conf):
    """Per scene: [n_gt, tp05, tp03, resp, neg_frames, neg_frames_with_fp, n_small, tp03_small, resp_small]."""
    by = {e['id']: e['predictions'] for e in preds}; U = defaultdict(lambda: np.zeros(9))
    for r in recs:
        if r['label_absent']: continue
        gts, n, _, _ = frame_eval(r, by[r['id']], conf); u = U[r['scene']]
        for g in gts:
            u[0] += 1; u[1] += g['h5']; u[2] += g['h3']; u[3] += g['resp']
            if g['bin'] in ('<8', '8-<16'): u[6] += 1; u[7] += g['h3']; u[8] += g['resp']
        if not r['annotations']: u[4] += 1; u[5] += int(n > 0)
    return U


def summarize(recs, preds, conf, n_boot=2000):
    by = {e['id']: e['predictions'] for e in preds}; bins = {k: Counter() for k in BINS}; neg = defaultdict(Counter); dfp = Counter(); pos = Counter()
    for r in recs:
        if r['label_absent']: continue
        gts, n, fp, unmatched = frame_eval(r, by[r['id']], conf)
        for g in gts: bins[g['bin']].update(n=1, tp05=int(g['h5']), tp03=int(g['h3']), resp=int(g['resp']))
        if r['annotations']:
            pos.update(frames=1, preds=n, unmatched_iou0_3=unmatched); dfp.update(fp)
        else:
            k = '+'.join(sorted({o['class'] for o in r['other_objects']})) or 'empty'; neg[k].update(frames=1, frames_with_fp=int(n > 0), fp=n)
    rs = {}
    for k, v in bins.items():
        n = v['n']; rs[k] = {'n': n, 'recall_iou0.5': v['tp05'] / n if n else None, 'recall_iou0.3': v['tp03'] / n if n else None, 'response': v['resp'] / n if n else None}
    tot = sum((bins[k] for k in BINS), Counter()); n = tot['n']
    out = {'conf': conf, 'images': len(recs), 'recall_by_size_640': rs,
           'overall': {'gt': n, 'recall_iou0.5': tot['tp05'] / n if n else None, 'recall_iou0.3': tot['tp03'] / n if n else None, 'response': tot['resp'] / n if n else None,
                       'precision_iou0.3_drone_frames': 1 - pos['unmatched_iou0_3'] / pos['preds'] if pos['preds'] else None},
           'drone_frames_unmatched_by_target': dict(dfp), 'negatives': {k: dict(v) for k, v in neg.items()}}
    nf = sum(v['frames'] for v in neg.values())
    if nf: out['negatives_total'] = {'frames': nf, 'frames_with_fp_share': sum(v['frames_with_fp'] for v in neg.values()) / nf, 'fp_per_frame': sum(v['fp'] for v in neg.values()) / nf}
    U = unit_table(recs, preds, conf); A = np.array(list(U.values())); out['scenes'] = len(U)
    if len(A) and A[:, 0].sum():
        rng = np.random.default_rng(65); R = []
        for _ in range(n_boot):
            s = A[rng.integers(0, len(A), len(A))].sum(0); R.append([s[2] / s[0] if s[0] else np.nan, s[3] / s[0] if s[0] else np.nan])
        R = np.array(R)
        out['scene_bootstrap_ci95'] = {'recall_iou0.3': [round(float(np.nanpercentile(R[:, 0], q)), 4) for q in (2.5, 97.5)],
                                       'response': [round(float(np.nanpercentile(R[:, 1], q)), 4) for q in (2.5, 97.5)]}
    return out


def cmd_evaluate(a):
    recs = load(a.manifest, a.splits); data = json.loads(a.predictions.read_text()); have = {e['id'] for e in data['records']}
    res = {'config': data['config'], 'predictions_sha256': sha_file(a.predictions), 'manifest_sha256': sha_file(a.manifest), 'by_set': {}}
    for key in sorted({(r['dataset'], r['split']) for r in recs}):
        sub = [r for r in recs if (r['dataset'], r['split']) == key]
        if not {r['id'] for r in sub} <= have: continue
        res['by_set'][f'{key[0]}/{key[1]}'] = {str(c): summarize(sub, data['records'], c) for c in a.conf}
    a.output.write_text(json.dumps(res, indent=1) + '\n')
    for k, v in res['by_set'].items():
        x = v[str(a.conf[0])]; print(k, json.dumps(x['overall']), {b: (y['n'], y['recall_iou0.3'] and round(y['recall_iou0.3'], 3)) for b, y in x['recall_by_size_640'].items()}, json.dumps(x.get('negatives_total')))


# ---------------------------------------------------------------- train / compare
def yolo_label(r):
    w, h = r['width'], r['height']
    return ''.join(f"0 {(b[0] + b[2]) / 2 / w:.6f} {(b[1] + b[3]) / 2 / h:.6f} {(b[2] - b[0]) / w:.6f} {(b[3] - b[1]) / h:.6f}\n" for b in (x['xyxy'] for x in r['annotations']))


def train_selection(recs, quota, seed=SEED):
    """Deterministic per-dataset quota, spread over scenes (round-robin over hash-ordered scenes)."""
    out = []
    for ds, n in quota.items():
        sub = [r for r in recs if r['dataset'] == ds and r['split'] == 'train' and not r['label_absent']]
        by = defaultdict(list)
        for r in sorted(sub, key=lambda r: rank(r['id'], seed)): by[r['scene']].append(r)
        scenes = sorted(by, key=lambda s: rank(s, seed)); pick = []
        while len(pick) < min(n, len(sub)):
            for s in scenes:
                if by[s] and len(pick) < n: pick.append(by[s].pop(0))
        out += pick
    return out


def cmd_train(a):
    cfg = json.loads(a.config.read_text())
    if sha_file(a.weights) != cfg['checkpoint_sha256']: raise ValueError('checkpoint SHA mismatch')
    recs = train_selection(load(a.manifest, ['train']), cfg['quota'])
    d = a.workdir / 'data'
    if d.exists(): raise ValueError('workdir/data must not exist')
    (d / 'images').mkdir(parents=True); (d / 'labels').mkdir(parents=True)
    for r in recs:
        stem = r['id'].replace(':', '_').replace('/', '_'); src = Path(r['file']).resolve()
        (d / 'images' / (stem + src.suffix)).symlink_to(src); (d / 'labels' / (stem + '.txt')).write_text(yolo_label(r))
    (d / 'data.yaml').write_text(json.dumps({'path': str(d.resolve()), 'train': 'images', 'val': 'images', 'names': {0: 'drone'}}) + '\n')
    (a.workdir / 'train_ids.json').write_text(json.dumps(sorted(r['id'] for r in recs)) + '\n')
    print('train images', len(recs), Counter((r['dataset'], bool(r['annotations'])) for r in recs))
    if a.dry_run: return
    from ultralytics import YOLO
    import torch; torch.set_num_threads(2)
    YOLO(str(a.weights)).train(data=str(d / 'data.yaml'), project=str(a.workdir.resolve()), name='run', exist_ok=False, device='cpu', val=False, plots=False, **cfg['train'])


def cmd_compare(a):
    recs = load(a.manifest, a.splits); B = json.loads(a.baseline.read_text())['records']; C = json.loads(a.candidate.read_text())['records']; out = {}
    for key in sorted({(r['dataset'], r['split']) for r in recs}):
        sub = [r for r in recs if (r['dataset'], r['split']) == key]
        for c in a.conf:
            ub, uc = unit_table(sub, B, c), unit_table(sub, C, c); keys = sorted(ub); A = np.array([np.r_[ub[k], uc[k]] for k in keys]); t = A.sum(0)
            rng = np.random.default_rng(65); D = []
            for _ in range(2000):
                s = A[rng.integers(0, len(A), len(A))].sum(0)
                with np.errstate(invalid='ignore', divide='ignore'):
                    D.append([s[11] / s[9] - s[2] / s[0], s[12] / s[9] - s[3] / s[0], s[14] / s[13] - s[5] / s[4], s[16] / s[15] - s[7] / s[6]])
            D = np.array(D); ci = lambda i: [round(float(np.nanpercentile(D[:, i], q)), 4) for q in (2.5, 97.5)] if np.isfinite(D[:, i]).any() else None
            f = lambda x, y: round(float(x / y), 4) if y else None
            out[f'{key[0]}/{key[1]}@{c}'] = {'scenes': len(keys), 'gt': int(t[0]), 'neg_frames': int(t[4]), 'small_lt16_gt': int(t[6]),
                'recall_iou0.3': [f(t[2], t[0]), f(t[11], t[9])], 'delta_recall_ci95': ci(0),
                'response': [f(t[3], t[0]), f(t[12], t[9])], 'delta_response_ci95': ci(1),
                'neg_fp_frame_share': [f(t[5], t[4]), f(t[14], t[13])], 'delta_neg_fp_ci95': ci(2),
                'small_lt16_recall_iou0.3': [f(t[7], t[6]), f(t[16], t[15])], 'delta_small_recall_ci95': ci(3)}
    a.output.write_text(json.dumps({'note': 'values are [baseline, candidate]; CI = paired scene bootstrap of candidate-baseline', 'results': out}, indent=1) + '\n')
    for k, v in out.items(): print(k, json.dumps(v))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__); s = p.add_subparsers(dest='cmd', required=True)
    q = s.add_parser('build'); q.add_argument('--output', type=Path, required=True); q.add_argument('--workdir', type=Path, default=Path('/data/d65'))
    q.add_argument('--uavdb-sel', type=Path, default=Path('/data/d65/uavdb')); q.add_argument('--uavdb-labels', type=Path, default=Path('/data/db65/datasets'))
    q.add_argument('--antiuav-meta', type=Path, default=Path('/data/d65/antiuav_meta.json')); q.add_argument('--uavcb', type=Path, default=Path('/data/cb65'))
    q.add_argument('--vdd', type=Path, default=Path('/data/vdd65')); q.add_argument('--halmstad-manifest', type=Path, default=Path('/data/hneg65/manifest.json'))
    q.add_argument('--split64', type=Path, default=Path('ml/results/real64/split_summary.json'))
    q.add_argument('--dut', type=Path, default=Path('/data/src65/dut_val2.parquet')); q.add_argument('--pathikg', type=Path, default=Path('/data/src65/pathikg_train0.parquet'))
    q = s.add_parser('stats'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--output', type=Path, required=True)
    q.add_argument('--pairs-output', type=Path)
    for name in ('predict', 'evaluate', 'compare'):
        q = s.add_parser(name); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--output', type=Path, required=True)
        q.add_argument('--splits', nargs='+', default=['validation', 'eval_only'])
    q = s.choices['predict']; q.add_argument('--weights', type=Path, required=True); q.add_argument('--model-id', required=True)
    q.add_argument('--imgsz', type=int, default=640); q.add_argument('--min-conf', type=float, default=0.1); q.add_argument('--datasets', nargs='*', default=[])
    s.choices['evaluate'].add_argument('--predictions', type=Path, required=True); s.choices['evaluate'].add_argument('--conf', type=float, nargs='+', default=[0.25, 0.5])
    q = s.choices['compare']; q.add_argument('--baseline', type=Path, required=True); q.add_argument('--candidate', type=Path, required=True); q.add_argument('--conf', type=float, nargs='+', default=[0.25])
    q = s.add_parser('train'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--weights', type=Path, required=True)
    q.add_argument('--config', type=Path, default=Path('ml/results/data65/finetune_config.json')); q.add_argument('--workdir', type=Path, required=True); q.add_argument('--dry-run', action='store_true')
    a = p.parse_args(argv); {'build': cmd_build, 'stats': cmd_stats, 'predict': cmd_predict, 'evaluate': cmd_evaluate, 'train': cmd_train, 'compare': cmd_compare}[a.cmd](a)


if __name__ == '__main__':
    main()

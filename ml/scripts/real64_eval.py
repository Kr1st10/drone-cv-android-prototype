#!/usr/bin/env python3
"""Stage 6.4 split, inference and evaluation on real Halmstad / Flying Object frames.

split    group frames into independent units (video, plus dataset45 near-duplicate
         edges across videos) and assign 70/15/15 by hash; the test part is written
         as a sealed ID list and is never evaluated here.
predict  Ultralytics checkpoint over selected (non-test) frames.
evaluate drone recall by size at IoU 0.5 and 0.3, response vs localisation,
         FP on birds/airplanes/helicopters/background, group bootstrap.
"""
from __future__ import annotations
import argparse, hashlib, json, math, platform
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from ml.dataset45.core import load_manifest
from ml.dataset45.duplicates import duplicate_pairs
from ml.dataset45.splits import UnionFind
from ml.scripts.evaluate import iou_matrix, match

BINS = ('<16', '16-<24', '24-<30', '>=30')


def sha_file(p):
    with Path(p).open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def size_bin(b):
    s = math.sqrt((b[2] - b[0]) * (b[3] - b[1]))
    return '<16' if s < 16 else '16-<24' if s < 24 else '24-<30' if s < 30 else '>=30'


def letterbox_scale(w, h, imgsz=640):
    return min(imgsz / w, imgsz / h)


def groups_for(records):
    """Union frames of the same sequence and near-duplicate frames across sequences."""
    uf = UnionFind([r['id'] for r in records]); first = {}
    for r in records:
        k = r['sequence_id']
        if k in first: uf.union(r['id'], first[k])
        else: first[k] = r['id']
    pairs = duplicate_pairs(records)
    for p in pairs: uf.union(p['a'], p['b'])
    return {r['id']: uf.find(r['id']) for r in records}, pairs


def group_rank(group_key, seed='stage64-v1'):
    return hashlib.sha256((seed + ':' + group_key).encode()).hexdigest()


def assign(group_key, seed='stage64-v1'):
    n = int(group_rank(group_key, seed)[:16], 16) / (1 << 64)
    return 'train' if n < .7 else 'validation' if n < .85 else 'test'


def balanced_assign(groups, seed='stage64-v1', test_share=.15, val_share=.15, max_unit_share=.25):
    """Assign whole groups to splits by hash order, filling test then validation by drone-box share.

    groups: {key: n_drone_boxes}. Groups holding more than max_unit_share of all drone boxes
    (one shared recording site) are never test/validation units: they would turn the
    held-out set into a single site. Groups are visited in sha256(seed:key) order, so the
    rule is deterministic and does not look at model results.
    """
    total = sum(groups.values()) or 1; out = {}; filled = {'test': 0, 'validation': 0}
    for k in sorted(groups, key=lambda k: group_rank(k, seed)):
        n = groups[k]
        if n / total > max_unit_share: out[k] = 'train'; continue
        for split, share in (('test', test_share), ('validation', val_share)):
            if filled[split] / total < share and (n == 0 or (filled[split] + n) / total <= share + .05):
                out[k] = split; filled[split] += n; break
        else:
            out[k] = 'train'
    # groups without drones: classic hash assignment keeps negatives in all splits
    for k, n in groups.items():
        if n == 0: out[k] = assign(k, seed)
    return out


def cmd_split(a):
    recs = load_manifest(a.manifest)['records']; out = {}; info = {}
    for ds in ('halmstad', 'flying'):
        sub = [r for r in recs if r['dataset'] == ds]
        own = [r for r in sub if ds == 'halmstad' and not r['internet_sourced']]
        g, pairs = groups_for(own) if own else ({}, [])
        names = {}; drones = Counter()
        for r in own:
            names.setdefault(g[r['id']], set()).add(r['sequence_id'])
        key = {gid: min(s) for gid, s in names.items()}
        for r in own:
            drones[key[g[r['id']]]] += sum(1 for x in r['annotations'] if x['class'] == 'drone')
        for k in key.values(): drones.setdefault(k, 0)
        plan = balanced_assign(dict(drones)) if own else {}
        seq = {r['id']: r['sequence_id'] for r in own}
        for r in sub:
            # Flying Object: one fixed camera, one day -> one scene; internet-sourced: third-party rights.
            out[r['id']] = plan[key[g[r['id']]]] if r['id'] in seq else 'eval_only'
        cross = sum(1 for p in pairs if seq[p['a']] != seq[p['b']])
        sizes = sorted((len(s) for s in names.values()), reverse=True)
        info[ds] = {'frames': len(sub), 'sequences': len({r['sequence_id'] for r in sub}), 'grouped_frames': len(own),
                    'groups': len(names), 'largest_groups_videos': sizes[:5], 'dup_pairs': len(pairs), 'cross_sequence_pairs': cross,
                    'group_splits': {k: plan[k] for k in sorted(plan)}, 'group_drone_boxes': dict(sorted(drones.items())),
                    'group_sequences': {key[gid]: sorted(s) for gid, s in names.items()}}
        print(ds, {k: v for k, v in info[ds].items() if not k.startswith('group_')})
    lock = {'seed': 'stage64-v1',
            'rule': 'own Halmstad videos: union same video + dataset45 near-duplicate pairs; whole groups visited in sha256(seed:min video id) order, test then validation filled to ~15% of drone boxes each; a group with >25% of drone boxes stays in train; drone-free groups by hash 70/15/15. Internet-sourced videos and Flying Object -> eval_only. Test is sealed.',
            'manifest_sha256': sha_file(a.manifest), 'groups': info, 'assignments': out}
    a.output.write_text(json.dumps(lock, indent=0) + '\n')
    print(Counter(out.values()))


def selected(manifest, split_file, splits):
    if 'test' in splits: raise ValueError('test is sealed for the future final evaluation')
    recs = load_manifest(manifest)['records']; s = json.loads(Path(split_file).read_text())['assignments']
    return [r for r in recs if s[r['id']] in splits], s


def cmd_predict(a):
    from ultralytics import YOLO
    import torch, ultralytics; torch.set_num_threads(2)
    recs, _ = selected(a.manifest, a.split, a.splits); model = YOLO(str(a.weights)); root = a.manifest.parent; out = []
    for r in recs:
        res = model.predict(str(root / r['file']), imgsz=a.imgsz, conf=a.min_conf, iou=0.45, device='cpu', verbose=False, max_det=100)[0]
        out.append({'id': r['id'], 'predictions': [[round(v, 1) for v in b] + [round(s, 4)] for b, s in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist())]})
    cfg = {'model_id': a.model_id, 'model_sha256': sha_file(a.weights), 'imgsz': a.imgsz, 'min_conf': a.min_conf, 'nms_iou': 0.45,
           'ultralytics': ultralytics.__version__, 'torch': torch.__version__, 'splits': a.splits, 'manifest_sha256': sha_file(a.manifest),
           'split_sha256': sha_file(a.split), 'platform': platform.machine()}
    a.output.write_text(json.dumps({'config': cfg, 'records': out}, separators=(',', ':')) + '\n')


def near(p, g):
    """Response test: prediction centre inside the GT box expanded to 3x its size (or IoU > 0)."""
    cx, cy = (p[0] + p[2]) / 2, (p[1] + p[3]) / 2; w, h = g[2] - g[0], g[3] - g[1]
    return abs(cx - (g[0] + g[2]) / 2) <= 1.5 * max(w, 4) and abs(cy - (g[1] + g[3]) / 2) <= 1.5 * max(h, 4)


def frame_stats(r, preds, conf):
    p = [x for x in preds if x[4] > conf]; P = np.array([x[:4] for x in p], float).reshape(-1, 4); S = np.array([x[4] for x in p], float)
    gt = [x['xyxy'] for x in r['annotations'] if x['class'] == 'drone']; G = np.array(gt, float).reshape(-1, 4)
    res = {'gt': [{'bin': size_bin(g)} for g in gt]}
    for thr in (0.5, 0.3):
        tp, hit, _ = match(P, S, G, thr); res[f'tp{thr}'] = tp; res[f'hit{thr}'] = hit
    iou = iou_matrix(P, G) if len(P) and len(G) else np.zeros((len(P), len(G)))
    for j, g in enumerate(res['gt']):
        g['best_iou'] = float(iou[:, j].max()) if len(P) else 0.0
        g['response'] = bool(any(near(x, gt[j]) for x in p))
        g['centre_in_gt'] = bool(any(gt[j][0] <= (x[0] + x[2]) / 2 <= gt[j][2] and gt[j][1] <= (x[1] + x[3]) / 2 <= gt[j][3] for x in p))
    unmatched = [x for x, t in zip(p, res['tp0.3']) if not t]
    others = [o for o in r['annotations'] if o['class'] != 'drone'] + r.get('other_objects', [])
    fp_cls = Counter()
    for x in unmatched:
        hitc = [o['class'] for o in others if near(x, o['xyxy']) or iou_matrix(np.array([x[:4]]), np.array([o['xyxy']]))[0, 0] > 0.1]
        fp_cls[hitc[0] if hitc else ('drone_localisation' if any(near(x, g) for g in gt) else 'background')] += 1
    res['fp_by_target'] = fp_cls; res['n_pred'] = len(p)
    return res


def summarize(recs, preds, conf, groups):
    by = {e['id']: e['predictions'] for e in preds}; T = defaultdict(Counter); bins = {k: Counter() for k in BINS}
    neg = defaultdict(Counter); ious = []; per_group = defaultdict(Counter); objects = Counter(); obj_groups = defaultdict(set)
    for r in recs:
        if r.get('label_absent'): continue
        f = frame_stats(r, by[r['id']], conf); gid = groups[r['id']]
        has_drone = bool(f['gt'])
        for g, h5, h3 in zip(f['gt'], f['hit0.5'], f['hit0.3']):
            b = bins[g['bin']]; b.update(n=1, tp05=int(h5), tp03=int(h3), response=int(g['response']), centre=int(g['centre_in_gt']))
            if h3: ious.append(g['best_iou'])
            per_group[gid].update(n=1, tp05=int(h5), tp03=int(h3))
        if has_drone:
            T['drone_frames'].update(frames=1, tp05=int(f['tp0.5'].sum()), fp05=int((~f['tp0.5']).sum()), tp03=int(f['tp0.3'].sum()), fp03=int((~f['tp0.3']).sum()))
            per_group[gid].update(fp05=int((~f['tp0.5']).sum()), fp03=int((~f['tp0.3']).sum()))
            for c, v in f['fp_by_target'].items(): T['drone_frames_fp_iou0.3_by_target'][c] += v
        else:
            kinds = sorted({o['class'] for o in r['annotations'] + r.get('other_objects', [])}) or ['empty']
            k = '+'.join(kinds); neg[k].update(frames=1, frames_with_fp=int(f['n_pred'] > 0), fp=f['n_pred'])
            for c, v in f['fp_by_target'].items(): neg[k]['fp_on_' + c] += v
            for o in r['annotations'] + r.get('other_objects', []):
                objects[o['class']] += 1; obj_groups[o['class']].add(gid)
            neg[k]['objects'] += len(r['annotations'] + r.get('other_objects', []))
            per_group[gid].update(neg_frames=1, neg_fp=f['n_pred'])
    out = {'conf': conf, 'drone_frames': dict(T['drone_frames']), 'drone_frames_fp_iou0.3_by_target': dict(T['drone_frames_fp_iou0.3_by_target']), 'recall_by_size': {}, 'negatives': {k: dict(v) for k, v in neg.items()}}
    for k, v in bins.items():
        n = v['n']; out['recall_by_size'][k] = {'n': n, 'tp_iou0.5': v['tp05'], 'tp_iou0.3': v['tp03'], 'response': v['response'], 'centre_in_gt': v['centre'],
            'recall_iou0.5': v['tp05'] / n if n else None, 'recall_iou0.3': v['tp03'] / n if n else None, 'response_rate': v['response'] / n if n else None, 'centre_in_gt_rate': v['centre'] / n if n else None}
    n = sum(v['n'] for v in bins.values()); t5 = sum(v['tp05'] for v in bins.values()); t3 = sum(v['tp03'] for v in bins.values()); d = T['drone_frames']
    out['overall'] = {'gt': n, 'recall_iou0.5': t5 / n if n else None, 'recall_iou0.3': t3 / n if n else None,
                      'precision_iou0.5_drone_frames': d['tp05'] / (d['tp05'] + d['fp05']) if d['tp05'] + d['fp05'] else None,
                      'precision_iou0.3_drone_frames': d['tp03'] / (d['tp03'] + d['fp03']) if d['tp03'] + d['fp03'] else None}
    out['localisation'] = {'matched_iou0.3': len(ious), 'median_best_iou': float(np.median(ious)) if ious else None,
                           'share_iou_below_0.5_among_iou0.3_matches': float(np.mean(np.array(ious) < 0.5)) if ious else None}
    gs = [v for v in per_group.values() if v['n']]
    out['groups'] = {'drone_groups': len(gs), 'negative_groups': sum(1 for v in per_group.values() if v['neg_frames']),
                     'negative_groups_with_any_fp': sum(1 for v in per_group.values() if v['neg_frames'] and v['neg_fp']),
                     'non_drone_objects': dict(objects), 'non_drone_object_groups': {k: len(v) for k, v in obj_groups.items()}}
    if gs:
        A = np.array([[v['n'], v['tp05'], v['tp03']] for v in gs], float); rng = np.random.default_rng(64); R5, R3 = [], []
        for _ in range(2000):
            s = A[rng.integers(0, len(A), len(A))].sum(0); R5.append(s[1] / s[0]); R3.append(s[2] / s[0])
        out['groups']['recall_ci95_iou0.5'] = [round(float(np.percentile(R5, q)), 4) for q in (2.5, 97.5)]
        out['groups']['recall_ci95_iou0.3'] = [round(float(np.percentile(R3, q)), 4) for q in (2.5, 97.5)]
        out['groups']['median_group_recall_iou0.3'] = float(np.median([v['tp03'] / v['n'] for v in gs]))
    return out


def cmd_evaluate(a):
    recs, s = selected(a.manifest, a.split, a.splits); data = json.loads(a.predictions.read_text())
    ids = {r['id'] for r in recs}
    if not ids <= {e['id'] for e in data['records']}: raise ValueError('predictions do not cover the selected frames')
    data['records'] = [e for e in data['records'] if e['id'] in ids]
    lock = json.loads(Path(a.split).read_text()); seq2g = {}
    for gk, seqs in lock.get('groups', {}).get('halmstad', {}).get('group_sequences', {}).items():
        for q in seqs: seq2g[q] = gk
    # bootstrap units = split groups (site-aware); ungrouped (internet-sourced, Flying Object) = their own video/sequence
    g = {r['id']: seq2g.get(r['sequence_id'], r['sequence_id']) for r in recs}
    result = {'config': data['config'], 'splits': a.splits, 'predictions_sha256': sha_file(a.predictions), 'by_dataset': {}}
    for ds in ('halmstad', 'flying'):
        sub = [r for r in recs if r['dataset'] == ds]
        if sub: result['by_dataset'][ds] = {str(c): summarize(sub, data['records'], c, g) for c in a.conf}
    a.output.write_text(json.dumps(result, indent=1, ensure_ascii=False) + '\n')
    for ds, v in result['by_dataset'].items():
        for c, x in v.items(): print(ds, c, json.dumps({k: x[k] for k in ('overall', 'recall_by_size', 'localisation', 'groups')})[:1500]); print(' neg', json.dumps(x['negatives']))


def yolo_label(r):
    w, h = r['width'], r['height']; lines = []
    for x in r['annotations']:
        if x['class'] != 'drone': continue
        b = x['xyxy']; lines.append(f"0 {(b[0] + b[2]) / 2 / w:.6f} {(b[1] + b[3]) / 2 / h:.6f} {(b[2] - b[0]) / w:.6f} {(b[3] - b[1]) / h:.6f}")
    return '\n'.join(lines) + ('\n' if lines else '')


def cmd_train(a):
    """Limited fine-tune on own-recorded Halmstad *train* groups only (drones + bird/airplane/helicopter as background).

    Fixed epochs, final last.pt; validation/eval_only are never used for training or checkpoint selection.
    """
    config = json.loads(a.config.read_text())
    if sha_file(a.weights) != config['checkpoint_sha256']: raise ValueError('checkpoint SHA mismatch')
    recs, s = selected(a.manifest, a.split, ['train'])
    recs = [r for r in recs if r['dataset'] == 'halmstad' and not r['internet_sourced'] and not r.get('label_absent')]
    d = a.workdir / 'data'
    if d.exists(): raise ValueError('workdir/data must not exist')
    (d / 'images' / 'train').mkdir(parents=True); (d / 'labels' / 'train').mkdir(parents=True); root = a.manifest.parent
    for r in recs:
        (d / 'images' / 'train' / (r['id'] + '.png')).symlink_to((root / r['file']).resolve())
        (d / 'labels' / 'train' / (r['id'] + '.txt')).write_text(yolo_label(r))
    (d / 'data.yaml').write_text(json.dumps({'path': str(d.resolve()), 'train': 'images/train', 'val': 'images/train', 'names': {0: 'drone'}}) + '\n')
    (a.workdir / 'train_ids.json').write_text(json.dumps(sorted(r['id'] for r in recs)) + '\n')
    print('train frames', len(recs), 'with drones', sum(1 for r in recs if yolo_label(r)))
    from ultralytics import YOLO
    import torch; torch.set_num_threads(2)
    YOLO(str(a.weights)).train(data=str(d / 'data.yaml'), project=str(a.workdir.resolve()), name='run', exist_ok=False, device='cpu', val=False, plots=False, **config['train'])


def group_neg_fp(recs, preds, conf, groups):
    by = {e['id']: e['predictions'] for e in preds}; G = defaultdict(lambda: [0, 0, 0])
    for r in recs:
        if r.get('label_absent') or any(x['class'] == 'drone' for x in r['annotations']): continue
        n = sum(1 for x in by[r['id']] if x[4] > conf); g = G[groups[r['id']]]; g[0] += 1; g[1] += int(n > 0); g[2] += n
    return G


def cmd_compare(a):
    """Paired group bootstrap baseline vs candidate on the same frames: share of drone-free frames with any FP."""
    recs, _ = selected(a.manifest, a.split, a.splits); lock = json.loads(Path(a.split).read_text()); seq2g = {}
    for gk, seqs in lock.get('groups', {}).get('halmstad', {}).get('group_sequences', {}).items():
        for q in seqs: seq2g[q] = gk
    groups = {r['id']: seq2g.get(r['sequence_id'], r['sequence_id']) for r in recs}
    B = json.loads(a.baseline.read_text())['records']; C = json.loads(a.candidate.read_text())['records']; out = {'splits': a.splits}
    for ds in ('halmstad', 'flying'):
        sub = [r for r in recs if r['dataset'] == ds]
        for c in a.conf:
            gb, gc = group_neg_fp(sub, B, c, groups), group_neg_fp(sub, C, c, groups); keys = sorted(gb)
            if not keys: continue
            A = np.array([[gb[k][0], gb[k][1], gc[k][1]] for k in keys], float); rng = np.random.default_rng(64); D = []
            for _ in range(2000):
                t = A[rng.integers(0, len(A), len(A))].sum(0); D.append((t[2] - t[1]) / t[0])
            t = A.sum(0)
            out[f'{ds}@{c}'] = {'negative_frames': int(t[0]), 'groups': len(keys), 'baseline_fp_frame_share': t[1] / t[0], 'candidate_fp_frame_share': t[2] / t[0],
                                 'delta': (t[2] - t[1]) / t[0], 'delta_ci95_group_bootstrap': [float(np.percentile(D, 2.5)), float(np.percentile(D, 97.5))]}
    a.output.write_text(json.dumps(out, indent=1) + '\n'); print(json.dumps(out, indent=1))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__); s = p.add_subparsers(dest='cmd', required=True)
    q = s.add_parser('split'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--output', type=Path, required=True)
    for name in ('predict', 'evaluate'):
        q = s.add_parser(name); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--split', type=Path, required=True)
        q.add_argument('--splits', nargs='+', default=['train', 'validation', 'eval_only']); q.add_argument('--output', type=Path, required=True)
        if name == 'predict':
            q.add_argument('--weights', type=Path, required=True); q.add_argument('--model-id', required=True)
            q.add_argument('--imgsz', type=int, default=640); q.add_argument('--min-conf', type=float, default=0.1)
        else:
            q.add_argument('--predictions', type=Path, required=True); q.add_argument('--conf', type=float, nargs='+', default=[0.25, 0.5])
    q = s.add_parser('train'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--split', type=Path, required=True)
    q.add_argument('--weights', type=Path, required=True); q.add_argument('--config', type=Path, default=Path('ml/results/real64/finetune_config.json'))
    q.add_argument('--workdir', type=Path, required=True)
    q = s.add_parser('compare'); q.add_argument('--manifest', type=Path, required=True); q.add_argument('--split', type=Path, required=True)
    q.add_argument('--splits', nargs='+', default=['validation', 'eval_only']); q.add_argument('--baseline', type=Path, required=True)
    q.add_argument('--candidate', type=Path, required=True); q.add_argument('--output', type=Path, required=True); q.add_argument('--conf', type=float, nargs='+', default=[0.25, 0.5])
    a = p.parse_args(argv); {'split': cmd_split, 'predict': cmd_predict, 'evaluate': cmd_evaluate, 'train': cmd_train, 'compare': cmd_compare}[a.cmd](a)

if __name__ == '__main__': main()

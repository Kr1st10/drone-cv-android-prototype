"""Stage 6.4: list FP/FN examples (ids, boxes, scores) for a predictions file; never touches the sealed test."""
from __future__ import annotations
import argparse, json
from pathlib import Path
from ml.scripts.real64_eval import frame_stats, selected


def examples(recs, preds, conf=0.25, k=12):
    by = {e['id']: e['predictions'] for e in preds}; fn, loc, fp = [], [], []
    for r in recs:
        if r.get('label_absent'): continue
        f = frame_stats(r, by[r['id']], conf); gt = [x['xyxy'] for x in r['annotations'] if x['class'] == 'drone']
        for g, box, h3 in zip(f['gt'], gt, f['hit0.3']):
            item = {'id': r['id'], 'sequence': r['sequence_id'], 'frame': r.get('frame_index'), 'gt': box, 'bin': g['bin'], 'best_iou': round(g['best_iou'], 3)}
            if not g['response']: fn.append(item)
            elif not h3: loc.append(item)
        if not gt:
            for x in by[r['id']]:
                if x[4] > conf:
                    others = [o for o in r['annotations'] + r.get('other_objects', [])]
                    fp.append({'id': r['id'], 'dataset': r['dataset'], 'sequence': r['sequence_id'], 'pred': x[:4], 'score': x[4],
                               'objects': sorted({o['class'] for o in others})})
    fp.sort(key=lambda e: -e['score'])
    pick = lambda L: [L[i * len(L) // k] for i in range(min(k, len(L)))]
    return {'conf': conf, 'counts': {'fn_no_response': len(fn), 'response_but_iou_below_0.3': len(loc), 'fp_on_drone_free_frames': len(fp)},
            'fn_no_response': pick(sorted(fn, key=lambda e: e['id'])), 'response_but_iou_below_0.3': pick(sorted(loc, key=lambda e: e['id'])),
            'top_fp': fp[:k], 'fp_by_object': {c: sum(1 for e in fp if c in e['objects']) for c in ('bird', 'airplane', 'helicopter')}}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, required=True); p.add_argument('--split', type=Path, required=True)
    p.add_argument('--predictions', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--splits', nargs='+', default=['train', 'validation', 'eval_only']); p.add_argument('--conf', type=float, default=0.25)
    a = p.parse_args(argv); recs, _ = selected(a.manifest, a.split, a.splits); preds = json.loads(a.predictions.read_text())['records']
    a.output.write_text(json.dumps(examples(recs, preds, a.conf), indent=1) + '\n')

if __name__ == '__main__': main()

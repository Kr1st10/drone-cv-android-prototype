"""Materialize only approved train/validation and optionally run one pinned experiment.

Never materializes test. Rights/independence must additionally be verified by a person.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import platform
import shutil
from pathlib import Path
from ml.dataset45.cli import image_path
from ml.dataset45.core import load_manifest, sha256_bytes
from ml.dataset45.splits import make_split
from ml.training62 import preflight


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def prepare(manifest, lock_path, references, dest):
    report = preflight(manifest, lock_path, references)
    records = load_manifest(manifest)['records']
    source_lock = json.loads(lock_path.read_text()); lock = source_lock.get('lock', source_lock)
    assignments, _, _ = make_split(records, lock['seed'], lock)
    # An existing target is never overwritten; test files are not copied.
    dest.mkdir(parents=True, exist_ok=False)
    for split in ('train', 'validation'):
        (dest / 'images' / split).mkdir(parents=True)
        (dest / 'labels' / split).mkdir(parents=True)
        for r in sorted(records, key=lambda item: item['id']):
            if assignments[r['id']] != split: continue
            shutil.copyfile(image_path(manifest, r), dest / 'images' / split / (r['id'] + '.png'))
            labels = []
            for a in r['annotations']:
                if a['class'] != 'drone': continue
                x1, y1, x2, y2 = a['xyxy']; w, h = r['width'], r['height']
                labels.append(f'0 {(x1+x2)/(2*w):.12g} {(y1+y2)/(2*h):.12g} {(x2-x1)/w:.12g} {(y2-y1)/h:.12g}')
            (dest / 'labels' / split / (r['id'] + '.txt')).write_text('\n'.join(labels) + ('\n' if labels else ''))
    # JSON is a valid YAML subset; absolute paths avoid working-directory ambiguity.
    spec = {'path': str(dest.resolve()), 'train': 'images/train', 'val': 'images/validation', 'names': {0: 'drone'}}
    (dest / 'data.yaml').write_text(json.dumps(spec, indent=2) + '\n')
    (dest / 'preflight.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, required=True); p.add_argument('--lock', type=Path, required=True)
    p.add_argument('--reference', action='append', type=Path, default=[]); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--config', type=Path, default=Path('ml/results/training62/experiment.json'))
    p.add_argument('--checkpoint', type=Path, required=True); p.add_argument('--device', default='cpu')
    p.add_argument('--run', action='store_true', help='explicitly launch training after preflight')
    a = p.parse_args(argv); config = json.loads(a.config.read_text())
    if digest(a.checkpoint) != config['checkpoint_sha256']: raise ValueError('checkpoint SHA mismatch')
    if a.output.resolve().is_relative_to(a.manifest.parent.resolve()): raise ValueError('output must be outside dataset directory')
    import ultralytics
    if ultralytics.__version__ != config['ultralytics_version']: raise ValueError('incorrect ultralytics version')
    report = prepare(a.manifest, a.lock, a.reference, a.output)
    metadata = {'status': 'prepared', 'config': config, 'config_sha256': sha256_bytes(a.config.read_bytes()),
                'checkpoint_sha256': digest(a.checkpoint), 'dataset': report, 'python': platform.python_version(),
                'ultralytics': ultralytics.__version__, 'device_requested': a.device,
                'warning': 'Do not select thresholds on test; dataset rights and independence require human verification.'}
    meta_path = a.output / 'run.json'
    def save(): meta_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + '\n')
    save()
    if not a.run: print('Prepared train/validation only; no training run.'); return 0
    from ultralytics import YOLO
    import torch
    metadata.update(status='running', torch=torch.__version__, cuda_available=torch.cuda.is_available()); save()
    try:
        model = YOLO(str(a.checkpoint))
        model.train(data=str((a.output / 'data.yaml').resolve()), project=str((a.output / 'runs').resolve()),
                    name='train', exist_ok=False, device=a.device, **config['train'])
        outputs = a.output / 'runs' / 'train'
        files = [outputs / 'weights' / 'best.pt', outputs / 'weights' / 'last.pt', outputs / 'results.csv', outputs / 'args.yaml']
        metadata['artifacts_sha256'] = {str(x.relative_to(a.output)): digest(x) for x in files if x.is_file()}
        if not (outputs / 'weights' / 'best.pt').is_file(): raise RuntimeError('training did not produce best.pt')
        metadata['status'] = 'completed'
    except Exception as exc:
        metadata.update(status='failed', error=f'{type(exc).__name__}: {exc}'); save(); raise
    save(); return 0

if __name__ == '__main__': raise SystemExit(main())

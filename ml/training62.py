"""Stage 6.2 safe dataset preflight for future experiments (never trains)."""
from __future__ import annotations
import argparse
import json
from collections import Counter
from pathlib import Path
from ml.dataset45.cli import check
from ml.dataset45.core import load_manifest, sha256_bytes
from ml.dataset45.duplicates import reference_conflicts
from ml.dataset45.splits import make_split


def preflight(manifest: Path, lock_path: Path, references: list[Path]) -> dict:
    data = load_manifest(manifest)
    report = check(manifest, data)
    if report['error_count']:
        raise ValueError('dataset failed validation: inspect dataset45 validate report')
    lock_data = json.loads(lock_path.read_text())
    lock = lock_data.get('lock', lock_data)
    if not lock.get('test_frozen'):
        raise ValueError('test lock must be frozen before training')
    if set(lock.get('records', {})) != {r['id'] for r in data['records']}:
        raise ValueError('manifest and lock record sets must match exactly')
    hashes = []
    for reference in references:
        ref = load_manifest(reference)
        if check(reference, ref)['error_count']:
            raise ValueError('reference failed validation')
        if reference_conflicts(data['records'], ref['records']):
            raise ValueError('potential reference overlap; investigate and quarantine')
        hashes.append(sha256_bytes(reference.read_bytes()))
    if lock.get('reference_sha256', []) != sorted(hashes):
        raise ValueError('references do not match frozen lock')
    assignments, _, _ = make_split(data['records'], lock['seed'], lock)
    counts = Counter(assignments.values())
    if any(not counts[s] for s in ('train', 'validation', 'test')):
        raise ValueError('all three partitions must be nonempty')
    for partition in ('train', 'validation'):
        if not any(assignments[r['id']] == partition and any(a['class'] == 'drone' for a in r['annotations']) for r in data['records']):
            raise ValueError(f'{partition} needs reviewed drone examples')
    return {'manifest_sha256': sha256_bytes(manifest.read_bytes()),
            'lock_sha256': sha256_bytes(lock_path.read_bytes()), 'reference_sha256': sorted(hashes),
            'counts': dict(counts), 'train_validation_only': True,
            'warning': 'Review, rights, provenance and independence are human claims, not proven by this tool.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--reference', type=Path, action='append', default=[])
    args = parser.parse_args(argv)
    print(json.dumps(preflight(args.manifest, args.lock, args.reference), indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())

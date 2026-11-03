"""Dataset preflight regression tests. All examples are synthetic."""
import json
from pathlib import Path
import pytest
from ml.dataset45.core import save_manifest
from ml.dataset45.splits import make_split
from ml.training62 import preflight
from test_dataset45 import record


def prepared(tmp_path):
    rows = [record(tmp_path, i) for i in range(30)]
    _, lock, _ = make_split(rows, freeze=True)
    lock['reference_sha256'] = []
    manifest = tmp_path / 'dataset' / 'manifest.json'
    lock_path = tmp_path / 'dataset' / 'lock.json'
    save_manifest(manifest, rows)
    lock_path.write_text(json.dumps(lock))
    return rows, manifest, lock_path


def test_preflight_frozen_and_deterministic(tmp_path):
    _, m, lock = prepared(tmp_path)
    assert preflight(m, lock, []) == preflight(m, lock, [])
    assert preflight(m, lock, [])['train_validation_only']


def test_preflight_fails_on_changed_lock_record(tmp_path):
    rows, m, lock = prepared(tmp_path)
    rows[0]['annotations'][0]['xyxy'] = [1, 1, 3, 3]
    save_manifest(m, rows)
    with pytest.raises(ValueError, match='locked record changed'):
        preflight(m, lock, [])


def test_preflight_fails_unfrozen_and_reference_changes(tmp_path):
    _, m, path = prepared(tmp_path)
    lock = json.loads(path.read_text()); lock['test_frozen'] = False
    path.write_text(json.dumps(lock))
    with pytest.raises(ValueError, match='frozen'): preflight(m, path, [])
    lock['test_frozen'] = True; lock['reference_sha256'] = ['a' * 64]
    path.write_text(json.dumps(lock))
    with pytest.raises(ValueError, match='references'): preflight(m, path, [])


def test_preflight_rejects_quarantined_pilot():
    # Missing lock/images are also a hard stop; it never generates eligible data.
    pilot = Path('ml/results/dataset45/pilot_manifest.json')
    data = json.loads(pilot.read_text())
    assert all(r['review_status'] != 'reviewed' for r in data['records'])

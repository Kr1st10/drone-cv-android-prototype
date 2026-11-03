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
    lock['test_frozen'] = 'false'; path.write_text(json.dumps(lock))
    with pytest.raises(ValueError, match='frozen'): preflight(m, path, [])
    lock['test_frozen'] = True; lock['reference_sha256'] = ['a' * 64]
    path.write_text(json.dumps(lock))
    with pytest.raises(ValueError, match='references'): preflight(m, path, [])


def test_preflight_rejects_quarantined_pilot():
    # Missing lock/images are also a hard stop; it never generates eligible data.
    pilot = Path('ml/results/dataset45/pilot_manifest.json')
    data = json.loads(pilot.read_text())
    assert all(r['review_status'] != 'reviewed' for r in data['records'])
    with pytest.raises(ValueError, match='quarantine'):
        make_split(data['records'])


def test_prepare_materializes_train_validation_but_never_test(tmp_path):
    from ml.train62 import prepare
    rows, m, lock = prepared(tmp_path)
    result = prepare(m, lock, [], tmp_path / 'materialized')
    assignments, _, _ = make_split(rows, previous=json.loads(lock.read_text()))
    dest = tmp_path / 'materialized'
    for r in rows:
        if assignments[r['id']] == 'test':
            assert not list(dest.rglob(r['id'] + '*'))
        else:
            split = assignments[r['id']]
            assert (dest / 'images' / split / (r['id'] + '.png')).exists()
            assert (dest / 'labels' / split / (r['id'] + '.txt')).read_text().startswith('0 ')
    assert result['counts']['test'] > 0
    with pytest.raises(FileExistsError): prepare(m, lock, [], dest)


def test_prepare_fails_before_copy_on_quarantine(tmp_path):
    from ml.train62 import prepare
    rows, m, lock = prepared(tmp_path)
    rows[0]['review_status'] = 'unreviewed'; save_manifest(m, rows)
    out = tmp_path / 'materialized'
    with pytest.raises(ValueError): prepare(m, lock, [], out)
    assert not out.exists()


def test_validation_curve_reuses_matcher_and_preserves_negative_slices(tmp_path):
    from ml.compare62 import curve
    a, b = record(tmp_path, 1), record(tmp_path, 2)
    b['annotations'] = [{'class': 'bird', 'xyxy': [1, 1, 8, 8]}]
    b['negative_verified'] = True
    pred = [{'id': a['id'], 'predictions': [[2, 3, 12, 13, .8]]},
            {'id': b['id'], 'predictions': [[1, 1, 8, 8, .6]]}]
    points = curve([a, b], pred)
    at25 = next(x for x in points if x['confidence'] == .25)
    assert at25['metrics']['counts']['tp'] == 1
    assert at25['metrics']['counts']['fp'] == 1
    assert at25['metrics']['precision_all'] == .5
    assert at25['negative_class_slices']['bird']['fp'] == 1
    assert at25['fp_geometry']['fp_overlap_bird_iou_ge_0.1'] == 1
    at70 = next(x for x in points if x['confidence'] == .7)
    assert at70['metrics']['precision_all'] == 1


def test_checkpoint_mismatch_stops_before_data_copy(tmp_path):
    from ml.train62 import main
    _, m, lock = prepared(tmp_path)
    checkpoint = tmp_path / 'fake.pt'; checkpoint.write_bytes(b'not a checkpoint')
    out = tmp_path / 'prepared'
    with pytest.raises(ValueError, match='checkpoint SHA mismatch'):
        main(['--manifest', str(m), '--lock', str(lock), '--checkpoint', str(checkpoint), '--output', str(out)])
    assert not out.exists()

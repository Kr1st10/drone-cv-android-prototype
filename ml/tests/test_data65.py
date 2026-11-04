import json
import numpy as np
import pytest
from PIL import Image
from ml.scripts import data65 as d


def R(i, split='train', ds='uavdb', scene='s1', anns=(), other=(), w=1920, h=1080, **kw):
    r = d.rec(ds, str(i), kw.pop('file', 'x.jpg'), w, h, f'{ds}:g', scene, split, [{'class': 'drone', 'xyxy': list(b)} for b in anns],
              other_objects=[{'class': c, 'xyxy': list(b)} for c, b in other], **kw)
    r['dhash64'] = kw.get('dh', '0' * 16); return r


def test_size_bins_at_640_letterbox():
    assert d.size640([0, 0, 30, 30], 1920, 1080) == pytest.approx(10.0)
    assert d.bin_of(7.9) == '<8' and d.bin_of(8) == '8-<16' and d.bin_of(16) == '16-<24' and d.bin_of(24) == '24-<30' and d.bin_of(30) == '>=30'
    assert d.size640([0, 0, 20, 20], 640, 480) == pytest.approx(20.0)


def test_load_rejects_test(tmp_path):
    with pytest.raises(ValueError):
        d.load(tmp_path / 'm.json', ['validation', 'test'])


def test_frame_eval_response_and_fp_classes():
    r = R(1, anns=[(100, 100, 110, 110)], other=[('bird', (500, 500, 520, 520))], w=640, h=640)
    preds = [[101, 101, 111, 111, .9], [112, 100, 122, 110, .8], [502, 502, 518, 518, .7], [0, 0, 5, 5, .05]]
    gts, n, fp, unmatched = d.frame_eval(r, preds, .25)
    assert n == 3 and gts[0]['h3'] and gts[0]['resp'] and gts[0]['bin'] == '8-<16'
    assert fp == {'drone_localisation': 1, 'bird': 1} and unmatched == 2


def test_summarize_negatives_and_label_absent():
    recs = [R(1, anns=[(0, 0, 20, 20)], w=640, h=640), R(2, other=[('airplane', (0, 0, 10, 10))]), R(3, label_absent=True)]
    preds = [{'id': 'uavdb:1', 'predictions': [[0, 0, 20, 20, .9]]}, {'id': 'uavdb:2', 'predictions': [[300, 300, 320, 320, .9]]}, {'id': 'uavdb:3', 'predictions': []}]
    s = d.summarize(recs, preds, .25, n_boot=10)
    assert s['overall']['recall_iou0.5'] == 1.0 and s['negatives']['airplane'] == {'frames': 1, 'frames_with_fp': 1, 'fp': 1}
    assert s['negatives_total']['frames'] == 1


def test_train_selection_quota_deterministic_and_train_only():
    recs = [R(i, scene=f's{i % 3}') for i in range(30)] + [R(100 + i, split='validation') for i in range(5)] + [R(200, label_absent=True)]
    a = d.train_selection(recs, {'uavdb': 9}); b = d.train_selection(list(reversed(recs)), {'uavdb': 9})
    assert [r['id'] for r in a] == [r['id'] for r in b] and len(a) == 9
    assert all(r['split'] == 'train' and not r['label_absent'] for r in a) and len({r['scene'] for r in a}) == 3


def test_yolo_label():
    r = R(1, anns=[(0, 0, 64, 32)], w=640, h=320)
    assert d.yolo_label(r) == '0 0.050000 0.050000 0.100000 0.100000\n'


def test_near_duplicates_confirms_only_real_copies(tmp_path):
    rng = np.random.default_rng(0); a = rng.integers(0, 255, (64, 64, 3), dtype=np.uint8); b = rng.integers(0, 255, (64, 64, 3), dtype=np.uint8)
    paths = []
    for name, arr in (('a', a), ('a2', np.clip(a.astype(int) + 3, 0, 255).astype(np.uint8)), ('b', b)):
        p = tmp_path / f'{name}.png'; Image.fromarray(arr).save(p); paths.append(p)
    recs = [R(i, file=str(p)) for i, p in enumerate(paths)]
    for r in recs: r['dhash64'] = '0' * 16  # force dHash collision: second stage must decide
    n, dup = d.near_duplicates([recs[0]], recs[1:])
    assert n == 2 and [x[1] for x in dup] == ['uavdb:1']


def test_halmstad_negatives_drop_sealed_test(tmp_path):
    split = {'groups': {'halmstad': {'group_sequences': {'G1': ['halmstad:V_BIRD_001'], 'G2': ['halmstad:V_BIRD_002']},
                                     'group_splits': {'G1': 'train', 'G2': 'test'}}}}
    base = {'width': 640, 'height': 512, 'file': 'images/x.png', 'other_objects': [], 'label_absent': False, 'video_class': 'bird'}
    recs = [dict(base, id='a' * 64, sequence_id='halmstad:V_BIRD_001', annotations=[{'class': 'bird', 'xyxy': [0, 0, 5, 5]}], internet_sourced=False),
            dict(base, id='b' * 64, sequence_id='halmstad:V_BIRD_002', annotations=[], internet_sourced=False),
            dict(base, id='c' * 64, sequence_id='youtube:1', annotations=[], internet_sourced=True)]
    (tmp_path / 'm.json').write_text(json.dumps({'records': recs})); (tmp_path / 's.json').write_text(json.dumps(split))
    out, dropped = d.src_halmstad_neg(tmp_path / 'm.json', tmp_path / 's.json')
    assert [r['split'] for r in out] == ['train', 'eval_only'] and dropped == {'stage64_sealed_test': 1}
    assert out[0]['annotations'] == [] and out[0]['other_objects'][0]['class'] == 'bird'

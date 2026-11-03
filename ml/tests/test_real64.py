import json

import numpy as np
import pytest

from ml.scripts.real64_eval import assign, balanced_assign, frame_stats, near, selected, size_bin
from ml.scripts.real64_prepare import matlab_xywh_to_xyxy, sky_sequences, yolo_to_xyxy


def test_matlab_one_based_to_zero_based_xyxy():
    assert matlab_xywh_to_xyxy([1, 1, 10, 5], 640, 512) == [0.0, 0.0, 10.0, 5.0]
    assert matlab_xywh_to_xyxy([636, 510, 10, 10], 640, 512) == [635.0, 509.0, 640.0, 512.0]
    assert matlab_xywh_to_xyxy([5, 5, 0, 3], 640, 512) is None


def test_yolo_to_xyxy_clips_and_rejects_empty():
    assert yolo_to_xyxy(0.5, 0.5, 0.1, 0.2, 600, 600) == pytest.approx([270, 240, 330, 360])
    assert yolo_to_xyxy(0.0, 0.5, 0.1, 0.1, 600, 600)[0] == 0.0
    assert yolo_to_xyxy(0.5, 0.5, 0.0, 0.1, 600, 600) is None


def test_sky_sequences_split_on_time_gap():
    names = ['a_20191206101500000000.png', 'b_20191206101505000000.png', 'c_20191206103000000000.png']
    s = sky_sequences(names)
    assert s[names[0]] == s[names[1]] != s[names[2]]


def test_size_bins_use_sqrt_area():
    assert size_bin([0, 0, 15, 15]) == '<16'
    assert size_bin([0, 0, 16, 16]) == '16-<24'
    assert size_bin([0, 0, 24, 24]) == '24-<30'
    assert size_bin([0, 0, 10, 90]) == '>=30'


def test_assign_is_deterministic():
    assert assign('halmstad:V_DRONE_001') == assign('halmstad:V_DRONE_001')
    assert assign('x', seed='a') in {'train', 'validation', 'test'}


def test_balanced_assign_keeps_dominant_site_in_train_and_fills_heldout():
    groups = {'site': 800, **{f'g{i}': 20 for i in range(20)}, 'neg': 0}
    out = balanced_assign(groups)
    assert out['site'] == 'train'
    total = sum(groups.values())
    for split in ('test', 'validation'):
        share = sum(groups[k] for k, v in out.items() if v == split) / total
        assert 0 < share <= 0.2
    assert out['neg'] in {'train', 'validation', 'test'}


def test_near_response_window():
    g = [100, 100, 110, 110]
    assert near([112, 100, 122, 110], g)
    assert not near([140, 100, 150, 110], g)


def test_frame_stats_iou_thresholds_and_fp_targets():
    r = {'annotations': [{'class': 'drone', 'xyxy': [100, 100, 120, 120]}, {'class': 'bird', 'xyxy': [300, 300, 310, 310]}],
         'other_objects': []}
    preds = [[102, 102, 122, 122, 0.9], [301, 301, 311, 311, 0.8], [500, 50, 510, 60, 0.7], [0, 0, 5, 5, 0.1]]
    f = frame_stats(r, preds, 0.25)
    assert f['n_pred'] == 3
    assert f['hit0.3'].tolist() == [True] and f['hit0.5'].tolist() == [True]
    assert dict(f['fp_by_target']) == {'bird': 1, 'background': 1}
    loose = frame_stats(r, [[106, 106, 126, 126, 0.9]], 0.25)
    assert loose['hit0.3'].tolist() == [True] and loose['hit0.5'].tolist() == [False]
    assert loose['gt'][0]['response'] and 0.3 < loose['gt'][0]['best_iou'] < 0.5


def test_selected_refuses_sealed_test(tmp_path):
    split = tmp_path / 'split.json'
    split.write_text(json.dumps({'assignments': {}}))
    with pytest.raises(ValueError):
        selected(tmp_path / 'manifest.json', split, ['validation', 'test'])

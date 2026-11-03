import io, json
import pytest
from PIL import Image
from ml.scripts import dut63, dut63_tracking


def test_size_bins_use_sqrt_area():
    assert dut63.size_bin([0, 0, 10, 10]) == '<16'
    assert dut63.size_bin([0, 0, 16, 16]) == '16-<24'
    assert dut63.size_bin([0, 0, 24, 24]) == '24-<30'
    assert dut63.size_bin([0, 0, 60, 15]) == '>=30'


def test_box_issues():
    assert dut63.box_issues([1, 1, 5, 5], 0, 10, 10) == []
    assert 'non_positive_size' in dut63.box_issues([5, 1, 5, 5], 0, 10, 10)
    assert 'outside_image' in dut63.box_issues([1, 1, 15, 5], 0, 10, 10)
    assert dut63.box_issues([-0.5, 1, 5, 5], 0, 10, 10) == ['clipped_within_tolerance']
    assert 'unexpected_category' in dut63.box_issues([1, 1, 5, 5], 1, 10, 10)
    assert 'implausibly_large' in dut63.box_issues([0, 0, 9, 9], 0, 10, 10)
    assert dut63.clip([-0.5, 1, 10.4, 5], 10, 10) == [0.0, 1, 10, 5]


def test_tracking_xywh_conversion():
    assert dut63_tracking.xywh_to_xyxy([2, 3, 4, 5], 10, 10) == [2, 3, 6, 8]
    with pytest.raises(ValueError): dut63_tracking.xywh_to_xyxy([8, 3, 4, 5], 10, 10)
    assert dut63_tracking.positions(11) == [0, 2, 4, 6, 8, 10]


def test_clusters_and_leakage():
    items = [('a', '0' * 16), ('b', '0' * 15 + '1'), ('c', 'f' * 16)]
    assert dut63.clusters(items, 4) == [['a', 'b']]
    train = [{'id': 't1', 'pixel_sha256': 'x', 'dhash64': '0' * 16}, {'id': 't2', 'pixel_sha256': 'y', 'dhash64': 'f' * 16},
             {'id': 't3', 'pixel_sha256': 'v', 'dhash64': '0f' * 8}]
    val = [{'id': 'v1', 'pixel_sha256': 'v', 'dhash64': '00000000000000ff'}]
    leaks = dut63.leakage(train, val, 10)
    assert leaks['t1'] == (8, 'v1') and leaks['t3'] == (0, 'v1') and 't2' not in leaks


def test_yolo_label_normalised():
    r = {'width': 100, 'height': 50, 'annotations': [{'xyxy': [10, 10, 30, 20]}]}
    assert dut63.yolo_label(r) == '0 0.20000000 0.30000000 0.20000000 0.20000000\n'


def _jpeg(w=64, h=48):
    b = io.BytesIO(); Image.new('RGB', (w, h), (120, 160, 200)).save(b, 'JPEG'); return b.getvalue()


def test_read_shard_and_evaluation(tmp_path):
    pa = pytest.importorskip('pyarrow'); pq = pytest.importorskip('pyarrow.parquet')
    rows = [{'image_id': '00001', 'image': {'bytes': _jpeg(), 'path': None}, 'width': 64, 'height': 48,
             'objects': {'bbox': [[10.0, 10.0, 30.0, 20.0]], 'category': [0]}},
            {'image_id': '00002', 'image': {'bytes': _jpeg(), 'path': None}, 'width': 64, 'height': 48,
             'objects': {'bbox': [[10.0, 10.0, 90.0, 20.0]], 'category': [0]}}]
    f = tmp_path / 's.parquet'; pq.write_table(pa.Table.from_pylist(rows), f)
    recs = dut63.read_shard(f, 'validation', tmp_path / 'img')
    assert recs[0]['annotations'][0]['xyxy'] == [10.0, 10.0, 30.0, 20.0] and recs[0]['auto_issues'] == []
    assert recs[1]['annotations'] == [] and 'outside_image' in recs[1]['auto_issues']
    assert (tmp_path / 'img' / 'validation' / 'dut-det-validation-00001.jpg').read_bytes() == rows[0]['image']['bytes']
    preds = [{'id': recs[0]['id'], 'predictions': [[10, 10, 30, 20, .9], [40, 30, 50, 40, .3]]},
             {'id': recs[1]['id'], 'predictions': []}]
    fps, fns = dut63.examples(recs, preds, 0.25)
    assert len(fps) == 1 and fps[0]['max_iou_gt'] == 0.0 and fns == []
    from ml.dataset45.evaluate import evaluate_records
    res = evaluate_records(recs, dut63.threshold(preds, .5), .5)
    assert res['counts'] == {'tp': 1, 'fp': 0, 'fn': 0, 'images': 2}
    ci = dut63.cluster_bootstrap(recs, preds, .25, {}, n=50)
    assert ci['units'] == 2 and ci['recall_ci95'] == [1.0, 1.0]
    worse = [{'id': recs[0]['id'], 'predictions': [[40, 30, 50, 40, .9]]}, {'id': recs[1]['id'], 'predictions': []}]
    d = dut63.paired_delta(recs, worse, preds, .25, {}, n=50)
    assert d['delta_recall'] == 1.0 and d['delta_precision'] == 0.5


def test_configs_pin_checkpoint_and_disable_val_selection():
    for name in ('finetune_config.json', 'finetune_config_gpu.json'):
        c = json.load(open(f'ml/results/dut63/{name}'))
        assert c['checkpoint_sha256'].startswith('337390e1') and 'never used' in c['selection']

import numpy as np
import pytest

from ml.cascade.prepare import audit
from ml.cascade.run import BASELINE, CASCADE, budget_counts, candidate_ceiling, score_for_budget
from ml.cascade.runtime import CropVerifier, SIZE, TOP_K, crop
from ml.cascade.train import crop_labels


def test_crop_and_top_k_leave_yolo_coordinates_intact(monkeypatch):
    image = np.zeros((16, 40, 3), dtype=np.uint8)
    image[:, :20, 0] = 200
    patch = crop(image, np.array([0, 0, 20, 8]))
    assert patch.shape == (SIZE, SIZE, 3)
    assert patch[0, 0].tolist() == [114, 114, 114]
    assert patch[SIZE // 2, SIZE // 2].tolist() == [200, 0, 0]

    verifier = object.__new__(CropVerifier)
    monkeypatch.setattr(verifier, "probabilities", lambda image, rows: np.full(len(rows), .5))
    boxes = np.tile([0, 0, 20, 8, .9], (TOP_K + 1, 1))
    scored = verifier.score(image, boxes)
    assert len(scored) == TOP_K
    np.testing.assert_array_equal(scored[:, :5], boxes[:TOP_K])
    np.testing.assert_allclose(scored[:, -1], .45)
    assert verifier.score(image, boxes[:0]).shape == (0, 7)


def test_mining_preserves_semantic_positive_and_ignores_uncertain_localization():
    gt = np.array([[10, 10, 30, 30]])
    boxes = np.array([[18, 18, 22, 22], [13, 13, 27, 27], [22, 10, 60, 50], [50, 50, 60, 60]])
    assert crop_labels(boxes, gt).tolist() == [-1, 1, -1, 0]
    assert crop_labels(boxes, gt[:0]).tolist() == [0, 0, 0, 0]


def test_equal_budget_counts_tied_scores_and_localization_errors():
    gt = {"width": 640, "height": 480, "annotations": [{"class": "drone", "xyxy": [0, 0, 10, 10]}]}
    negative = {"width": 640, "height": 480, "annotations": []}
    boxes = np.array([[0, 0, 10, 10, .8], [10, 10, 40, 40, .7], [80, 80, 90, 90, .6]])
    rescored = np.column_stack([boxes, np.ones(3), [.8, .6, .6]])
    frames = [(gt, boxes[:1], boxes, rescored, {}), (negative, boxes[:1], boxes, rescored, {})]
    baseline = budget_counts(frames, BASELINE, .5)
    assert baseline == {"all_fp": 1, "negative_fp": 1}
    threshold = score_for_budget(frames, baseline["all_fp"], "all_fp")
    assert threshold == .6
    assert budget_counts(frames, CASCADE, threshold) == baseline
    assert candidate_ceiling(frames)["8-<16"]["top_k_iou50"] == 1


def test_cross_split_video_provenance_rejected(tmp_path):
    common = {"file": "fixture.png", "sha256": "a", "mean_rgb_hex": "ffffff", "video_sha256": "same-video"}
    a = dict(common, id="a", group="first", source_id="first", split="train")
    b = dict(common, id="b", group="second", source_id="second", split="test")
    with pytest.raises(ValueError, match="Cross-split video_sha256"):
        audit([a, b], tmp_path)

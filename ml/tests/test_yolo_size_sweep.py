"""Geometry and scoring checks for the digital size series."""
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from drone_detector import Detection, preprocess
from yolo_size_sweep import BACKGROUND, OFFSETS, WIDTHS, evaluate_detections, variants


def test_requested_widths_and_transformed_bbox_in_yolo_input():
    source = Image.new("RGB", (260, 100), (220, 100, 80))
    box = (22.25, 10.5, 222.25, 60.5)
    observed = []
    for width, (dx, dy), canvas, gt in variants(source, box):
        observed.append((width, (dx, dy)))
        x1, y1, x2, y2 = gt
        assert x2 - x1 == width
        assert y2 - y1 == pytest.approx(width / 4)
        assert (x1 + x2) / 2 == 320 + dx
        assert (y1 + y2) / 2 == 320 + dy
        assert canvas.getpixel((0, 0)) == BACKGROUND
        assert canvas.getpixel((320 + dx, 320 + dy)) == (220, 100, 80)
        tensor, info = preprocess(np.asarray(canvas))
        assert tensor.shape == (1, 3, 640, 640)
        assert (info.scale, info.pad_x, info.pad_y) == (1, 0, 0)
    assert observed == [(w, shift) for w in WIDTHS for shift in OFFSETS]


def test_series_reproducibility_and_integer_translation():
    pattern = np.random.default_rng(5).integers(0, 255, size=(80, 128, 3), dtype=np.uint8)
    source = Image.fromarray(pattern)
    box = (7, 0, 117, 25)  # also exercises padding above the source
    run = list(variants(source, box))
    repeat = list(variants(source, box))
    for (width, shift, image, gt), (width2, shift2, image2, gt2) in zip(run, repeat):
        assert (width, shift, gt) == (width2, shift2, gt2)
        assert image.tobytes() == image2.tobytes()
    for index in range(0, len(run), len(OFFSETS)):
        center = np.asarray(run[index][2])
        for _, (dx, dy), image, _ in run[index:index + len(OFFSETS)]:
            assert np.array_equal(np.asarray(image), np.roll(center, (dy, dx), axis=(0, 1)))


@pytest.mark.parametrize("box", [(0, 0, 40, 60), (0, 0, 150, 60), (0, 3, 90, 3), (float("nan"), 0, 90, 30)])
def test_rejects_invalid_source_bbox(box):
    with pytest.raises(ValueError, match="bbox"):
        list(variants(Image.new("RGB", (100, 100)), box))


def test_empty_wrong_match_and_unverified_stay_distinct():
    gt = (10, 10, 20, 20)
    unrelated = Detection(30, 30, 40, 40, .9)
    good = Detection(10, 10, 15, 20, .6)
    absent = evaluate_detections([], gt, verified=True)
    wrong = evaluate_detections([unrelated], gt, verified=True)
    mixed = evaluate_detections([unrelated, good], gt, verified=True)
    unknown = evaluate_detections([good], gt, verified=False)
    assert (absent["outcome"], absent["best_iou"], absent["fp"], absent["fn"]) == ("no_detection", None, 0, 1)
    assert (wrong["outcome"], wrong["best_iou"], wrong["fp"], wrong["fn"]) == ("unmatched", 0, 1, 1)
    assert (mixed["outcome"], mixed["best_iou"], mixed["tp"], mixed["fp"], mixed["fn"]) == ("matched", .5, 1, 1, 0)
    assert [d["matched"] for d in mixed["detections"]] == [False, True]
    assert unknown["outcome"] == "unverified"
    assert all(unknown[key] is None for key in ["matched", "best_iou", "tp", "fp", "fn"])
    assert "gt_iou" not in unknown["detections"][0]

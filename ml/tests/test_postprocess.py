"""Unit tests for pre/post-processing (no model file needed).

Run: python -m pytest ml/tests -q
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import drone_detector as dd  # noqa: E402


def make_output(rows):
    """rows: list of (cx, cy, w, h, score) in 640-input pixels -> [1, 5, 8400]."""
    out = np.zeros((1, 5, 8400), np.float32)
    for i, r in enumerate(rows):
        out[0, :, i] = r
    return out


def test_letterbox_landscape_geometry():
    img = np.zeros((480, 640, 3), np.uint8)
    x, info = dd.preprocess(img)
    assert x.shape == (1, 3, 640, 640) and x.dtype == np.float32
    assert info.scale == 1.0 and info.pad_x == 0 and info.pad_y == 80
    # padding value 114/255, image area 0
    assert np.isclose(x[0, 0, 0, 0], 114 / 255) and x[0, 0, 80, 0] == 0.0 and x[0, 0, 559, 0] == 0.0
    assert np.isclose(x[0, 0, 560, 0], 114 / 255)


def test_letterbox_portrait_and_channel_order():
    img = np.zeros((1920, 1080, 3), np.uint8)
    img[..., 0] = 255  # pure red in RGB
    x, info = dd.preprocess(img)
    assert np.isclose(info.scale, 640 / 1920)
    assert info.pad_y == 0 and info.pad_x == 140  # (640 - 360) / 2
    assert x[0, 0, 320, 320] == 1.0 and x[0, 1, 320, 320] == 0.0 and x[0, 2, 320, 320] == 0.0


def test_empty_output_returns_empty_list():
    info = dd.LetterboxInfo(1.0, 0, 80, 640, 480)
    assert dd.postprocess(np.zeros((1, 5, 8400), np.float32), info) == []
    assert dd.postprocess(np.zeros((1, 5, 0), np.float32), info) == []


def test_bad_shape_raises():
    with pytest.raises(ValueError):
        dd.postprocess(np.zeros((5, 8400), np.float32), dd.LetterboxInfo(1, 0, 0, 640, 640))


def test_decode_and_unletterbox():
    # 640x480 image -> pad_y 80. Box centred at (100, 200+80) in input = (100, 200) in original.
    info = dd.LetterboxInfo(1.0, 0, 80, 640, 480)
    dets = dd.postprocess(make_output([(100, 280, 20, 10, 0.9)]), info)
    assert len(dets) == 1
    d = dets[0]
    assert (d.x1, d.y1, d.x2, d.y2) == pytest.approx((90, 195, 110, 205))
    assert d.score == pytest.approx(0.9) and d.label == "drone"


def test_scale_inverse():
    info = dd.LetterboxInfo(0.5, 0, 0, 1280, 1280)
    d = dd.postprocess(make_output([(320, 320, 64, 64, 0.8)]), info)[0]
    assert (d.x1, d.y1, d.x2, d.y2) == pytest.approx((576, 576, 704, 704))


def test_threshold_nms_and_clipping():
    info = dd.LetterboxInfo(1.0, 0, 0, 640, 640)
    rows = [(100, 100, 40, 40, 0.9), (102, 101, 40, 40, 0.8),  # overlapping -> one kept
            (400, 400, 30, 30, 0.6),                            # separate -> kept
            (300, 300, 30, 30, 0.2),                            # below conf -> dropped
            (5, 5, 30, 30, 0.7)]                                # partly outside -> clipped
    dets = dd.postprocess(make_output(rows), info, conf=0.25, iou=0.7)
    assert [round(d.score, 2) for d in dets] == [0.9, 0.7, 0.6]
    clipped = dets[1]
    assert clipped.x1 == 0 and clipped.y1 == 0 and clipped.x2 == pytest.approx(20)


def test_nms_empty():
    assert dd.nms(np.zeros((0, 4)), np.zeros((0,)), 0.5).size == 0

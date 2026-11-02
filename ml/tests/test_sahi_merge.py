"""Tests for the SAHI adapter used in stage 4.1 (no model file needed).

A fake detector returns the bounding box of bright pixels inside whatever slice it is given, in slice
coordinates. This checks the slice -> full-image coordinate shift, cross-slice merging (one object
must not be reported twice) and that duplicate boxes are counted as FP, not as extra TP.

Run: python -m pytest ml/tests -q
"""
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("sahi")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import drone_detector as dd  # noqa: E402
import sahi_experiment as se  # noqa: E402


class BrightBoxDetector:
    """Returns the bbox of all bright pixels in the slice. Score grows with the visible area (a cut
    fragment is less confident than the whole object, as with a real detector) unless fixed_score."""

    def __init__(self, fixed_score=None):
        self.calls = []
        self.fixed_score = fixed_score

    def __call__(self, img, conf):
        self.calls.append(img.shape[:2])
        ys, xs = np.nonzero(img[..., 0] > 128)
        if len(xs) == 0:
            return []
        x1, y1, x2, y2 = float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)
        score = self.fixed_score or min(0.99, 0.3 + (x2 - x1) * (y2 - y1) / 4000)
        return [dd.Detection(x1, y1, x2, y2, score)]


def image_with_square(x1, y1, x2, y2, w=640, h=480):
    img = np.zeros((h, w, 3), np.uint8)
    img[y1:y2, x1:x2] = 255
    return img


def test_shift_to_full_image_coordinates_tiles_only():
    # 20x20 "drone" fully inside the bottom-right slice only (x >= 320+, y >= 160+ region).
    img = image_with_square(600, 440, 620, 460)
    fake = BrightBoxDetector()
    dets = se.sahi_predict(img, fake, 0.25, 320, 0.2, full_pass=False)
    assert len(fake.calls) == 6  # 640x480, 320 slices, 0.2 overlap -> 3 x 2
    assert len(dets) == 1
    d = dets[0]
    assert (d.x1, d.y1, d.x2, d.y2) == pytest.approx((600, 440, 620, 460))


def test_object_in_overlap_seen_by_several_slices_is_merged_once():
    # Square inside the overlap of all slices horizontally (x 300..316) and vertically (y 200..216).
    img = image_with_square(300, 200, 316, 216)
    fake = BrightBoxDetector()
    dets = se.sahi_predict(img, fake, 0.25, 320, 0.2, full_pass=True)
    assert len(fake.calls) == 7  # 6 slices + full-frame pass
    assert len(dets) == 1
    assert (dets[0].x1, dets[0].y1, dets[0].x2, dets[0].y2) == pytest.approx((300, 200, 316, 216))


def test_object_cut_by_slice_border_fragments_are_merged():
    # Wide object crossing the x=320 slice border; slices at x=0 (0..320) and x=256 (256..576) and x=320.
    img = image_with_square(250, 100, 330, 120)
    dets = se.sahi_predict(img, BrightBoxDetector(), 0.25, 320, 0.2, full_pass=True)
    assert len(dets) == 1
    d = dets[0]
    # GREEDYNMM merges into the union of matched boxes -> the full object.
    assert (d.x1, d.y1, d.x2, d.y2) == pytest.approx((250, 100, 330, 120))


def test_fragments_merged_without_full_frame_pass():
    img = image_with_square(250, 100, 330, 120)
    dets = se.sahi_predict(img, BrightBoxDetector(), 0.25, 320, 0.2, full_pass=False)
    assert len(dets) == 1
    assert (dets[0].x1, dets[0].x2) == pytest.approx((250, 330))


def test_known_limitation_equal_scores_can_leave_a_sliver():
    """Characterisation of sahi 0.14.0 GREEDYNMM: it is non-transitive. With exactly equal scores the
    kept box may be a fragment that does not overlap a thin sliver from another slice, so the sliver
    survives as a 2nd box. Real detections rarely tie; the experiment counts such cases as dup_fp."""
    img = image_with_square(250, 100, 330, 120)
    dets = se.sahi_predict(img, BrightBoxDetector(fixed_score=0.9), 0.25, 320, 0.2, full_pass=True)
    assert len(dets) == 2


def test_empty_image_gives_no_detections():
    dets = se.sahi_predict(np.zeros((480, 640, 3), np.uint8), BrightBoxDetector(), 0.25, 320, 0.2, True)
    assert dets == []


def test_duplicate_box_is_fp_not_second_tp():
    gt = np.array([[100, 100, 120, 120]], float)
    dets = [dd.Detection(100, 100, 120, 120, 0.9), dd.Detection(101, 101, 121, 121, 0.8)]
    r = se.eval_image(dets, gt)
    assert (r["tp"], r["fp"], r["fn"], r["dup_fp"]) == (1, 1, 0, 1)


def test_baseline_mode_bypasses_slicing():
    fake = BrightBoxDetector()
    img = image_with_square(10, 10, 30, 30)
    dets = se.predict(se.Mode("baseline"), img, fake, 0.25)
    assert len(fake.calls) == 1 and fake.calls[0] == (480, 640) and len(dets) == 1

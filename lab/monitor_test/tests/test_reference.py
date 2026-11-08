"""Check reference assets, geometry and formula without network or a detector."""
import hashlib
import json
import math
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_reference_geometry():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required for reference geometry checks')
    result = subprocess.run([node, str(ROOT / 'tests/reference_test.mjs')], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_reference_asset_integrity():
    expected = {
        'skydroid_top.jpg': '659839b4f3f303ce8e66663ae1751858bb65aa865ed3e875317ce885e6f93f0a',
        'gedz_top.png': '7e4cd764af0f2bf0bc420a3658462b04e179325f9a4d80c3295e21c41498be44',
        'skydroid_front.jpg': 'c8649c9ec2518d91df67fc1efec44ff099205297277fe13c73cfc3d787f1a406',
        'skydroid_oblique_candidate.png': '1cf0d7f251fc130c672fb1e53770d583bb2207e0372a228d197719a122d4930a',
        'gedz_oblique.png': 'ad85555e540da64dcad12f2d9e8f78f7a09991536469ffaef2c7754ba96ade38',
        'gedz_side.png': '50ade8bf44ae4ca0b7f0676abbfee014677268c73618e53a3c9cc8e39462742b',
    }
    for name, digest in expected.items():
        assert hashlib.sha256((ROOT / 'reference_assets' / name).read_bytes()).hexdigest() == digest


def test_independent_angular_oracle():
    """Compare JS to fixed rational answers and a separate angular-size derivation in Python.

    All photo axes here are synthetic. This cannot validate geometry of the real product pictures.
    """
    node = shutil.which('node')
    if not node:
        pytest.skip('Node required for cross-language verification')
    cases, expectations = [], []

    def add(real_cm, distance_cm, display_cm, expected_m):
        # Place an explicit 300-px segment inside a 1000-px file with white margins.
        scale = float(Fraction(str(display_cm)) * 10 / (300 * Fraction('0.25')))
        cases.append({
            'profile': {'photos': [{'id': 'synthetic', 'file': 'TEST ONLY', 'width': 1000, 'height': 500,
                'bounds_px': [100, 50, 400, 200], 'object_complete': True,
                'model_confirmed': True, 'projection_confirmed': True,
                'axis': {'from': [100, 100], 'to': [400, 100], 'real_cm': real_cm, 'source': 'SYNTHETIC TEST ONLY'}}]},
            'render': {'photo_id': 'synthetic', 'width': 1000, 'height': 500, 'scale': scale, 'visible': True},
            'distance_cm': distance_cm, 'mm_per_css_px': 0.25})
        expectations.append((real_cm, distance_cm, display_cm, expected_m))

    # Fixed hand-worked reference answers; no JavaScript function constructs the expected results.
    add(57.85, 150, 5.785, 15)
    add(57.85, 150, 2.8925, 30)
    add(57.85, 300, 5.785, 30)
    add(57.85, 150, 6, 14.4625)
    add(59, 150, 6, 14.75)
    add(50, 150, 6, 12.5)
    result = subprocess.run([node, str(ROOT / 'tests/reference_test.mjs'), '--oracle'],
                            input=json.dumps(cases), capture_output=True, text=True, check=True, timeout=30)
    for measured, (real, distance, display, expected) in zip(json.loads(result.stdout), expectations, strict=True):
        # Independent construction: recover metres from equality of the two full angular widths.
        half_angle = math.atan2(display * 10 / 2, distance * 10)
        angular_m = (real * 10 / 2) / math.tan(half_angle) / 1000
        assert angular_m == pytest.approx(expected, rel=1e-13)
        assert measured['equivalent_distance_m'] == pytest.approx(expected, rel=1e-13)
        assert measured['display_axis_cm'] == pytest.approx(display, rel=1e-13)


def test_approximate_production_images_independent_units():
    # Fixed numerical answers: silhouette width 240px / 800px, not full-file margins.
    cases = [
        ('skydroid_mx330t', 'skydroid_top', 416, 416, 1, 150, 6, 13.2175),
        ('skydroid_mx330t', 'skydroid_top', 416, 416, 0.5, 150, 3, 26.435),
        ('skydroid_mx330t', 'skydroid_top', 416, 416, 1, 300, 6, 26.435),
        ('gedz_10_dji', 'gedz_side', 800, 800, 1, 150, 20, 3.75),
        ('skydroid_mx330t', 'skydroid_front', 1000, 1000, 1, 150, 25, 3.1722),
    ]
    inputs = [{'model_id': model, 'render': {'photo_id': photo, 'width': w, 'height': h,
        'scale': scale, 'visible': True}, 'distance_cm': dist, 'mm_per_css_px': 0.25}
        for model, photo, w, h, scale, dist, display, expected in cases]
    result = subprocess.run(['node', str(ROOT / 'tests/reference_test.mjs'), '--estimate-oracle'],
        input=json.dumps(inputs), capture_output=True, text=True, check=True, timeout=30)
    for measured, case in zip(json.loads(result.stdout), cases, strict=True):
        *_, dist, display, expected = case
        assert measured['display_width_cm'] == pytest.approx(display)
        assert measured['equivalent_distance_m'] == pytest.approx(expected)
        half_angle = math.atan2(display / 2, dist)
        angular_m = (measured['assumed_extent_mm'] / 2000) / math.tan(half_angle)
        assert angular_m == pytest.approx(expected)
    # 3/4 uses a declared 45-degree assumption with W=528.7 and L=578.5 mm.
    inputs[0]['render'].update(photo_id='skydroid_oblique_candidate', width=800, height=800)
    measured = json.loads(subprocess.run(['node', str(ROOT / 'tests/reference_test.mjs'), '--estimate-oracle'],
        input=json.dumps(inputs[:1]), capture_output=True, text=True, check=True, timeout=30).stdout)[0]
    assert measured['assumed_extent_mm'] == pytest.approx(782.908628129758)
    assert measured['display_width_cm'] == pytest.approx(19.125)
    assert measured['equivalent_distance_m'] == pytest.approx(6.14045982846869)

"""Check reference assets, geometry and formula without network or a detector."""
import hashlib
import shutil
import subprocess
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
    }
    for name, digest in expected.items():
        assert hashlib.sha256((ROOT / 'reference_assets' / name).read_bytes()).hexdigest() == digest

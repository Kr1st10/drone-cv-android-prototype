"""Check the actual gallery calculations/exports with Node; no browser required."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_range_and_exports():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is required for gallery JavaScript checks')
    test = Path(__file__).with_name('range_test.mjs')
    result = subprocess.run([node, str(test)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr

"""Execute pure laboratory analysis tests; all observations are synthetic fixtures."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_experiment_analysis():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is required for laboratory JavaScript analysis tests')
    result = subprocess.run([node, str(Path(__file__).with_name('experiment_test.mjs'))],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr

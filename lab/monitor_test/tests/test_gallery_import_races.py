"""Deterministic import ordering in the real page; no downloaded images required."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_android_import_races():
    node = shutil.which('node')
    chromium = os.environ.get('CHROMIUM') or shutil.which('chromium') or shutil.which('chromium-browser')
    cwd = os.environ.get('PLAYWRIGHT_NODE_DIR', os.getcwd())
    if not node or not chromium or not (Path(cwd) / 'node_modules' / 'playwright').exists():
        pytest.skip('node/chromium/playwright not available (set PLAYWRIGHT_NODE_DIR)')
    result = subprocess.run([node, str(ROOT / 'tests' / 'gallery_import_race_test.mjs'), str(ROOT)],
                            cwd=cwd, capture_output=True, text=True, timeout=120,
                            env={**os.environ, 'CHROMIUM': chromium})
    assert result.returncode == 0, result.stdout + result.stderr

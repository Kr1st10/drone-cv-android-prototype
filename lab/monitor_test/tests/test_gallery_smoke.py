"""Runs gallery_smoke.mjs (Playwright + Chromium) when node, playwright and downloaded images are available."""
import os, shutil, subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_gallery_smoke():
    node, chromium = shutil.which('node'), shutil.which('chromium') or shutil.which('chromium-browser')
    cwd = os.environ.get('PLAYWRIGHT_NODE_DIR', os.getcwd())  # directory whose node_modules has playwright
    if not node or not chromium or not (Path(cwd) / 'node_modules' / 'playwright').exists():
        pytest.skip('node/chromium/playwright not available (set PLAYWRIGHT_NODE_DIR)')
    if not (ROOT / 'images').is_dir() or len(list((ROOT / 'images').iterdir())) < 90:
        pytest.skip('images not downloaded: python3 fetch_images.py')
    subprocess.run(['python3', str(ROOT / 'build_manifest.py'), '--write-js'], check=True, capture_output=True)
    r = subprocess.run([node, str(ROOT / 'tests' / 'gallery_smoke.mjs'), str(ROOT)], cwd=cwd, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout + r.stderr

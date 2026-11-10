"""Runs gallery_smoke.mjs (Playwright + Chromium) when node, playwright and downloaded images are available."""
import csv, json, os, shutil, subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('script', ['gallery_smoke.mjs', 'screen_smoke.mjs', 'product_smoke.mjs', 'reference_smoke.mjs', 'reference_trial_smoke.mjs'])
def test_gallery_smoke(script, tmp_path):
    node, chromium = shutil.which('node'), os.environ.get('CHROMIUM') or shutil.which('chromium') or shutil.which('chromium-browser')
    cwd = os.environ.get('PLAYWRIGHT_NODE_DIR', os.getcwd())  # directory whose node_modules has playwright
    if not node or not chromium or not (Path(cwd) / 'node_modules' / 'playwright').exists():
        pytest.skip('node/chromium/playwright not available (set PLAYWRIGHT_NODE_DIR)')
    if not (ROOT / 'images').is_dir() or len(list((ROOT / 'images').iterdir())) < 90:
        pytest.skip('images not downloaded: python3 fetch_images.py')
    subprocess.run(['python3', str(ROOT / 'build_manifest.py'), '--write-js'], check=True, capture_output=True)
    csv_file = tmp_path / 'screen-results.csv'
    r = subprocess.run([node, str(ROOT / 'tests' / script), str(ROOT)], cwd=cwd, capture_output=True, text=True, timeout=300,
                       env={**os.environ, 'SCREEN_CSV': str(csv_file)})
    assert r.returncode == 0, r.stdout + r.stderr
    if script == 'screen_smoke.mjs':
        with csv_file.open(newline='') as file:
            rows = list(csv.DictReader(file))
        assert len(rows) == 12 and all(None not in row for row in rows)
        first = rows[0]
        assert float(first['equivalent_distance_m']) == 30
        assert float(first['object_camera_width_px_measured']) == 12.5
        assert first['object_camera_width_px_expected'] == ''
        assert first['reference_status'] == 'conditional'
        assert json.loads(first['screen_calibration'])['mm_per_css_px'] == 0.25
        assert len(json.loads(first['object_bounds'])) == 4
        manual = next(row for row in rows if row['step'] == '10')
        assert manual['screen_width_source'] == 'manual'
        assert float(manual['screen_object_width_mm_measured']) == 12
        assert float(manual['screen_object_width_mm_calculated']) == 10

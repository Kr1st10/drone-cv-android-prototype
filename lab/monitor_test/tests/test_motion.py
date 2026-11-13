"""Moving-target browser and synthetic report regressions."""
import shutil
import subprocess
from pathlib import Path

import pytest
from test_gallery_smoke import test_gallery_smoke as run_gallery_smoke

ROOT = Path(__file__).resolve().parents[1]


def test_motion_browser(tmp_path):
    run_gallery_smoke('motion_smoke.mjs', tmp_path)


@pytest.mark.parametrize('script', ['motion_report_test.mjs', 'center_error_test.mjs', 'timeline_import_test.mjs'])
def test_motion_report(script):
    node = shutil.which('node')
    if not node:
        pytest.skip('node is not available')
    subprocess.run([node, str(ROOT / 'tests' / script)], check=True)

"""Moving-target browser and synthetic report regressions."""
import shutil
import subprocess
from pathlib import Path

import pytest
from test_gallery_smoke import test_gallery_smoke as run_gallery_smoke

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('script', ['motion_timeline_smoke.mjs', 'sync_check_smoke.mjs', 'motion_smoke.mjs', 'motion_auto_smoke.mjs', 'motion_calibration_jpeg_smoke.mjs', 'motion_calibration_real_smoke.mjs', 'motion_controls_smoke.mjs', 'motion_store_review_smoke.mjs', 'motion_report_review_smoke.mjs', 'motion_repeat_recovery_smoke.mjs', 'motion_start_cleanup_smoke.mjs'])
def test_motion_browser(script, tmp_path):
    run_gallery_smoke(script, tmp_path)


@pytest.mark.parametrize('script', ['motion_timeline_test.mjs', 'sync_check_end_test.mjs', 'sync_check_test.mjs', 'motion_report_test.mjs', 'center_error_test.mjs', 'timeline_import_test.mjs', 'motion_scenario_test.mjs', 'motion_calibration_test.mjs', 'motion_report_v4_test.mjs', 'motion_journal_status_test.mjs'])
def test_motion_report(script):
    node = shutil.which('node')
    if not node:
        pytest.skip('node is not available')
    subprocess.run([node, str(ROOT / 'tests' / script)], check=True)

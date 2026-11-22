"""Manual protocol, persistence and report regressions on an isolated gallery."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import quote

import pytest

ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_BROWSER_SCRIPTS = [
    'gallery_import_race_test.mjs',
    'motion_manual_browser_smoke.mjs',
    'motion_ab_lifecycle_smoke.mjs',
    'motion_ab_smoke.mjs',
    'motion_repeat_recovery_smoke.mjs',
    'motion_start_cleanup_smoke.mjs',
    'stage4_comparison_smoke.mjs',
]


def synthetic_gallery(directory):
    directory.mkdir()
    for source in [ROOT / 'gallery.html', *ROOT.glob('*.js')]:
        if source.name != 'manifest.js':
            shutil.copyfile(source, directory / source.name)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="gray"/></svg>'
    manifest = {
        'version': 'stage5-synthetic',
        'categories': {'civil_quadcopter': 'Синтетический снимок'},
        'images': [{
            'id': f'civ{index:02d}', 'category': 'civil_quadcopter', 'label': 'Синтетический снимок',
            'width': 96, 'height': 96, 'object_bbox': [12, 12, 84, 84],
            'file': 'data:image/svg+xml,' + quote(svg),
        } for index in (1, 2)],
    }
    contents = json.dumps(manifest, ensure_ascii=False)
    (directory / 'manifest.json').write_text(contents, encoding='utf-8')
    (directory / 'manifest.js').write_text('window.MANIFEST = ' + contents + ';\n', encoding='utf-8')
    return directory


@pytest.mark.parametrize('script', SYNTHETIC_BROWSER_SCRIPTS)
def test_gallery_synthetic_browser(script, tmp_path):
    node = shutil.which('node')
    requested_browser = os.environ.get('CHROMIUM')
    chromium = (shutil.which(requested_browser) if requested_browser
                else shutil.which('chromium') or shutil.which('chromium-browser'))
    if not chromium:
        pytest.skip(f'CHROMIUM недоступен или не исполняется: {requested_browser}' if requested_browser
                    else 'Chromium не найден в PATH. Укажите CHROMIUM.')
    cwd = os.environ.get('PLAYWRIGHT_NODE_DIR', os.getcwd())
    if not node or not (Path(cwd) / 'node_modules' / 'playwright').exists():
        pytest.skip('Недоступен Node или Playwright. Проверьте PLAYWRIGHT_NODE_DIR.')
    source = ROOT if script == 'stage4_comparison_smoke.mjs' else synthetic_gallery(tmp_path / 'gallery')
    result = subprocess.run([node, str(ROOT / 'tests' / script), str(source)],
                            cwd=cwd, capture_output=True, text=True, timeout=120,
                            env={**os.environ, 'CHROMIUM': str(Path(chromium).absolute())})
    assert result.returncode == 0, result.stdout + result.stderr


class Acceptance:
    passed = 0
    failed = 0

    def pytest_terminal_summary(self, terminalreporter):
        stats = terminalreporter.stats
        self.passed = len(stats.get('passed', []))
        self.failed = len(stats.get('failed', [])) + len(stats.get('error', []))


if __name__ == '__main__':
    acceptance = Acceptance()
    expected = len(SYNTHETIC_BROWSER_SCRIPTS)
    result = pytest.main(['-q', '-rs', str(Path(__file__).resolve())], plugins=[acceptance])
    not_run = max(0, expected - acceptance.passed - acceptance.failed)
    print(f'Прошло: {acceptance.passed} · Упало: {acceptance.failed} · Не выполнялось: {not_run}')
    raise SystemExit(int(result) or int(acceptance.passed != expected or acceptance.failed != 0))

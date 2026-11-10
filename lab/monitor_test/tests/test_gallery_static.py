"""Stage 6.6 gallery: static checks without a browser (offline, stdlib + pytest)."""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'gallery.html').read_text(encoding='utf-8')
MAN = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))


def test_no_network_resources():
    # Only local scripts and images; no CDN, fonts or remote scripts
    assert re.findall(r'<script[^>]*\ssrc="([^"]+)"', HTML) == ['manifest.js', 'experiment.js', 'reference_drones.js', 'motion.js', 'motion-ui.js']
    assert not re.search(r'<(?:img|script|link)[^>]*(?:src|href)="(https?:)?//', HTML)
    assert '@import' not in HTML and 'fetch(' not in HTML


def test_export_columns_match_template():
    cols = re.search(r"const COLS = \[(.*?)\];", HTML, re.S).group(1)
    cols = re.findall(r"'([a-z0-9_]+)'", cols)
    assert ','.join(cols) == (ROOT / 'results_template.csv').read_text(encoding='utf-8').strip()
    for c in ('sample_id', 'camera_zoom', 'distance_cm', 'detection', 'result_class',
              'object_monitor_px', 'object_camera_px_measured', 'object_yolo_px', 'max_confidence_pct'):
        assert c in cols


def test_pilot_preset_fits_manifest():
    m = re.search(r"const PILOT = \{ name: '([^']+)', seed: (\d+), counts: \{([^}]*)\}", HTML)
    assert m and m.group(1) == 'Пилот — 20 фото'
    counts = {k: int(v) for k, v in re.findall(r'(\w+): (\d+)', m.group(3))}
    assert counts == {'civil_quadcopter': 5, 'military_uav': 5, 'uav_payload': 3, 'bird': 3, 'aircraft': 2, 'negative': 2}
    avail = {}
    for im in MAN['images']:
        avail[im['category']] = avail.get(im['category'], 0) + 1
    assert set(counts) == set(MAN['categories']) and all(counts[c] <= avail[c] for c in counts)
    assert sum(counts.values()) == 20


def test_answer_not_revealed_by_record_or_hud():
    # record form and HUD must not print category / id / label before saving
    rec = re.search(r'function openRecord\(\) \{(.*?)\n\}', HTML, re.S).group(1)
    hud = re.search(r'function hud\(\) \{(.*?)\n\}', HTML, re.S).group(1)
    for body in (rec, hud):
        assert 'CAT_NAMES' not in body and '.category' not in body and '.label' not in body and 'm.id' not in body
    # A without a saved record only shows a hint
    ans = re.search(r'function showAnswer\(\) \{(.*?)\n\}', HTML, re.S).group(1)
    assert re.search(r"if \(!r\) \{[^}]*toast\([^}]*return; \}", ans)
    assert 'openRecord' not in ans

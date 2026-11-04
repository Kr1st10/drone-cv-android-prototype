"""Stage 6.6 lab set: manifest schema, counts, licenses, boxes, URL derivation (stdlib + pytest, offline)."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build_manifest as bm  # noqa: E402
import fetch_images as fi  # noqa: E402

MAN = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))


def test_manifest_valid_and_counts():
    assert bm.validate(MAN) == []
    assert len(MAN['images']) == 90


def test_validate_catches_errors():
    bad = json.loads(json.dumps(MAN))
    neg = next(m for m in bad['images'] if m['category'] == 'negative')
    neg['object_bbox'] = [0, 0, 10, 10]
    drone = next(m for m in bad['images'] if m['category'] == 'civil_quadcopter')
    drone['object_bbox'] = [0, 0, drone['width'] + 1, 5]
    pay = next(m for m in bad['images'] if m['category'] == 'uav_payload')
    pay['payload_evidence'] = ''
    bad['images'][1]['sha256'] = bad['images'][0]['sha256']
    bad['images'][2]['license'] = 'CC BY-NC 4.0'
    errs = '\n'.join(bm.validate(bad))
    for frag in ('negative must have no bbox', 'bbox', 'payload_evidence', 'duplicate', 'license'):
        assert frag in errs


def test_licenses_and_attribution():
    for m in MAN['images']:
        assert m['author'].strip()
        assert m['license'] in ('CC0', 'Public domain') or m['license'].startswith(('CC BY ', 'CC BY-SA '))


def test_independence_recorded():
    ind = MAN['independence']
    assert 'pathikg' in ind['references'][0] and 'dut' in ind['references'][1].lower()
    assert min(m['independence'][0] for m in MAN['images']) >= 2.0


def test_expand_urls():
    e = fi.expand({'id': 'x01', 'ext': '.jpg', 'thumb3840': True, 'commons_file': 'A, b (1) & c.jpg'})
    assert e['file'] == 'images/x01.jpg'
    assert e['original_url'].startswith('https://upload.wikimedia.org/wikipedia/commons/')
    assert e['original_url'].endswith('/A%2C_b_%281%29_%26_c.jpg')
    assert e['download_url'].endswith('/A%2C_b_%281%29_%26_c.jpg/3840px-A%2C_b_%281%29_%26_c.jpg')
    assert e['source_page'] == 'https://commons.wikimedia.org/wiki/File:A,_b_(1)_%26_c.jpg'
    long = fi.expand({'id': 'x02', 'ext': '.jpg', 'thumb3840': True, 'commons_file': 'L' * 200 + '.jpg'})
    assert long['download_url'].endswith('/3840px-thumbnail.jpg')
    orig = fi.expand({'id': 'x03', 'ext': '.png', 'thumb3840': False, 'commons_file': 'p.png'})
    assert orig['download_url'] == orig['original_url']


def test_manifest_js_roundtrip(tmp_path):
    out = fi.write_manifest_js(ROOT / 'manifest.json', tmp_path / 'manifest.js')
    text = out.read_text(encoding='utf-8')
    assert text.count('window.MANIFEST') == 2
    data = json.loads(text.split('window.MANIFEST = ', 1)[1].rstrip().rstrip(';'))
    assert len(data['images']) == 90 and all(m['file'].startswith('images/') for m in data['images'])


def test_fetch_verify_reports_missing(tmp_path, capsys):
    man = dict(MAN, images=MAN['images'][:2])
    p = tmp_path / 'manifest.json'; p.write_text(json.dumps(man), encoding='utf-8')
    assert fi.main(['--manifest', str(p), '--verify']) == 1
    assert 'missing 2' in capsys.readouterr().out

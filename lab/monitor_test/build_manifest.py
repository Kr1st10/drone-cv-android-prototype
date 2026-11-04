#!/usr/bin/env python3
"""Validate manifest.json (stdlib only); optionally write manifest.js for the offline gallery.

manifest.json is the source of truth. It was curated in Stage 6.6 from Wikimedia Commons metadata
(author, license, source page, SHA-1), downloaded files (SHA-256, size), object boxes (union of YOLO
proposals from the baseline drone model and COCO YOLO11x, visually checked by the agent) and the
independence check against reference datasets (see manifest.json -> independence).

    python3 build_manifest.py            # validate
    python3 build_manifest.py --write-js # validate + write manifest.js (fetch_images.py does this too)

Compact entries store the Commons file name; URLs, local file name and label are derived by
fetch_images.expand(). manifest.js and images/ are generated locally and not committed.
"""
import argparse, json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_images import expand, write_manifest_js  # noqa: E402

HERE = Path(__file__).resolve().parent
CATEGORIES = ['civil_quadcopter', 'military_uav', 'uav_payload', 'bird', 'aircraft', 'negative']
TARGET = {'civil_quadcopter': 20, 'military_uav': 20, 'uav_payload': 10, 'bird': 15, 'aircraft': 15, 'negative': 10}
LICENSE_RE = re.compile(r'^(CC0|Public domain|CC BY(-SA)? [0-9.]+( [a-z]{2})?)$')
REQUIRED = ['id', 'category', 'commons_file', 'ext', 'width', 'height', 'sha256', 'thumb3840', 'original_sha1',
            'author', 'license', 'license_url', 'object_bbox', 'object_count', 'independence']


def validate(man):
    errs = []
    if list(man.get('categories', {})) != CATEGORIES: errs.append('categories order/ids')
    seen_id, seen_sha, seen_src = set(), set(), set()
    count = {c: 0 for c in CATEGORIES}
    for m in man['images']:
        i = m.get('id', '?')
        miss = [k for k in REQUIRED if k not in m]
        if miss: errs.append(f'{i}: missing {miss}'); continue
        if m['category'] not in CATEGORIES: errs.append(f'{i}: category'); continue
        count[m['category']] += 1
        e = expand(m)
        for s, v in ((seen_id, i), (seen_sha, m['sha256']), (seen_src, m['commons_file'])):
            if v in s: errs.append(f'{i}: duplicate {v}')
            s.add(v)
        if not re.fullmatch(r'[0-9a-f]{64}', m['sha256']): errs.append(f'{i}: sha256')
        if not re.fullmatch(r'[0-9a-f]{40}', m['original_sha1']): errs.append(f'{i}: sha1')
        if m['ext'] not in ('.jpg', '.png') or not re.fullmatch(r'[a-z]+\d\d', i): errs.append(f'{i}: id/ext')
        if m['thumb3840'] and m['width'] != 3840: errs.append(f'{i}: thumb3840 but width {m["width"]}')
        for u in ('download_url', 'original_url', 'source_page'):
            if not e[u].startswith('https://'): errs.append(f'{i}: {u}')
        if not LICENSE_RE.match(m['license']) or 'NC' in m['license'] or 'ND' in m['license']: errs.append(f'{i}: license {m["license"]}')
        if m['license'] != 'Public domain' and not m.get('license_url'): errs.append(f'{i}: license_url')
        if not m['author'].strip(): errs.append(f'{i}: author')
        b = m['object_bbox']
        if m['category'] == 'negative':
            if b is not None or m['object_count'] != 0: errs.append(f'{i}: negative must have no bbox')
        else:
            if not (isinstance(b, list) and len(b) == 4 and 0 <= b[0] < b[2] <= m['width'] and 0 <= b[1] < b[3] <= m['height']):
                errs.append(f'{i}: bbox {b}')
            if m['object_count'] < 1: errs.append(f'{i}: object_count')
        if m['category'] == 'uav_payload' and not (m.get('payload_evidence') or '').strip(): errs.append(f'{i}: payload_evidence')
        if m['independence'][0] < 2.0: errs.append(f'{i}: near-duplicate of reference set')
    if count != TARGET: errs.append(f'counts {count}')
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--write-js', action='store_true')
    a = ap.parse_args(argv)
    path = HERE / 'manifest.json'; man = json.loads(path.read_text(encoding='utf-8'))
    errs = validate(man)
    if errs: print('\n'.join(errs)); return 1
    if a.write_js: print('wrote', write_manifest_js(path))
    print('manifest OK:', len(man['images']), 'images'); return 0


if __name__ == '__main__':
    sys.exit(main())

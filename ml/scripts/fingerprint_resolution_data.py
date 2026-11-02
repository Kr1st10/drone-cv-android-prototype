#!/usr/bin/env python3
"""Fingerprint precisely the files consumed for the selected 4.2 dataset."""
import hashlib
import json
from resolution_experiment import ML, OUT, sha256
from sahi_experiment import load_subset

def main():
    subset=load_subset()
    paths=[]
    for item in subset['positives']:
        paths.extend([ML/'data/pathikg_test/images'/item['file'],
                      ML/'data/pathikg_test/labels'/item['file'].replace('.jpg','.txt')])
    paths.extend(ML/'data/coco_neg/images'/item['file'] for item in subset['negatives'])
    digest=hashlib.sha256()
    for path in paths:
        digest.update(str(path.relative_to(ML)).encode()); digest.update(b'\0')
        digest.update(bytes.fromhex(sha256(path)))
    expected=json.loads((OUT/'input_manifest.json').read_text())
    actual=digest.hexdigest()
    print(f'{len(paths)} files: {actual}')
    if len(paths)!=expected['files'] or actual!=expected['sha256']:
        raise SystemExit('Input fingerprint does not match committed manifest')
    print('Input fingerprint verified.')

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""Check whether the pathikg test split overlaps with its train split.

Downloads the 9 train shards (~4.4 GB) of the pinned dataset revision into ml/data/cache/ and compares:
  * original file names (image.path) and their video/sequence prefix;
  * exact image bytes (SHA-1);
  * perceptual near-duplicates: 64-bit dHash, Hamming distance <= --max-hamming.
Writes ml/results/split_overlap.json.

Note: this only checks train<->test of the public dataset. The model author does not publish which
split was used for training/validation, so even zero overlap would not prove independence.

Usage: python ml/scripts/check_split_overlap.py [--max-hamming 4]
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_eval_data import DATA, DS_REV, DS_TEST_URL, download  # noqa: E402

ML_DIR = Path(__file__).resolve().parents[1]
TRAIN_URL = (f"https://huggingface.co/datasets/pathikg/drone-detection-dataset/resolve/{DS_REV}"
             "/data/train-{:05d}-of-00009.parquet")


def dhash(jpeg: bytes) -> int:
    import cv2

    g = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
    s = cv2.resize(g, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (s[:, 1:] > s[:, :-1]).flatten()
    return int(np.packbits(bits).view(">u8")[0])


def prefix(name: str) -> str:
    """Sequence prefix of an original file name, e.g. 'VS_P582.jpg' -> 'VS_P'."""
    stem = Path(name).stem
    return re.sub(r"\d+$", "", stem)


def scan(path: Path):
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(columns=["image", "image_id"], batch_size=256):
        for row in batch.to_pylist():
            b = row["image"]["bytes"]
            yield row["image_id"], row["image"]["path"], hashlib.sha1(b).hexdigest(), dhash(b)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-hamming", type=int, default=4)
    args = ap.parse_args()
    test = list(scan(download(DS_TEST_URL, DATA / "cache" / "pathikg_test.parquet")))
    train = []
    for i in range(9):
        p = download(TRAIN_URL.format(i), DATA / "cache" / f"pathikg_train_{i}.parquet")
        train += list(scan(p))
        print(f"[overlap] shard {i}: total train rows {len(train)}", flush=True)

    tr_names = collections.Counter(t[1] for t in train)
    tr_sha = {t[2] for t in train}
    tr_pref = collections.Counter(prefix(t[1]) for t in train)
    te_pref = collections.Counter(prefix(t[1]) for t in test)
    tr_h = np.array([t[3] for t in train], dtype=np.uint64)

    near, min_dists = [], []
    for img_id, name, _, h in test:
        x = np.bitwise_xor(tr_h, np.uint64(h))
        d = np.unpackbits(x.view(np.uint8).reshape(-1, 8), axis=1).sum(1)
        j = int(d.argmin()); min_dists.append(int(d[j]))
        if d[j] <= args.max_hamming:
            near.append({"test_image_id": img_id, "test_path": name, "train_path": train[j][1], "hamming": int(d[j])})
    md = np.array(min_dists)
    res = {
        "dataset_revision": DS_REV, "train_images": len(train), "test_images": len(test),
        "test_names_also_in_train": sum(1 for t in test if t[1] in tr_names),
        "test_exact_byte_duplicates_in_train": sum(1 for t in test if t[2] in tr_sha),
        "test_near_duplicates_dhash": {"max_hamming": args.max_hamming, "count": len(near),
                                       "fraction": len(near) / len(test)},
        "test_min_hamming_histogram": {str(k): int((md == k).sum()) for k in range(0, 11)} | {">10": int((md > 10).sum())},
        "sequence_prefixes": {"test": dict(te_pref.most_common()),
                              "train_count_for_test_prefixes": {p: tr_pref.get(p, 0) for p in te_pref}},
        "near_duplicate_examples": near[:30],
    }
    out = ML_DIR / "results" / "split_overlap.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "near_duplicate_examples"}, indent=1))


if __name__ == "__main__":
    main()

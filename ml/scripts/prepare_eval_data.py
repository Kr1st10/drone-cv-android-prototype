#!/usr/bin/env python3
"""Download and prepare evaluation data (git-ignored, under ml/data/).

1) Positive, labelled set: test split of HF dataset `pathikg/drone-detection-dataset`
   (MIT, pinned revision). Written in Ultralytics YOLO format:
   ml/data/pathikg_test/{images,labels}/*.{jpg,txt} + dataset.yaml + index.json
   NOTE: this split is NOT an independent test set for this model, see ml/MODEL.md.

2) Negative set (no drones expected): COCO val2017 images. `--neg-hard` images that contain
   bird / airplane / kite (sky-like hard negatives) and `--neg-random` images without them,
   chosen deterministically (seed). Written to ml/data/coco_neg/images/*.jpg + index.json.
   COCO has no "drone" category, so the absence of drones is assumed, not guaranteed;
   every false positive must be inspected visually.

Usage: python ml/scripts/prepare_eval_data.py [--neg-hard 100] [--neg-random 100]
"""
from __future__ import annotations

import argparse
import io
import json
import random
import urllib.request
import zipfile
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data"
DS_REV = "004b46cc181ecdcabd715753c2c5346d869c0044"
DS_TEST_URL = (f"https://huggingface.co/datasets/pathikg/drone-detection-dataset/resolve/{DS_REV}"
               "/data/test-00000-of-00001.parquet")
COCO_ANN_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
COCO_IMG_URL = "http://images.cocodataset.org/val2017/{:012d}.jpg"
HARD_CATS = {"bird", "airplane", "kite"}


def download(url: str, dst: Path) -> Path:
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        print(f"[download] {url}")
        tmp = dst.with_suffix(dst.suffix + ".part")
        with urllib.request.urlopen(url) as r, tmp.open("wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        tmp.replace(dst)
    return dst


def prepare_pathikg() -> None:
    import pyarrow.parquet as pq

    out = DATA / "pathikg_test"
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "labels").mkdir(parents=True, exist_ok=True)
    pq_path = download(DS_TEST_URL, DATA / "cache" / "pathikg_test.parquet")
    t = pq.read_table(pq_path)
    index, n_boxes, n_clipped = [], 0, 0
    for row in t.to_pylist():
        w, h = row["width"], row["height"]
        name = f"{row['image_id']:05d}.jpg"
        (out / "images" / name).write_bytes(row["image"]["bytes"])
        lines = []
        for (x, y, bw, bh), c in zip(row["objects"]["bbox"], row["objects"]["category"]):
            x1, y1 = max(0.0, x), max(0.0, y)
            x2, y2 = min(float(w), x + bw), min(float(h), y + bh)
            if (x1, y1, x2, y2) != (x, y, x + bw, y + bh):
                n_clipped += 1
            if x2 <= x1 or y2 <= y1:
                continue
            lines.append(f"{c} {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} "
                         f"{(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}")
            n_boxes += 1
        (out / "labels" / name.replace(".jpg", ".txt")).write_text("\n".join(lines) + ("\n" if lines else ""))
        index.append({"file": name, "image_id": row["image_id"], "source_path": row["image"]["path"],
                      "width": w, "height": h})
    (out / "index.json").write_text(json.dumps({"dataset": "pathikg/drone-detection-dataset",
                                                "revision": DS_REV, "split": "test",
                                                "images": index}, indent=1))
    (out / "dataset.yaml").write_text(f"path: {out}\ntrain: images\nval: images\nnames:\n  0: drone\n")
    print(f"[pathikg] images={len(index)} boxes={n_boxes} clipped_boxes={n_clipped} -> {out}")


def prepare_coco_neg(n_hard: int, n_random: int, seed: int) -> None:
    out = DATA / "coco_neg"
    (out / "images").mkdir(parents=True, exist_ok=True)
    zpath = download(COCO_ANN_URL, DATA / "cache" / "annotations_trainval2017.zip")
    with zipfile.ZipFile(zpath) as z:
        ann = json.load(io.BytesIO(z.read("annotations/instances_val2017.json")))
    cats = {c["id"]: c["name"] for c in ann["categories"]}
    per_img: dict[int, set[str]] = {}
    for a in ann["annotations"]:
        per_img.setdefault(a["image_id"], set()).add(cats[a["category_id"]])
    all_ids = sorted(i["id"] for i in ann["images"])
    hard = [i for i in all_ids if per_img.get(i, set()) & HARD_CATS]
    other = [i for i in all_ids if not (per_img.get(i, set()) & HARD_CATS)]
    rng = random.Random(seed)
    chosen = [("hard", i) for i in rng.sample(hard, n_hard)] + [("random", i) for i in rng.sample(other, n_random)]
    index = []
    for kind, i in chosen:
        name = f"{i:012d}.jpg"
        download(COCO_IMG_URL.format(i), out / "images" / name)
        index.append({"file": name, "coco_id": i, "subset": kind, "coco_categories": sorted(per_img.get(i, []))})
    (out / "index.json").write_text(json.dumps({"dataset": "COCO val2017", "seed": seed, "images": index}, indent=1))
    print(f"[coco_neg] hard={n_hard} random={n_random} -> {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--neg-hard", type=int, default=100)
    ap.add_argument("--neg-random", type=int, default=100)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--skip-pathikg", action="store_true")
    ap.add_argument("--skip-coco", action="store_true")
    args = ap.parse_args()
    if not args.skip_pathikg:
        prepare_pathikg()
    if not args.skip_coco:
        prepare_coco_neg(args.neg_hard, args.neg_random, args.seed)


if __name__ == "__main__":
    main()

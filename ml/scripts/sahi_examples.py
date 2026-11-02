#!/usr/bin/env python3
"""Pick characteristic gains / regressions of a SAHI mode vs baseline from sahi_eval.json.

Writes ml/results/sahi/examples.json (file names + boxes, committed) and, with --render, side-by-side
crops to ml/results/sahi/examples/ (git-ignored: source frames are third-party YouTube/COCO images).

Usage: python ml/scripts/sahi_examples.py [--mode sahi_320_ov0.2_full] [--conf 0.25] [--n 4] [--render]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drone_detector as dd  # noqa: E402
from evaluate import load_gt  # noqa: E402
from sahi_experiment import DATA, OUT_DIR, load_subset  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="sahi_320_ov0.2_full")
    ap.add_argument("--conf", default="0.25")
    ap.add_argument("--n", type=int, default=4)
    ap.add_argument("--render", action="store_true")
    a = ap.parse_args()
    data = json.loads((OUT_DIR / "sahi_eval.json").read_text())
    b, s = data["results"]["baseline"][a.conf], data["results"][a.mode][a.conf]
    sizes = data["gt_sizes"]
    sub = {p["file"]: p for p in load_subset()["positives"]}
    gained, lost, new_fp_neg = [], [], []
    for f, r in s.items():
        if r["kind"] == "pos":
            for i, (h, hb) in enumerate(zip(r["gt_hit"], b[f]["gt_hit"])):
                rec = {"file": f, "source_path": sub[f]["source_path"], "gt_index": i, "gt_px": sizes[f][i],
                       "baseline_boxes": b[f]["boxes"], "sahi_boxes": r["boxes"]}
                if h and not hb:
                    gained.append(rec)
                elif hb and not h:
                    lost.append(rec)
        elif r["fp"] > b[f]["fp"]:
            new_fp_neg.append({"file": f, "baseline_boxes": b[f]["boxes"], "sahi_boxes": r["boxes"]})
    gained.sort(key=lambda x: x["gt_px"]); lost.sort(key=lambda x: x["gt_px"])
    new_fp_neg.sort(key=lambda x: -max(bb[4] for bb in x["sahi_boxes"]))
    pick = lambda L: L[: a.n // 2] + L[len(L) // 2: len(L) // 2 + a.n - a.n // 2] if len(L) > a.n else L
    out = {"mode": a.mode, "conf": float(a.conf), "counts": {"gained_gt": len(gained), "lost_gt": len(lost),
                                                             "negatives_with_more_fp": len(new_fp_neg)},
           "gained": pick(gained), "lost": pick(lost), "new_fp_on_negatives": new_fp_neg[: a.n]}
    (OUT_DIR / "examples.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out["counts"]))
    if a.render:
        import cv2
        ed = OUT_DIR / "examples"; ed.mkdir(exist_ok=True)
        def panel(img, boxes, gt, title):
            im = cv2.cvtColor(img, cv2.COLOR_RGB2BGR).copy()
            for g in gt:
                cv2.rectangle(im, (int(g[0]), int(g[1])), (int(g[2]), int(g[3])), (0, 255, 0), 1)
            for x1, y1, x2, y2, sc in boxes:
                cv2.rectangle(im, (int(x1), int(y1)), (int(x2), int(y2)), (0, 0, 255), 1)
                cv2.putText(im, f"{sc:.2f}", (int(x1), max(10, int(y1) - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.4,
                            (0, 0, 255), 1, cv2.LINE_AA)
            cv2.putText(im, title, (5, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)
            return im
        for kind in ("gained", "lost", "new_fp_on_negatives"):
            for k, e in enumerate(out[kind]):
                folder = "coco_neg" if kind == "new_fp_on_negatives" else "pathikg_test"
                img = dd.load_rgb(DATA / folder / "images" / e["file"])
                gt = np.zeros((0, 4)) if folder == "coco_neg" else load_gt(
                    DATA / folder / "labels" / e["file"].replace(".jpg", ".txt"), img.shape[1], img.shape[0])
                row = np.hstack([panel(img, e["baseline_boxes"], gt, "baseline"),
                                 panel(img, e["sahi_boxes"], gt, a.mode)])
                cv2.imwrite(str(ed / f"{kind}_{k}_{e['file']}"), row)


if __name__ == "__main__":
    main()

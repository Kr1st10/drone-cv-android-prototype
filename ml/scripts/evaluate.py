#!/usr/bin/env python3
"""Verify the exported ONNX model: real predictions, PyTorch parity, P/R/AP50, negatives.

Requires: ml/scripts/fetch_and_export.py and ml/scripts/prepare_eval_data.py to have been run.

Usage:
    python ml/scripts/evaluate.py [--parity-n 300] [--limit N] [--out ml/results/eval_onnx.json]

Checks:
  * ONNX pipeline (drone_detector.py) on the labelled pathikg test split:
    P / R / F1 at conf=0.25, IoU>=0.5 (greedy one-to-one matching by score),
    AP50 (COCO-style 101-point interpolation, conf>=0.001), recall by GT size.
  * Parity on the first --parity-n images:
      a) raw output tensor of PyTorch (best.pt, FP32) vs ONNX Runtime on the SAME input tensor;
      b) final boxes of the ONNX pipeline vs Ultralytics' own `YOLO("best.pt").predict`
         (independent reference for pre-processing, decoding, NMS and coordinate mapping).
  * COCO val2017 negatives (no drone category): number of images with >=1 detection at conf=0.25.
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drone_detector as dd  # noqa: E402

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data"
PT = ML_DIR / "weights" / "best.pt"
ONNX = ML_DIR / "weights" / "yolo11s-drone-640.onnx"
SWEEP = (0.25, 0.35, 0.5, 0.6, 0.7, 0.8)


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0]); y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2]); y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1]); ab = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    union = aa[:, None] + ab[None, :] - inter
    # Preserve IoU == threshold exactly while keeping degenerate boxes safe.
    return np.divide(inter, union, out=np.zeros_like(inter, dtype=float), where=union > 0)


def match(pred: np.ndarray, scores: np.ndarray, gt: np.ndarray, thr: float = 0.5):
    """Greedy matching by descending score. Returns (tp flags per pred, matched gt flags, ious of TPs)."""
    order = np.argsort(-scores, kind="stable")
    ious = iou_matrix(pred, gt)
    tp = np.zeros(len(pred), bool); used = np.zeros(len(gt), bool); tp_iou = []
    for i in order:
        if len(gt) == 0:
            break
        cand = np.where(~used, ious[i], -1)
        j = int(cand.argmax())
        if cand[j] >= thr:
            tp[i] = True; used[j] = True; tp_iou.append(float(cand[j]))
    return tp, used, tp_iou


def load_gt(label_file: Path, w: int, h: int) -> np.ndarray:
    rows = [l.split() for l in label_file.read_text().splitlines() if l.strip()]
    if not rows:
        return np.zeros((0, 4))
    a = np.array([[float(v) for v in r[1:5]] for r in rows])
    cx, cy, bw, bh = a[:, 0] * w, a[:, 1] * h, a[:, 2] * w, a[:, 3] * h
    return np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1)


def ap101(tp: np.ndarray, scores: np.ndarray, n_gt: int) -> float:
    order = np.argsort(-scores, kind="stable")
    tp = tp[order].astype(float)
    ctp, cfp = np.cumsum(tp), np.cumsum(1 - tp)
    rec = ctp / max(n_gt, 1); prec = ctp / np.maximum(ctp + cfp, 1e-9)
    prec = np.maximum.accumulate(prec[::-1])[::-1]
    return float(np.mean([prec[rec >= t].max() if np.any(rec >= t) else 0.0 for t in np.linspace(0, 1, 101)]))


def to_arr(dets):
    return (np.array([[d.x1, d.y1, d.x2, d.y2] for d in dets]).reshape(-1, 4),
            np.array([d.score for d in dets]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou-nms", type=float, default=0.7)
    ap.add_argument("--parity-n", type=int, default=300)
    ap.add_argument("--limit", type=int, default=0, help="evaluate only the first N test images")
    ap.add_argument("--out", default=str(ML_DIR / "results" / "eval_onnx.json"))
    args = ap.parse_args()

    import onnxruntime as ort
    det = dd.DroneDetector(ONNX)
    ds = DATA / "pathikg_test"
    index = json.loads((ds / "index.json").read_text())["images"]
    if args.limit:
        index = index[: args.limit]

    # ---------- 1. ONNX pipeline on labelled set ----------
    all_tp, all_sc, n_gt, lat = [], [], 0, []
    tp_c = fp_c = 0; tp_ious = []; gt_sizes, gt_hit = [], []
    per_image = []
    sweep_cnt = {t: [0, 0] for t in SWEEP}
    t_start = time.time()
    for k, it in enumerate(index):
        img = dd.load_rgb(ds / "images" / it["file"])
        gt = load_gt(ds / "labels" / it["file"].replace(".jpg", ".txt"), img.shape[1], img.shape[0])
        x, info = dd.preprocess(img)
        t0 = time.perf_counter(); raw = det.raw(x); lat.append(time.perf_counter() - t0)
        dets_low = dd.postprocess(raw, info, conf=0.001, iou=args.iou_nms)
        pb, ps = to_arr(dets_low)
        tp, _, _ = match(pb, ps, gt)
        all_tp.append(tp); all_sc.append(ps); n_gt += len(gt)
        for thr in SWEEP:
            mm = ps > thr
            t3, _, _ = match(pb[mm], ps[mm], gt)
            sweep_cnt[thr][0] += int(t3.sum()); sweep_cnt[thr][1] += int((~t3).sum())
        m = ps > args.conf
        tp2, used2, ious2 = match(pb[m], ps[m], gt)
        tp_c += int(tp2.sum()); fp_c += int((~tp2).sum()); tp_ious += ious2
        gt_sizes += list(np.sqrt((gt[:, 2] - gt[:, 0]) * (gt[:, 3] - gt[:, 1]))); gt_hit += list(used2)
        per_image.append({"file": it["file"], "n_gt": int(len(gt)), "n_pred": int(m.sum()),
                          "tp": int(tp2.sum())})
        if k % 500 == 0:
            print(f"[eval] {k}/{len(index)}", flush=True)
    tp_all, sc_all = np.concatenate(all_tp), np.concatenate(all_sc)
    fn_c = n_gt - tp_c
    P = tp_c / max(tp_c + fp_c, 1); R = tp_c / max(n_gt, 1)
    gt_sizes, gt_hit = np.array(gt_sizes), np.array(gt_hit)
    buckets = {"<16px": (0, 16), "16-32px": (16, 32), "32-96px": (32, 96), ">=96px": (96, 1e9)}
    by_size = {k: {"n_gt": int(((gt_sizes >= a) & (gt_sizes < b)).sum()),
                   "recall": float(gt_hit[(gt_sizes >= a) & (gt_sizes < b)].mean())
                   if ((gt_sizes >= a) & (gt_sizes < b)).any() else None}
               for k, (a, b) in buckets.items()}
    labelled = {
        "dataset": "pathikg/drone-detection-dataset test split (NOT independent, see MODEL.md)",
        "images": len(index), "gt_boxes": int(n_gt), "conf": args.conf, "iou_nms": args.iou_nms,
        "match_iou": 0.5, "tp": tp_c, "fp": fp_c, "fn": int(fn_c),
        "precision": P, "recall": R, "f1": 2 * P * R / max(P + R, 1e-9),
        "ap50_101pt": ap101(tp_all, sc_all, n_gt), "mean_iou_tp": float(np.mean(tp_ious)) if tp_ious else None,
        "threshold_sweep": {str(t): {"precision": c[0] / max(c[0] + c[1], 1), "recall": c[0] / max(n_gt, 1),
                                     "tp": c[0], "fp": c[1]} for t, c in sweep_cnt.items()},
        "images_without_predictions": sum(1 for p in per_image if p["n_pred"] == 0),
        "recall_by_gt_size_sqrt_area": by_size,
        "onnx_latency_ms_cpu_sandbox": {"mean": 1000 * float(np.mean(lat)), "p50": 1000 * float(np.median(lat))},
        "wall_time_s": time.time() - t_start,
    }
    print(json.dumps(labelled, indent=2), flush=True)

    # ---------- 2. Parity ----------
    import torch
    from ultralytics import YOLO
    yolo_pt = YOLO(str(PT))
    tm = yolo_pt.model.float().eval()
    max_box_diff = max_score_diff = 0.0; box_diffs, score_diffs = [], []
    ref_total = onnx_total = ref_matched = 0; ref_box_err, ref_score_err = [], []
    n_par = min(args.parity_n, len(index))
    for it in index[:n_par]:
        img = dd.load_rgb(ds / "images" / it["file"])
        x, info = dd.preprocess(img)
        r_onnx = det.raw(x)
        with torch.no_grad():
            r_pt = tm(torch.from_numpy(x))
            r_pt = (r_pt[0] if isinstance(r_pt, (list, tuple)) else r_pt).numpy()
        d = np.abs(r_onnx - r_pt)
        max_box_diff = max(max_box_diff, float(d[0, :4].max())); max_score_diff = max(max_score_diff, float(d[0, 4:].max()))
        box_diffs.append(float(d[0, :4].mean())); score_diffs.append(float(d[0, 4:].mean()))
        # b) Ultralytics reference pipeline on .pt (square letterbox via rect=False)
        res = yolo_pt.predict(img[:, :, ::-1].copy(), imgsz=640, conf=args.conf, iou=args.iou_nms,
                              rect=False, verbose=False, device="cpu")[0]
        rb = res.boxes.xyxy.numpy(); rs = res.boxes.conf.numpy()
        ob, os_ = to_arr(dd.postprocess(r_onnx, info, args.conf, args.iou_nms))
        ref_total += len(rb); onnx_total += len(ob)
        if len(rb) and len(ob):
            ious = iou_matrix(rb, ob)
            for i in range(len(rb)):
                j = int(ious[i].argmax())
                if ious[i, j] > 0.9:
                    ref_matched += 1
                    ref_box_err.append(float(np.abs(rb[i] - ob[j]).max())); ref_score_err.append(float(abs(rs[i] - os_[j])))
    parity = {
        "images": n_par,
        "raw_tensor_pt_fp32_vs_onnx": {"max_abs_diff_box_px": max_box_diff, "mean_abs_diff_box_px": float(np.mean(box_diffs)),
                                       "max_abs_diff_score": max_score_diff, "mean_abs_diff_score": float(np.mean(score_diffs))},
        "ultralytics_pt_predict_vs_onnx_pipeline": {
            "ref_boxes": ref_total, "onnx_boxes": onnx_total, "matched_iou_gt_0.9": ref_matched,
            "max_abs_coord_diff_px": max(ref_box_err) if ref_box_err else None,
            "max_abs_score_diff": max(ref_score_err) if ref_score_err else None},
    }
    print(json.dumps(parity, indent=2), flush=True)

    # ---------- 3. Negatives ----------
    neg_dir = DATA / "coco_neg"
    neg = {"available": neg_dir.exists()}
    if neg_dir.exists():
        nidx = json.loads((neg_dir / "index.json").read_text())["images"]
        hits = []
        for it in nidx:
            img = dd.load_rgb(neg_dir / "images" / it["file"])
            dets = det.detect(img, min(SWEEP), args.iou_nms)
            if dets:
                hits.append({"file": it["file"], "subset": it["subset"], "coco_categories": it["coco_categories"],
                             "detections": [asdict(d) for d in dets]})
        for sub in ("hard", "random"):
            n = sum(1 for i in nidx if i["subset"] == sub)
            k = sum(1 for h in hits if h["subset"] == sub)
            neg[sub] = {"images": n, "images_with_detections": k,
                        "detections": sum(len(h["detections"]) for h in hits if h["subset"] == sub)}
        neg["threshold_sweep_images_with_detections"] = {
            str(t): {sub: sum(1 for h in hits if h["subset"] == sub and any(d["score"] > t for d in h["detections"]))
                     for sub in ("hard", "random")} for t in SWEEP}
        neg["conf"] = min(SWEEP)
        neg["hits"] = hits
        print(json.dumps({k: v for k, v in neg.items() if k != "hits"}, indent=2), flush=True)

    out = {"labelled": labelled, "parity": parity, "negatives": neg, "per_image": per_image,
           "env": {"python": platform.python_version(), "onnxruntime": ort.__version__, "torch": torch.__version__,
                   "ultralytics": __import__("ultralytics").__version__,
                   "onnx_sha256": json.loads((ML_DIR / "weights" / "export_info.json").read_text())["onnx_sha256"]}}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=1))
    print(f"[eval] wrote {args.out}")


if __name__ == "__main__":
    main()

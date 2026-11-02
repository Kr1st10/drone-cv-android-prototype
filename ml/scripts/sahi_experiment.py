#!/usr/bin/env python3
"""Stage 4.1: does SAHI slicing help the existing YOLO11s drone detector on small drones, and at what cost?

Compares, on the SAME images and the SAME ONNX model (ml/weights/yolo11s-drone-640.onnx):
  * baseline  - one full-frame inference (drone_detector.py: letterbox 640 -> ORT -> NMS 0.7);
  * SAHI      - official obss/sahi `get_sliced_prediction` (slicing, shift to full-image coordinates,
                cross-slice merging) around the same reference pre/post-processing.

Each slice is letterboxed to 640 by drone_detector.preprocess, i.e. a 320 px slice is up-scaled x2.
Merging: SAHI GREEDYNMM, class-agnostic, IOS >= 0.5 (SAHI defaults; IOS also merges a partial
fragment box that lies inside a fuller box from a neighbouring slice or the full-frame pass).
Ablation `*_iou`: the same with IOU >= 0.5.

Usage (after fetch_and_export.py and prepare_eval_data.py):
    python ml/scripts/sahi_experiment.py select            # deterministic subset -> ml/results/sahi/subset.json
    python ml/scripts/sahi_experiment.py run [--limit N] [--only MODE ...]   # -> ml/results/sahi/sahi_eval.json
    python ml/scripts/sahi_experiment.py report            # -> ml/results/sahi/REPORT_TABLES.md
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drone_detector as dd  # noqa: E402
from evaluate import iou_matrix, load_gt, match  # noqa: E402

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data"
OUT_DIR = ML_DIR / "results" / "sahi"
ONNX = ML_DIR / "weights" / "yolo11s-drone-640.onnx"
NMS_IOU = 0.7          # within one inference, same as baseline / Android
MATCH_IOU = 0.5        # TP if IoU >= 0.5 with an unmatched GT (greedy by score, evaluate.match)
CONFS = (0.25, 0.5)    # 0.25 = earlier evaluation in SUMMARY.md, 0.5 = Android default
SIZE_BUCKETS = {"<16px": (0, 16), "16-24px": (16, 24), "24-32px": (24, 32),
                "32-96px": (32, 96), ">=96px": (96, 1e9)}
# Known test<->train near duplicates listed in ml/results/split_overlap.json (examples only, 30 of 78).
KNOWN_NEAR_DUP_IDS = {23, 41, 125, 142, 183, 185, 215, 217, 306, 330, 360, 370, 391, 400, 467, 499, 503,
                      523, 535, 548, 550, 554, 643, 673, 715, 824, 832, 852, 877, 885}


@dataclass(frozen=True)
class Mode:
    name: str
    slice: int | None = None       # None = baseline full-frame
    overlap: float = 0.2
    full_pass: bool = True         # SAHI perform_standard_pred
    merge_metric: str = "IOS"      # GREEDYNMM match metric, threshold 0.5


MODES = (
    Mode("baseline"),
    Mode("sahi_320_ov0.2_full", 320, 0.2, True),
    Mode("sahi_320_ov0.2_tiles", 320, 0.2, False),
    Mode("sahi_416_ov0.2_full", 416, 0.2, True),
    # Ablation added after the first run: IOS merged true small boxes into large false boxes that
    # contain them (see REPORT.md); IOU does not merge a small box into a much larger one.
    Mode("sahi_416_ov0.2_full_iou", 416, 0.2, True, "IOU"),
)


# ----------------------------------------------------------------------------------------------
# SAHI adapter
# ----------------------------------------------------------------------------------------------
DetectFn = Callable[[np.ndarray, float], list]  # (rgb image, conf) -> list[dd.Detection], image coords


class OnnxDetect:
    """Reference ONNX pipeline (drone_detector.py) as a SAHI-compatible callable; counts inferences."""

    def __init__(self, model_path: Path = ONNX, threads: int = 2):
        self.det = dd.DroneDetector(model_path, threads=threads)
        self.calls = 0

    def __call__(self, img: np.ndarray, conf: float) -> list:
        self.calls += 1
        x, info = dd.preprocess(img, self.det.input_size)
        return dd.postprocess(self.det.raw(x), info, conf, NMS_IOU)


def make_sahi_model(detect_fn: DetectFn, conf: float):
    from sahi.models.base import DetectionModel
    from sahi.prediction import ObjectPrediction

    class DroneSahiModel(DetectionModel):
        def load_model(self):
            self.model = detect_fn

        def set_model(self, model, **kwargs):
            self.model = model

        def perform_inference(self, image: np.ndarray):
            self._original_predictions = self.model(image, self.confidence_threshold)

        def _create_object_prediction_list_from_original_predictions(self, shift_amount_list=[[0, 0]],
                                                                       full_shape_list=None):
            from sahi.utils.compatibility import fix_full_shape_list, fix_shift_amount_list

            shifts = fix_shift_amount_list(shift_amount_list)
            fulls = fix_full_shape_list(full_shape_list)
            shift = [int(v) for v in shifts[0]]
            full = None if fulls is None else [int(v) for v in fulls[0]]
            preds = []
            for d in self._original_predictions:
                if not (d.x1 < d.x2 and d.y1 < d.y2):
                    continue
                preds.append(ObjectPrediction(bbox=[d.x1, d.y1, d.x2, d.y2], category_id=0, score=d.score,
                                              category_name="drone", shift_amount=shift, full_shape=full))
            self._object_prediction_list_per_image = [preds]

    m = DroneSahiModel(confidence_threshold=conf, category_mapping={"0": "drone"}, load_at_init=False)
    m.set_model(detect_fn)
    return m


def sahi_predict(img: np.ndarray, detect_fn: DetectFn, conf: float, slice_size: int, overlap: float,
                 full_pass: bool, merge_metric: str = "IOS") -> list:
    """Run official SAHI slicing+merging; return dd.Detection in full-image pixels."""
    from sahi.predict import get_sliced_prediction

    model = make_sahi_model(detect_fn, conf)
    res = get_sliced_prediction(img, model, slice_height=slice_size, slice_width=slice_size,
                                overlap_height_ratio=overlap, overlap_width_ratio=overlap,
                                perform_standard_pred=full_pass, postprocess_type="GREEDYNMM",
                                postprocess_match_metric=merge_metric, postprocess_match_threshold=0.5,
                                postprocess_class_agnostic=True, verbose=0, force_postprocess_type=True)
    out = []
    for p in res.object_prediction_list:
        x1, y1, x2, y2 = p.bbox.to_xyxy()
        out.append(dd.Detection(float(x1), float(y1), float(x2), float(y2), float(p.score.value)))
    return out


def predict(mode: Mode, img: np.ndarray, detect_fn: DetectFn, conf: float) -> list:
    if mode.slice is None:
        return detect_fn(img, conf)
    return sahi_predict(img, detect_fn, conf, mode.slice, mode.overlap, mode.full_pass, mode.merge_metric)


# ----------------------------------------------------------------------------------------------
# subset selection
# ----------------------------------------------------------------------------------------------
def select(seed: int, per_stratum: dict[str, int]) -> dict:
    ds = DATA / "pathikg_test"
    index = json.loads((ds / "index.json").read_text())["images"]
    strata: dict[str, list] = {k: [] for k in per_stratum}
    for it in index:
        if it["image_id"] in KNOWN_NEAR_DUP_IDS:
            continue
        gt = load_gt(ds / "labels" / it["file"].replace(".jpg", ".txt"), it["width"], it["height"])
        if len(gt) == 0:
            continue
        s = float(np.sqrt((gt[:, 2] - gt[:, 0]) * (gt[:, 3] - gt[:, 1])).min())
        key = "small<16" if s < 16 else "small16-32" if s < 32 else "medium32-96" if s < 96 else "large>=96"
        strata[key].append({"file": it["file"], "image_id": it["image_id"], "source_path": it["source_path"],
                            "min_gt_px": round(s, 2), "n_gt": int(len(gt)), "stratum": key})
    rng = random.Random(seed)
    pos = []
    for k, n in per_stratum.items():
        pool = sorted(strata[k], key=lambda r: r["image_id"])
        pos += sorted(rng.sample(pool, min(n, len(pool))), key=lambda r: r["image_id"])
    neg_idx = json.loads((DATA / "coco_neg" / "index.json").read_text())["images"]
    neg = [{"file": it["file"], "coco_id": it["coco_id"], "subset": it["subset"],
            "coco_categories": it["coco_categories"]} for it in neg_idx]
    return {"seed": seed, "per_stratum_requested": per_stratum,
            "selection": "per stratum: random.Random(seed).sample over images sorted by image_id; stratum = "
                         "smallest GT sqrt(area) in the image; images without GT and KNOWN_NEAR_DUP_IDS excluded",
            "pool_sizes_after_exclusion": {k: len(v) for k, v in strata.items()},
            "excluded_known_near_duplicates": sorted(KNOWN_NEAR_DUP_IDS),
            "positives_source": "pathikg/drone-detection-dataset test split rev 004b46cc (NOT independent)",
            "negatives_source": "COCO val2017, 100 hard (bird/airplane/kite) + 100 random, seed 0 "
                                "(prepare_eval_data.py)",
            "positives": pos, "negatives": neg}


def compact(s: dict) -> dict:
    """Store only ids in git (subset.json); load_subset() re-expands them from ml/data."""
    c = {k: v for k, v in s.items() if k not in ("positives", "negatives")}
    c["positive_image_ids"] = {k: [p["image_id"] for p in s["positives"] if p["stratum"] == k]
                               for k in s["per_stratum_requested"]}
    c["negative_coco_ids"] = {sub: [n["coco_id"] for n in s["negatives"] if n["subset"] == sub]
                              for sub in ("hard", "random")}
    return c


def load_subset() -> dict:
    c = json.loads((OUT_DIR / "subset.json").read_text())
    ds = DATA / "pathikg_test"
    by_id = {it["image_id"]: it for it in json.loads((ds / "index.json").read_text())["images"]}
    pos = []
    for stratum, ids in c["positive_image_ids"].items():
        for i in ids:
            it = by_id[i]
            gt = load_gt(ds / "labels" / it["file"].replace(".jpg", ".txt"), it["width"], it["height"])
            pos.append({"file": it["file"], "image_id": i, "source_path": it["source_path"], "stratum": stratum,
                        "n_gt": int(len(gt)),
                        "min_gt_px": round(float(np.sqrt((gt[:, 2] - gt[:, 0]) * (gt[:, 3] - gt[:, 1])).min()), 2)})
    neg_by_id = {it["coco_id"]: it for it in json.loads((DATA / "coco_neg" / "index.json").read_text())["images"]}
    neg = [{"file": neg_by_id[i]["file"], "coco_id": i, "subset": sub,
            "coco_categories": neg_by_id[i]["coco_categories"]}
           for sub, ids in c["negative_coco_ids"].items() for i in ids]
    return {**c, "positives": pos, "negatives": neg}


# ----------------------------------------------------------------------------------------------
# evaluation
# ----------------------------------------------------------------------------------------------
def to_arr(dets):
    return (np.array([[d.x1, d.y1, d.x2, d.y2] for d in dets], float).reshape(-1, 4),
            np.array([d.score for d in dets], float))


def eval_image(dets, gt):
    pb, ps = to_arr(dets)
    tp, used, _ = match(pb, ps, gt, MATCH_IOU)
    # FP that overlaps an already-matched GT (fragment / duplicate box) - diagnostic for double counting.
    dup = 0
    if len(gt) and (~tp).any():
        ious = iou_matrix(pb[~tp], gt)
        dup = int(((ious >= 0.1) & used[None, :]).any(axis=1).sum())
    return {"tp": int(tp.sum()), "fp": int((~tp).sum()), "fn": int(len(gt) - used.sum()),
            "gt_hit": [bool(u) for u in used], "dup_fp": dup,
            "boxes": [[round(float(v), 1) for v in b] + [round(float(s), 3)] for b, s in zip(pb, ps)]}


def run(limit: int, threads: int, only: list[str] | None = None) -> None:
    import onnxruntime as ort
    import sahi

    subset = load_subset()
    pos, neg = subset["positives"], subset["negatives"]
    if limit:
        pos, neg = pos[:limit], neg[: max(1, limit // 2)]
    det = OnnxDetect(ONNX, threads=threads)
    items = [("pos", it, DATA / "pathikg_test" / "images" / it["file"]) for it in pos] + \
            [("neg", it, DATA / "coco_neg" / "images" / it["file"]) for it in neg]
    imgs = {}
    for kind, it, p in items:
        imgs[it["file"]] = dd.load_rgb(p)
    gts = {it["file"]: load_gt(DATA / "pathikg_test" / "labels" / it["file"].replace(".jpg", ".txt"),
                               imgs[it["file"]].shape[1], imgs[it["file"]].shape[0]) for it in pos}
    # warm-up (not measured)
    for _ in range(3):
        det.det.raw(dd.preprocess(imgs[pos[0]["file"]])[0])
    results: dict = {}
    modes = [m for m in MODES if not only or m.name in only]
    for mode in modes:
        res_mode = {}
        for conf in CONFS:
            per = {}
            t_mode = time.time()
            for kind, it, _ in items:
                img = imgs[it["file"]]
                c0 = det.calls
                t0 = time.perf_counter()
                dets = predict(mode, img, det, conf)
                dt = time.perf_counter() - t0
                gt = gts.get(it["file"], np.zeros((0, 4)))
                r = eval_image(dets, gt)
                r.update({"kind": kind, "ms": round(1000 * dt, 2), "inferences": det.calls - c0,
                          "wh": [int(img.shape[1]), int(img.shape[0])]})
                per[it["file"]] = r
            res_mode[str(conf)] = per
            print(f"[{mode.name} conf={conf}] {len(items)} images in {time.time() - t_mode:.0f}s", flush=True)
        results[mode.name] = res_mode
    gt_sizes = {f: [round(float(v), 2) for v in np.sqrt((g[:, 2] - g[:, 0]) * (g[:, 3] - g[:, 1]))]
                for f, g in gts.items()}
    import cv2
    import torch  # noqa: F401  (version record only)
    env = {"python": platform.python_version(), "platform": platform.platform(),
           "cpu": _cpu_name(), "logical_cpus": __import__("os").cpu_count(), "ort_intra_op_threads": threads,
           "onnxruntime": ort.__version__, "sahi": sahi.__version__, "numpy": np.__version__,
           "opencv": cv2.__version__, "ultralytics": __import__("ultralytics").__version__,
           "torch": __import__("torch").__version__,
           "onnx_sha256": json.loads((ML_DIR / "weights" / "export_info.json").read_text())["onnx_sha256"]}
    prev = OUT_DIR / "sahi_eval.json"
    if only and prev.exists():  # add modes to an existing run (same subset, same machine)
        old = json.loads(prev.read_text())
        results = {**old["results"], **results}
        env = {**env, "added_modes": {**old["env"].get("added_modes", {}), **{m: env["platform"] for m in only}}}
    out = {"modes": [m.__dict__ for m in MODES if m.name in results], "confs": CONFS, "nms_iou": NMS_IOU, "match_iou": MATCH_IOU,
           "merge": {"type": "GREEDYNMM", "metric": "per mode, see modes[].merge_metric", "threshold": 0.5, "class_agnostic": True},
           "env": env, "gt_sizes": gt_sizes, "results": results}
    (OUT_DIR / "sahi_eval.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT_DIR / 'sahi_eval.json'}")


def _cpu_name() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor()


def summarize(data: dict) -> dict:
    sizes = data["gt_sizes"]
    subset = load_subset()
    summ = {}
    base = data["results"]["baseline"]
    for mname, by_conf in data["results"].items():
        summ[mname] = {}
        for conf, per in by_conf.items():
            pos = {f: r for f, r in per.items() if r["kind"] == "pos"}
            neg = {f: r for f, r in per.items() if r["kind"] == "neg"}
            tp = sum(r["tp"] for r in pos.values()); fp = sum(r["fp"] for r in pos.values())
            fn = sum(r["fn"] for r in pos.values()); n_gt = tp + fn
            P = tp / max(tp + fp, 1); R = tp / max(n_gt, 1)
            hit = np.array([h for f in pos for h in pos[f]["gt_hit"]]); sz = np.array([s for f in pos for s in sizes[f]])
            by_size = {k: {"n_gt": int(((sz >= a) & (sz < b)).sum()),
                           "recall": float(hit[(sz >= a) & (sz < b)].mean()) if ((sz >= a) & (sz < b)).any() else None}
                       for k, (a, b) in SIZE_BUCKETS.items()}
            # GT-level change vs baseline at the same conf
            bpos = base[conf]
            gained = lost = 0; gained_sz, lost_sz = [], []
            for f in pos:
                for i, (h, hb) in enumerate(zip(pos[f]["gt_hit"], bpos[f]["gt_hit"])):
                    if h and not hb:
                        gained += 1; gained_sz.append(sizes[f][i])
                    elif hb and not h:
                        lost += 1; lost_sz.append(sizes[f][i])
            ms = [r["ms"] for r in per.values() if r["ms"] is not None]
            inf = [r["inferences"] for r in per.values() if r["inferences"] is not None]
            neg_sub = {}
            sub_of = {n["file"]: n["subset"] for n in subset["negatives"]}
            for s in ("hard", "random"):
                rs = [r for f, r in neg.items() if sub_of.get(f) == s]
                neg_sub[s] = {"images": len(rs), "images_with_detections": sum(1 for r in rs if r["fp"] > 0),
                              "detections": sum(r["fp"] for r in rs)}
            summ[mname][conf] = {
                "pos_images": len(pos), "gt": n_gt, "tp": tp, "fp": fp, "fn": fn,
                "precision": P, "recall": R, "f1": 2 * P * R / max(P + R, 1e-9),
                "dup_fp_on_matched_gt": sum(r["dup_fp"] for r in pos.values()),
                "recall_by_size": by_size,
                "vs_baseline": {"gt_gained": gained, "gt_lost": lost,
                                "gained_median_px": float(np.median(gained_sz)) if gained_sz else None,
                                "lost_median_px": float(np.median(lost_sz)) if lost_sz else None},
                "negatives": neg_sub,
                "latency_ms": None if not ms else {"mean": float(np.mean(ms)), "p50": float(np.median(ms)),
                                                   "p90": float(np.percentile(ms, 90)),
                                                   "mean_pos_640x480": float(np.mean([r["ms"] for r in pos.values()]))},
                "inferences_per_image": None if not inf else {"mean": float(np.mean(inf)), "min": int(min(inf)),
                                                              "max": int(max(inf))},
            }
    return summ


def precision_all(r: dict) -> float:
    """TP/(TP + positive FP + detections on assumed-negative frames)."""
    fp_neg = sum(sub["detections"] for sub in r["negatives"].values())
    return r["tp"] / max(r["tp"] + r["fp"] + fp_neg, 1)


def report() -> None:
    data = json.loads((OUT_DIR / "sahi_eval.json").read_text())
    s = summarize(data)
    (OUT_DIR / "summary.json").write_text(json.dumps(s, indent=1))
    env = data["env"]
    L = ["# SAHI vs baseline — сгенерированные таблицы", "",
         "_Сгенерировано `python ml/scripts/sahi_experiment.py report` из `sahi_eval.json`._", "",
         f"Среда: {env['cpu']}, {env['logical_cpus']} logical CPU, ORT intra-op {env['ort_intra_op_threads']}; "
         f"Python {env['python']}, onnxruntime {env['onnxruntime']}, sahi {env['sahi']}, numpy {env['numpy']}, "
         f"opencv {env['opencv']}. ONNX SHA-256 `{env['onnx_sha256']}`.", ""]
    L += ["P позитивы = TP / (TP + FP на позитивных кадрах); P вся выборка = TP / "
          "(TP + FP на позитивных кадрах + все детекции на предполагаемых негативах). "
          "F1 рассчитан по P на позитивных кадрах и R. COCO-негативы предполагаются без дронов.", ""]
    for conf in data["confs"]:
        c = str(conf)
        L += [f"## conf > {conf}, NMS IoU {data['nms_iou']}, IoU сопоставления {data['match_iou']}", "",
              "| Режим | P позитивы | P вся выборка | R | F1 позитивы | TP | FP позитивы | FN | FP-дубли у найденных GT | +GT / −GT vs baseline | "
              "Негативы hard: изобр. / детекций | Негативы random: изобр. / детекций |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for m, by in s.items():
            r = by[c]; v = r["vs_baseline"]; nh = r["negatives"]["hard"]; nr = r["negatives"]["random"]
            L.append(f"| {m} | {r['precision']:.3f} | {precision_all(r):.3f} | {r['recall']:.3f} | {r['f1']:.3f} | {r['tp']} | {r['fp']} | "
                     f"{r['fn']} | {r['dup_fp_on_matched_gt']} | +{v['gt_gained']} / −{v['gt_lost']} | "
                     f"{nh['images_with_detections']}/{nh['images']} / {nh['detections']} | "
                     f"{nr['images_with_detections']}/{nr['images']} / {nr['detections']} |")
        L += ["", "Recall по размеру GT (√площади, px исходного кадра):", "",
              "| Режим | " + " | ".join(f"{k} (n={s['baseline'][c]['recall_by_size'][k]['n_gt']})"
                                       for k in SIZE_BUCKETS) + " |",
              "|---" * (len(SIZE_BUCKETS) + 1) + "|"]
        for m, by in s.items():
            L.append(f"| {m} | " + " | ".join("—" if by[c]["recall_by_size"][k]["recall"] is None else
                                               f"{by[c]['recall_by_size'][k]['recall']:.3f}"
                                               for k in SIZE_BUCKETS) + " |")
        L.append("")
    c = str(min(data["confs"]))
    L += ["## Время на изображение (conf 0.25; slicing + инференсы + merge, без декодирования JPEG)", "",
          "| Режим | Инференсов/изобр. (mean, min–max) | mean, мс | p50, мс | p90, мс | mean 640×480 positives, мс | × baseline |",
          "|---|---|---|---|---|---|---|"]
    # Same reference for every row: baseline captured in the saved summary at this confidence.
    b = s["baseline"][c]["latency_ms"]["mean"]
    for m, by in s.items():
        r = by[c]; t = r["latency_ms"]; i = r["inferences_per_image"]
        L.append(f"| {m} | {i['mean']:.2f} ({i['min']}–{i['max']}) | {t['mean']:.1f} | {t['p50']:.1f} | "
                 f"{t['p90']:.1f} | {t['mean_pos_640x480']:.1f} | {t['mean'] / b:.2f} |")
    L.append("")
    (OUT_DIR / "REPORT_TABLES.md").write_text("\n".join(L))
    print("\n".join(L))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("select"); p.add_argument("--seed", type=int, default=0)
    p.add_argument("--n-small16", type=int, default=120); p.add_argument("--n-small32", type=int, default=120)
    p.add_argument("--n-medium", type=int, default=60); p.add_argument("--n-large", type=int, default=60)
    p = sub.add_parser("run"); p.add_argument("--limit", type=int, default=0); p.add_argument("--threads", type=int, default=2)
    p.add_argument("--only", nargs="*", default=None, help="run only these modes and merge into sahi_eval.json")
    sub.add_parser("report")
    a = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if a.cmd == "select":
        s = select(a.seed, {"small<16": a.n_small16, "small16-32": a.n_small32,
                            "medium32-96": a.n_medium, "large>=96": a.n_large})
        (OUT_DIR / "subset.json").write_text(json.dumps(compact(s), indent=1))
        print(json.dumps({k: v for k, v in s.items() if k not in ("positives", "negatives")}, indent=1),
              f"\npositives={len(s['positives'])} gt={sum(p['n_gt'] for p in s['positives'])} "
              f"negatives={len(s['negatives'])}")
    elif a.cmd == "run":
        run(a.limit, a.threads, a.only)
    else:
        report()


if __name__ == "__main__":
    main()

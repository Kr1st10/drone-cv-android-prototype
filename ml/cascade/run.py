"""Mine, calibrate, evaluate, or run the ONNX cascade on local images."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import platform
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from ml.cascade.prepare import ML, sha, write_json
from ml.cascade.runtime import (
    BASE_CONF, CANDIDATE_CONF, NMS_IOU, TOP_K, CropVerifier, ProposalDetector, proposals, timed_frame,
)
from ml.cascade.train import drone_boxes
from ml.scripts.data65 import BINS, size640, bin_of
from ml.scripts.drone_detector import load_rgb
from ml.scripts.evaluate import iou_matrix, match

YOLO_SHA = json.loads((ML / "model_manifest.json").read_text())["android"]["onnx_sha256"]
BASELINE = "yolo_0.50"
CASCADE = "cascade"


def detector_for(model: Path):
    if sha(model) != YOLO_SHA:
        raise ValueError("Expected the exact production ONNX in ml/model_manifest.json")
    return ProposalDetector(model)


def load_split(manifest: Path, split: str):
    records = json.loads(manifest.read_text())["records"]
    roles = {}
    for record in records:
        for field in ("source_id", "group", "video_sha256", "pixel_sha256", "sha256"):
            identity = record.get(field)
            if identity and roles.setdefault((field, identity), record["split"]) != record["split"]:
                raise ValueError(f"Cross-split {field}: {identity}")
    selected = [r for r in records if r["split"] == split]
    if not selected:
        raise ValueError(f"Empty {split} split")
    return selected


def frame_pixels(manifest: Path, record: dict):
    path = manifest.parent / record["file"]
    if sha(path) != record["sha256"]:
        raise ValueError(f"Frame bytes differ from manifest: {path}")
    rgb = load_rgb(path)
    if rgb.shape[:2] != (record["height"], record["width"]):
        raise ValueError(f"Decoded frame dimensions differ from manifest: {path}")
    return rgb


def mine(args):
    detector = detector_for(args.yolo)
    records = load_split(args.manifest, "train")
    mined = {}
    for index, record in enumerate(records, 1):
        rgb = frame_pixels(args.manifest, record)
        mined[record["id"]] = proposals(*detector.run(rgb))[:TOP_K].tolist()
        if index % 200 == 0:
            print(f"Mined {index}/{len(records)} train frames", flush=True)
    write_json(args.output, {"manifest_sha256": sha(args.manifest), "yolo_sha256": YOLO_SHA,
                             "nms_iou": NMS_IOU, "candidate_conf": CANDIDATE_CONF, "top_k": TOP_K,
                             "proposals": mined})


def scored_frames(args, split):
    records = load_split(args.manifest, split)
    detector = detector_for(args.yolo)
    verifier = CropVerifier(args.classifier)
    warmup_rgb = frame_pixels(args.manifest, records[0])
    for _ in range(5):
        timed_frame(detector, verifier, warmup_rgb)
    frames = []
    for index, record in enumerate(records, 1):
        rgb = frame_pixels(args.manifest, record)
        baseline, proposals_low, cascade, timing = timed_frame(detector, verifier, rgb)
        frames.append((record, baseline, proposals_low, cascade, timing))
        if index % 200 == 0:
            print(f"Scored {index}/{len(records)} {split} frames", flush=True)
    return frames


def selected(frame, method, threshold):
    rows = frame[1] if method == BASELINE else frame[3]
    return rows[rows[:, -1] > threshold]


def budget_counts(frames, method, threshold):
    counts = {"all_fp": 0, "negative_fp": 0}
    for frame in frames:
        gt = drone_boxes(frame[0])
        rows = selected(frame, method, threshold)
        tp, _, _ = match(rows[:, :4], rows[:, -1], gt)
        fp = len(rows) - int(tp.sum())
        counts["all_fp"] += fp
        if not len(gt):
            counts["negative_fp"] += fp
    return counts


def score_for_budget(frames, budget, counter):
    """Keep the largest complete tied-score prefix within the FP cap (strict > threshold)."""
    costs = Counter()
    for record, _, _, rows, _ in frames:
        gt = drone_boxes(record)
        if counter == "negative_fp" and len(gt):
            continue
        tp, _, _ = match(rows[:, :4], rows[:, -1], gt)
        costs.update(float(score) for score in rows[~tp, -1])
    used = 0
    for score in sorted(costs, reverse=True):
        used += costs[score]
        if used > budget:
            return score
    return 0.0


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def metrics(frames, method, threshold, iou=.5):
    counts = Counter()
    small = {name: [0, 0] for name in BINS}
    negative = defaultdict(Counter)
    matched_iou = []
    for frame in frames:
        record = frame[0]
        gt = drone_boxes(record)
        predictions = selected(frame, method, threshold)
        tp, matched, ious = match(predictions[:, :4], predictions[:, -1], gt, iou)
        matched_iou.extend(ious)
        counts.update({"frames": 1, "gt": len(gt), "tp": int(tp.sum()), "fp": len(tp) - int(tp.sum()),
                       "fn": len(gt) - int(matched.sum())})
        for box, is_matched in zip(gt, matched):
            bucket = small[bin_of(size640(box, record["width"], record["height"]))]
            bucket[0] += int(is_matched)
            bucket[1] += 1
        fp_boxes = predictions[~tp, :4]
        if len(gt):
            closest = iou_matrix(fp_boxes, gt).max(axis=1)
            counts["duplicate_fp"] += int((closest >= iou).sum())
            counts["localization_fp"] += int(((closest >= .1) & (closest < iou)).sum())
            counts["unmatched_fp_on_positive"] += int((closest < .1).sum())
        else:
            categories = [a["class"] for a in record["annotations"] + record.get("other_objects", [])]
            scene = "+".join(sorted(set(categories))) or "background"
            negative[scene].update({"frames": 1, "fp_boxes": len(fp_boxes), "fp_frames": int(len(fp_boxes) > 0)})
            counts["fp_on_negative"] += len(fp_boxes)
            if len(fp_boxes) and categories:
                boxes = np.array([a["xyxy"] for a in record["annotations"] + record.get("other_objects", [])])
                overlaps = iou_matrix(fp_boxes, boxes)
                for row in overlaps:
                    category = categories[row.argmax()] if row.max() >= .1 else "background"
                    counts[f"negative_fp_near_{category}"] += 1
            elif len(fp_boxes):
                counts["negative_fp_near_background"] += len(fp_boxes)

    return dict(counts) | {
        "recall": ratio(counts["tp"], counts["gt"]), "precision": ratio(counts["tp"], counts["tp"] + counts["fp"]),
        "fp_per_100_frames": 100 * counts["fp"] / counts["frames"],
        "median_matched_iou": float(np.median(matched_iou)) if matched_iou else None,
        "recall_by_size640": {name: {"found": n, "gt": d, "recall": ratio(n, d)} for name, (n, d) in small.items()},
        "drone_free_by_frame_category": {
            key: dict(value) | {"fp_frame_share": ratio(value["fp_frames"], value["frames"])}
            for key, value in sorted(negative.items())
        },
    }


def summary(frames, method, threshold):
    return {"threshold": threshold, "iou50": metrics(frames, method, threshold),
            "iou30": metrics(frames, method, threshold, iou=.3),
            "by_dataset_iou50": {
                ds: metrics([frame for frame in frames if frame[0]["dataset"] == ds], method, threshold)
                for ds in sorted({frame[0]["dataset"] for frame in frames})
            }}


def candidate_ceiling(frames):
    """Each GT needs an overlapping post-NMS proposal. This ceiling ignores one-to-one assignment."""
    buckets = defaultdict(Counter)
    for record, baseline, all_boxes, capped, _ in frames:
        gt = drone_boxes(record)
        available = {}
        for name, candidates in (("baseline", baseline), ("all_low_conf", all_boxes), ("top_k", capped)):
            ious = iou_matrix(candidates[:, :4], gt)
            available[name] = ious.max(axis=0, initial=0)
        for index, box in enumerate(gt):
            key = bin_of(size640(box, record["width"], record["height"]))
            buckets[key]["gt"] += 1
            for name, ious in available.items():
                for iou in (.3, .5):
                    buckets[key][f"{name}_iou{int(100 * iou)}"] += int(ious[index] >= iou)
    return {key: dict(value) for key, value in sorted(buckets.items())}


def quantiles(values):
    return {key: float(np.percentile(values, q)) for key, q in (("p50", 50), ("p95", 95), ("max", 100))}


def calibrate(args):
    frames = scored_frames(args, "validation")
    budgets = budget_counts(frames, BASELINE, BASE_CONF)
    thresholds = {key: score_for_budget(frames, budget, key) for key, budget in budgets.items()}
    write_json(args.output, {
        "manifest_sha256": sha(args.manifest), "classifier_sha256": sha(args.classifier), "yolo_sha256": YOLO_SHA,
        "candidate_conf": CANDIDATE_CONF, "nms_iou": NMS_IOU, "top_k": TOP_K, "thresholds": thresholds,
        "validation_budget": budgets, "baseline": summary(frames, BASELINE, BASE_CONF),
        "cascade": {key: summary(frames, CASCADE, threshold) for key, threshold in thresholds.items()},
        "validation_groups": sorted({frame[0]["group"] for frame in frames}),
    })


def evaluate(args):
    calibration = json.loads(args.calibration.read_text())
    if (calibration["manifest_sha256"], calibration["classifier_sha256"], calibration["yolo_sha256"]) != (
        sha(args.manifest), sha(args.classifier), YOLO_SHA
    ) or (calibration["candidate_conf"], calibration["nms_iou"], calibration["top_k"]) != (
        CANDIDATE_CONF, NMS_IOU, TOP_K
    ):
        raise ValueError("Calibration does not belong to this run")
    frames = scored_frames(args, "test")
    budgets = budget_counts(frames, BASELINE, BASE_CONF)
    counts = Counter(len(f[3]) for f in frames)
    timings = {key: quantiles([f[4][key] for f in frames]) for key in frames[0][4]}
    timings["baseline_total_ms"] = quantiles([f[4]["shared_preprocess_ort_ms"] + f[4]["baseline_nms_ms"]
                                             for f in frames])
    timings["cascade_total_ms"] = quantiles([f[4]["shared_preprocess_ort_ms"] + f[4]["low_nms_ms"] +
                                            f[4]["crop_verifier_ms"] for f in frames])
    scored = [frame for frame in frames if len(frame[3])]
    timings["crop_verifier_nonempty_ms"] = quantiles([f[4]["crop_verifier_ms"] for f in scored]) if scored else None
    write_json(args.output, {
        "platform": platform.platform(), "processor": platform.processor(), "onnxruntime": ort.__version__,
        "yolo_sha256": YOLO_SHA, "classifier_sha256": sha(args.classifier), "manifest_sha256": sha(args.manifest),
        "calibration_sha256": sha(args.calibration), "yolo_conf": BASE_CONF,
        "candidate_conf": CANDIDATE_CONF, "nms_iou": NMS_IOU, "top_k": TOP_K,
        "test_budgets_from_baseline": budgets, "baseline": summary(frames, BASELINE, BASE_CONF),
        "cascade_frozen_thresholds": {
            key: summary(frames, CASCADE, threshold) for key, threshold in calibration["thresholds"].items()
        },
        "cascade_diagnostic_thresholds_fit_to_test_budgets": {
            key: summary(frames, CASCADE, score_for_budget(frames, budget, key)) for key, budget in budgets.items()
        },
        "candidate_ceiling": candidate_ceiling(frames), "timings": timings,
        "crops_per_frame": dict(sorted(counts.items())),
        "frames_truncated_to_top_k": sum(len(frame[2]) > TOP_K for frame in frames),
        "test_groups": sorted({frame[0]["group"] for frame in frames}),
    })


def infer(args):
    if not 0 <= args.threshold <= 1:
        raise ValueError("Threshold must be in [0, 1]")
    detector = detector_for(args.yolo)
    verifier = CropVerifier(args.classifier)
    for path in args.images:
        rgb = load_rgb(path)
        baseline, _, scored, timings = timed_frame(detector, verifier, rgb)
        frame = (None, baseline, None, scored, timings)
        rows = selected(frame, CASCADE, args.threshold)
        print(json.dumps({"image": str(path), "baseline_xyxy_yolo": baseline.tolist(),
                          "cascade_xyxy_yolo_verifier_fused": rows.tolist(), "timings": timings}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, action in (("mine", mine), ("calibrate", calibrate), ("evaluate", evaluate), ("infer", infer)):
        command = commands.add_parser(name)
        command.add_argument("--yolo", type=Path, required=True)
        if name != "mine":
            command.add_argument("--classifier", type=Path, required=True)
        if name != "infer":
            command.add_argument("--manifest", type=Path, required=True)
            command.add_argument("--output", type=Path, required=True)
        if name == "evaluate":
            command.add_argument("--calibration", type=Path, required=True)
        if name == "infer":
            command.add_argument("--threshold", type=float, required=True)
            command.add_argument("images", type=Path, nargs="+")
        command.set_defaults(action=action)
    cv2.setNumThreads(1)
    args = parser.parse_args()
    args.action(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Measure the existing YOLO11s detector on a deterministic digital scale series."""
from __future__ import annotations

import argparse
import csv
import json
import math
import platform
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np
import onnxruntime
import PIL
from PIL import Image, ImageOps

from drone_detector import DEFAULT_MODEL, INPUT_SIZE, PAD_VALUE, Detection, DroneDetector
from evaluate import iou_matrix, match
from fetch_and_export import MANIFEST, sha256

WIDTHS = (8, 12, 16, 24, 32, 48, 64)
OFFSETS = ((0, 0), (1, -1), (-2, 2))
BACKGROUND = (PAD_VALUE,) * 3
CONFIDENCE = 0.25
NMS_IOU = 0.70
MATCH_IOU = 0.50
THREADS = 2
STATES = {
    "no_detection": ("No box", "#a8afb8"),
    "unmatched": ("Box(es), none match", "#d27641"),
    "matched": ("Matched box", "#237f6a"),
    "unverified": ("Box(es), GT unverified", "#487ba6"),
}

Box = tuple[float, float, float, float]


def load_source(path: Path) -> Image.Image:
    with Image.open(path) as source:
        rgba = ImageOps.exif_transpose(source).convert("RGBA")
    background = Image.new("RGBA", rgba.size, (*BACKGROUND, 255))
    return Image.alpha_composite(background, rgba).convert("RGB")


def validate_box(box: Box, size: tuple[int, int]) -> None:
    x1, y1, x2, y2 = box
    width, height = size
    if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
        raise ValueError("bbox must be a positive xyxy rectangle inside the EXIF-oriented source")
    if x2 - x1 < max(WIDTHS):
        raise ValueError("source bbox must be at least 64 px wide for a downscale-only series")
    max_gt_height = (y2 - y1) * max(WIDTHS) / (x2 - x1)
    if 2 * math.ceil(max_gt_height / 2) + 2 * max(abs(dy) for _, dy in OFFSETS) > INPUT_SIZE:
        raise ValueError("scaled source bbox would exceed the canvas")


def render_patch(source: Image.Image, box: Box, width: int) -> tuple[Image.Image, float]:
    """Area downsample at one scale for both axes, with the box center on a pixel grid intersection."""
    x1, y1, x2, y2 = box
    scale = width / (x2 - x1)
    gt_height = (y2 - y1) * scale
    patch_height = 2 * math.ceil(gt_height / 2)
    # Extend the source window symmetrically in y to an even integer output height.
    # The fractional source window keeps the same scale and an exact, fixed center.
    center_y = (y1 + y2) / 2
    radius_y = patch_height / (2 * scale)
    top, bottom = center_y - radius_y, center_y + radius_y
    pad_top = max(0, math.ceil(-top))
    pad_bottom = max(0, math.ceil(bottom - source.height))
    if pad_top or pad_bottom:
        source = ImageOps.expand(source, (0, pad_top, 0, pad_bottom), fill=BACKGROUND)
    window = (x1, top + pad_top, x2, bottom + pad_top)
    # BOX averages pixels on shrink. At scale=1, a fractional ROI still stays aligned.
    return source.resize((width, patch_height), Image.Resampling.BOX, box=window), gt_height


def variants(source: Image.Image, box: Box):
    validate_box(box, source.size)
    for width in WIDTHS:
        patch, gt_height = render_patch(source, box, width)
        for dx, dy in OFFSETS:
            cx, cy = INPUT_SIZE // 2 + dx, INPUT_SIZE // 2 + dy
            canvas = Image.new("RGB", (INPUT_SIZE, INPUT_SIZE), BACKGROUND)
            canvas.paste(patch, (cx - patch.width // 2, cy - patch.height // 2))
            projected_box = (cx - width / 2, cy - gt_height / 2, cx + width / 2, cy + gt_height / 2)
            yield width, (dx, dy), canvas, projected_box


def evaluate_detections(detections: list[Detection], box: Box, verified: bool) -> dict:
    predictions = [asdict(d) for d in detections]
    state = "unverified" if detections else "no_detection"
    matched = best_iou = tp = fn = fp = None
    if verified:
        boxes = np.array([[d.x1, d.y1, d.x2, d.y2] for d in detections], dtype=float).reshape(-1, 4)
        gt = np.array([box], dtype=float)
        ious = iou_matrix(boxes, gt)[:, 0]
        flags, used, _ = match(boxes, np.array([d.score for d in detections]), gt, MATCH_IOU)
        for pred, iou, flag in zip(predictions, ious, flags):
            pred.update(gt_iou=float(iou), matched=bool(flag))
        best_iou = float(ious.max()) if len(ious) else None
        matched = bool(used[0])
        tp, fn = int(matched), int(not matched)
        fp = len(predictions) - tp
        if detections:
            state = "matched" if matched else "unmatched"
    return {
        "outcome": state,
        "matched": matched,
        "best_iou": best_iou,
        "tp": tp,
        "fn": fn,
        "fp": fp,
        "detection_count": len(predictions),
        "detections": predictions,
    }


def save_chart(rows: list[dict], path: Path) -> None:
    from matplotlib.figure import Figure

    figure = Figure(figsize=(8.4, 4.1), layout="constrained")
    ax = figure.subplots()
    counts = np.zeros(len(WIDTHS), dtype=int)
    for state, (label, color) in STATES.items():
        values = [sum(r["target_width_px"] == w and r["outcome"] == state for r in rows) for w in WIDTHS]
        if any(values):
            ax.bar(range(len(WIDTHS)), values, bottom=counts, label=label, color=color, width=0.64)
            counts += values
    ax.set(
        title=f"YOLO11s digital size sweep  ·  confidence > {CONFIDENCE:.2f}  ·  NMS {NMS_IOU:.2f}",
        xlabel="Object box width in the 640 × 640 input (px)",
        ylabel="Number of placements",
        xticks=range(len(WIDTHS)), xticklabels=WIDTHS,
        yticks=range(len(OFFSETS) + 1), ylim=(0, len(OFFSETS) + 0.1),
    )
    ax.grid(axis="y", alpha=0.25)
    ax.set_axisbelow(True)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.19), ncols=3, frameon=False)
    figure.savefig(path, dpi=150)


def run(photo: Path, box: Box, model: Path, output: Path, gt_source: str | None) -> None:
    expected = MANIFEST["export"]["expected_onnx_sha256"]
    model_hash = sha256(model)
    if model_hash != expected:
        raise ValueError(f"ONNX SHA-256 mismatch: {model_hash}, expected {expected} (ml/MODEL.md)")
    source_hash = sha256(photo)
    source = load_source(photo)
    validate_box(box, source.size)
    detector = DroneDetector(model, threads=THREADS)
    if detector.input_size != INPUT_SIZE:
        raise ValueError(f"expected a {INPUT_SIZE} px detector input")

    output.mkdir(parents=True)
    images = output / "inputs"
    images.mkdir()
    verified = gt_source is not None
    common = {
        "source_name": photo.name, "source_sha256": source_hash, "model_sha256": model_hash,
        "source_bbox_xyxy": box, "background_rgb": BACKGROUND, "confidence_threshold": CONFIDENCE,
        "nms_iou_threshold": NMS_IOU, "match_iou_threshold": MATCH_IOU if verified else None,
        "gt_verified": verified, "gt_source": gt_source,
    }
    rows = []
    for width, (dx, dy), canvas, projected in variants(source, box):
        image_path = images / f"w{width:02d}_dx{dx:+d}_dy{dy:+d}.png"
        canvas.save(image_path)
        detections = detector.detect(np.asarray(canvas), conf=CONFIDENCE, iou=NMS_IOU)
        rows.append({
            **common, "input_png": image_path.relative_to(output).as_posix(),
            "input_png_sha256": sha256(image_path),
            "target_width_px": width, "actual_width_px": projected[2] - projected[0],
            "actual_height_px": projected[3] - projected[1], "dx_px": dx, "dy_px": dy,
            "projected_bbox_xyxy": projected,
            **evaluate_detections(detections, projected, verified),
        })
    run_info = {
        "schema": "dronecv-yolo-size-sweep-1",
        "source_size_px": source.size,
        "canvas_size_px": [INPUT_SIZE, INPUT_SIZE],
        "input_widths_px": WIDTHS,
        "offsets_px": OFFSETS,
        "resampling": "Pillow BOX; fractional source window; no sharpening",
        "runtime": {
            "python": platform.python_version(), "platform": platform.platform(),
            "numpy": np.__version__, "pillow": PIL.__version__, "opencv": cv2.__version__,
            "onnxruntime": onnxruntime.__version__, "providers": detector.session.get_providers(),
            "intra_op_threads": THREADS,
        },
        "variants": rows,
    }
    (output / "series.json").write_text(json.dumps(run_info, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                                        encoding="utf-8")
    with (output / "series.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, ensure_ascii=False) if isinstance(value, (list, tuple)) else value
                             for key, value in row.items()})
    save_chart(rows, output / "size-sweep.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--photo", required=True, type=Path, help="local JPEG or PNG")
    parser.add_argument("--bbox", required=True, type=float, nargs=4, metavar=("X1", "Y1", "X2", "Y2"),
                        help="source bbox in EXIF-oriented image pixels")
    parser.add_argument("--gt-source", help="provenance of a verified bbox; omit to disable IoU and TP/FN/FP")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--out", required=True, type=Path, help="new results directory")
    args = parser.parse_args()
    gt_source = args.gt_source.strip() if args.gt_source else None
    try:
        run(args.photo, tuple(args.bbox), args.model, args.out, gt_source)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"{len(WIDTHS) * len(OFFSETS)} variants written to {args.out}")


if __name__ == "__main__":
    main()

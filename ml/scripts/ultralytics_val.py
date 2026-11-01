#!/usr/bin/env python3
"""Cross-check metrics with Ultralytics' own validator (independent of evaluate.py's metric code).

Usage: python ml/scripts/ultralytics_val.py [--weights ml/weights/yolo11s-drone-640.onnx]
Writes ml/results/ultralytics_val_<weights-name>.json
"""
import argparse
import json
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(ML_DIR / "weights" / "yolo11s-drone-640.onnx"))
    args = ap.parse_args()
    from ultralytics import YOLO

    m = YOLO(args.weights, task="detect")
    r = m.val(data=str(ML_DIR / "data" / "pathikg_test" / "dataset.yaml"), imgsz=640, batch=1, conf=0.001,
              iou=0.7, device="cpu", plots=False, verbose=False, project="/tmp/ultra_val", name="run", exist_ok=True)
    out = {"weights": Path(args.weights).name, "dataset": "pathikg test split (2625 images)",
           "imgsz": 640, "conf": 0.001, "iou_nms": 0.7, **{k: float(v) for k, v in r.results_dict.items()},
           "note": "Ultralytics P/R are reported at the confidence that maximises F1, not at 0.25."}
    dst = ML_DIR / "results" / f"ultralytics_val_{Path(args.weights).stem}.json"
    dst.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()

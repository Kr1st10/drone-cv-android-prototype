#!/usr/bin/env python3
"""Build the Python reference used by the Android/Kotlin parity test (app/src/test/.../OnnxParityTest.kt).

Writes (git-ignored) ml/data/android_parity/:
  images/*.ppm      lossless binary PPM copies of control images (Kotlin reads exactly the same pixels)
  tensors/*.bin     float32 little-endian input tensors [1,3,640,640] and raw outputs [1,5,8400] (first images)
  reference.json    reference detections of ml/scripts/drone_detector.py for every case
  reference.tsv     the same in a dependency-free format read by the Kotlin test

Cases per control image:
  orig   — image as is (640x480 -> letterbox without resize: tensor must match bit-exactly);
  up150  — image upscaled x1.5 with cv2 INTER_LINEAR (exercises the resize path of the letterbox);
  rot90  — image rotated 90° clockwise; Kotlin passes rotationDegrees=270 and must reproduce `orig`.
Negatives (COCO, no drones) check the empty-result path and false positives alike.

Requires fetch_and_export.py and prepare_eval_data.py. Usage:
    python ml/scripts/make_android_reference.py [--positives 20] [--negatives 10] [--tensors 3]
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drone_detector as dd  # noqa: E402

ML_DIR = Path(__file__).resolve().parents[1]
DATA = ML_DIR / "data"
OUT = DATA / "android_parity"


def save_ppm(path: Path, rgb: np.ndarray) -> None:
    """Binary PPM (P6): lossless and trivial to decode without image libraries (Android unit tests)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = rgb.shape[:2]
    path.write_bytes(f"P6\n{w} {h}\n255\n".encode() + np.ascontiguousarray(rgb, dtype=np.uint8).tobytes())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--positives", type=int, default=20)
    ap.add_argument("--negatives", type=int, default=10)
    ap.add_argument("--tensors", type=int, default=3, help="dump input/output tensors for the first N images")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.7)
    args = ap.parse_args()

    det = dd.DroneDetector(ML_DIR / "weights" / "yolo11s-drone-640.onnx")
    pos = json.loads((DATA / "pathikg_test" / "index.json").read_text())["images"][: args.positives]
    neg = json.loads((DATA / "coco_neg" / "index.json").read_text())["images"][: args.negatives]
    sources = [("pathikg", DATA / "pathikg_test" / "images" / it["file"]) for it in pos] + \
              [("coco_neg", DATA / "coco_neg" / "images" / it["file"]) for it in neg]

    cases = []
    for k, (subset, src) in enumerate(sources):
        rgb = dd.load_rgb(src)
        stem = f"{subset}_{src.stem}"
        h, w = rgb.shape[:2]
        variants = {
            "orig": (rgb, 0, rgb),
            "up150": (cv2.resize(rgb, (int(round(w * 1.5)), int(round(h * 1.5))), interpolation=cv2.INTER_LINEAR),
                      0, None),
            "rot90": (np.ascontiguousarray(np.rot90(rgb, k=-1)), 270, rgb),
        }
        for name, (img, rotation, upright) in variants.items():
            png = OUT / "images" / f"{stem}_{name}.ppm"
            save_ppm(png, img)
            ref_img = upright if upright is not None else img
            x, info = dd.preprocess(ref_img)
            raw = det.raw(x)
            dets = dd.postprocess(raw, info, args.conf, args.iou)
            case = {"id": f"{stem}_{name}", "subset": subset, "variant": name, "image": f"images/{png.name}",
                    "rotation_degrees": rotation, "width": int(ref_img.shape[1]), "height": int(ref_img.shape[0]),
                    "letterbox": {"scale": info.scale, "pad_x": info.pad_x, "pad_y": info.pad_y},
                    "detections": [asdict(d) for d in dets]}
            if k < args.tensors and name in ("orig", "up150"):
                tdir = OUT / "tensors"; tdir.mkdir(parents=True, exist_ok=True)
                x.astype("<f4").tofile(tdir / f"{stem}_{name}_input.bin")
                raw.astype("<f4").tofile(tdir / f"{stem}_{name}_output.bin")
                case["input_tensor"] = f"tensors/{stem}_{name}_input.bin"
                case["output_tensor"] = f"tensors/{stem}_{name}_output.bin"
            cases.append(case)
    import onnxruntime as ort
    ref = {"conf": args.conf, "iou": args.iou, "onnxruntime": ort.__version__, "opencv": cv2.__version__,
           "model_sha256": json.loads((ML_DIR / "weights" / "export_info.json").read_text())["onnx_sha256"],
           "cases": cases}
    (OUT / "reference.json").write_text(json.dumps(ref, indent=1))
    # Same data as a dependency-free TSV for the Kotlin test:
    # id, image, rotation, width, height, input_tensor|-, output_tensor|-, detections "x1,y1,x2,y2,score;..."
    with (OUT / "reference.tsv").open("w") as f:
        f.write(f"# conf={args.conf} iou={args.iou} model_sha256={ref['model_sha256']}\n")
        for c in cases:
            dets = ";".join(",".join(repr(float(d[k])) for k in ("x1", "y1", "x2", "y2", "score"))
                            for d in c["detections"])
            f.write("\t".join([c["id"], c["image"], str(c["rotation_degrees"]), str(c["width"]), str(c["height"]),
                                c.get("input_tensor", "-"), c.get("output_tensor", "-"), dets or "-"]) + "\n")
    n_det = sum(len(c["detections"]) for c in cases)
    print(f"[android-ref] cases={len(cases)} detections={n_det} -> {OUT / 'reference.json'}")


if __name__ == "__main__":
    main()

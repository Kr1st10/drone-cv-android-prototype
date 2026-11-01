#!/usr/bin/env python3
"""Download the pinned YOLO11s drone checkpoint, verify SHA-256 and export it to ONNX.

Usage (from repository root):
    python ml/scripts/fetch_and_export.py            # download + verify + export
    python ml/scripts/fetch_and_export.py --skip-export

Outputs (git-ignored):
    ml/weights/best.pt
    ml/weights/yolo11s-drone-640.onnx
    ml/weights/export_info.json     (versions, SHA-256 of the ONNX file, I/O shapes)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import sys
import urllib.request
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ML_DIR / "model_manifest.json").read_text())
WEIGHTS_DIR = ML_DIR / "weights"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_checkpoint() -> Path:
    src = MANIFEST["source"]
    dst = WEIGHTS_DIR / src["file"]
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    if dst.exists() and sha256(dst) == src["sha256"]:
        print(f"[fetch] cached {dst} (sha256 OK)")
        return dst
    print(f"[fetch] downloading {src['url']}")
    tmp = dst.with_suffix(".part")
    with urllib.request.urlopen(src["url"]) as r, tmp.open("wb") as f:
        shutil.copyfileobj(r, f)
    digest = sha256(tmp)
    if digest != src["sha256"]:
        tmp.unlink()
        sys.exit(f"[fetch] SHA-256 mismatch: got {digest}, expected {src['sha256']}")
    tmp.replace(dst)
    print(f"[fetch] OK {dst} sha256={digest}")
    return dst


def export_onnx(pt_path: Path) -> Path:
    import onnx
    import onnxruntime as ort
    import torch
    import ultralytics
    from ultralytics import YOLO

    cfg = MANIFEST["export"]
    model = YOLO(str(pt_path))
    out = Path(
        model.export(
            format="onnx",
            imgsz=cfg["imgsz"],
            opset=cfg["opset"],
            simplify=cfg["simplify"],
            dynamic=cfg["dynamic"],
            half=cfg["half"],
            nms=cfg["nms"],
            device="cpu",
        )
    )
    final = ML_DIR.parent / cfg["output_file"]
    m = onnx.load(str(out))
    # Drop the volatile export timestamp so repeated exports are comparable.
    kept = [p for p in m.metadata_props if p.key != "date"]
    del m.metadata_props[:]
    m.metadata_props.extend(kept)
    onnx.checker.check_model(m)
    onnx.save(m, str(final))
    if out.resolve() != final.resolve():
        out.unlink()

    sess = ort.InferenceSession(str(final), providers=["CPUExecutionProvider"])
    info = {
        "onnx_file": cfg["output_file"],
        "onnx_sha256": sha256(final),
        "onnx_size_bytes": final.stat().st_size,
        "opset": cfg["opset"],
        "inputs": [{"name": i.name, "shape": i.shape, "type": i.type} for i in sess.get_inputs()],
        "outputs": [{"name": o.name, "shape": o.shape, "type": o.type} for o in sess.get_outputs()],
        "metadata": {p.key: p.value for p in m.metadata_props},
        "versions": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "ultralytics": ultralytics.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
        },
        "source_pt_sha256": MANIFEST["source"]["sha256"],
    }
    (WEIGHTS_DIR / "export_info.json").write_text(json.dumps(info, indent=2))
    print(json.dumps(info, indent=2))
    return final


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-export", action="store_true")
    args = ap.parse_args()
    pt = fetch_checkpoint()
    if not args.skip_export:
        export_onnx(pt)


if __name__ == "__main__":
    main()

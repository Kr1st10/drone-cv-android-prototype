#!/usr/bin/env python3
"""Copy the exported ONNX model into the Android app assets after verifying its SHA-256.

Usage (from repository root, after ml/scripts/fetch_and_export.py):
    python ml/scripts/install_android_model.py [--onnx ml/weights/yolo11s-drone-640.onnx]

The expected hash and asset path come from ml/model_manifest.json ("android" section); the same values are
compiled into BuildConfig and re-checked by Gradle (task :app:verifyDroneModel) and by the app at runtime.
The asset is git-ignored (third-party weights, see ml/MODEL.md).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "ml" / "model_manifest.json").read_text())


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--onnx", default=str(ROOT / MANIFEST["export"]["output_file"]))
    args = ap.parse_args()
    src = Path(args.onnx)
    if not src.is_file():
        sys.exit(f"[install] {src} not found. Run: python ml/scripts/fetch_and_export.py")
    expected = MANIFEST["android"]["onnx_sha256"]
    actual = sha256(src)
    if actual != expected:
        sys.exit(f"[install] SHA-256 mismatch: got {actual}, expected {expected}.\n"
                 "Export with the pinned versions from ml/requirements.txt, or (after verifying parity with "
                 "ml/scripts/evaluate.py) update android.onnx_sha256 in ml/model_manifest.json.")
    dst = ROOT / "app" / "src" / "main" / "assets" / MANIFEST["android"]["asset_path"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    print(f"[install] OK {dst} ({dst.stat().st_size} bytes, sha256 {actual})")


if __name__ == "__main__":
    main()

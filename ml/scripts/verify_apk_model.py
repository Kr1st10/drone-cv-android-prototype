#!/usr/bin/env python3
"""Verify the packaged ONNX asset against the manifest, without ML dependencies."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    model = json.loads((ROOT / "ml/model_manifest.json").read_text())["android"]
    with zipfile.ZipFile(sys.argv[1]) as apk:
        asset = "assets/" + model["asset_path"]
        info = apk.getinfo(asset)  # Missing asset must fail, even if Gradle assembled successfully.
        with apk.open(info) as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != model["onnx_sha256"]:
            raise SystemExit(f"APK model SHA-256 mismatch: {actual}")
        if info.compress_type != zipfile.ZIP_STORED:
            raise SystemExit("ONNX asset must be stored without compression")
        print(f"APK model OK: {asset}, {info.file_size} bytes, sha256={actual}")


if __name__ == "__main__":
    main()

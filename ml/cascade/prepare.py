"""Prepare the pilot from pinned public archives and the existing 6.4 group lock."""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import tarfile
import zipfile

import numpy as np
from PIL import Image

from ml.dataset45.core import fingerprints
from ml.dataset45.duplicates import duplicate_pairs
from ml.scripts.data65 import src_vdd
from ml.scripts.dut63 import read_shard
from ml.scripts.prepare_eval_data import download
from ml.scripts.real64_prepare import flying, halmstad, read_description

ML = Path(__file__).resolve().parents[1]
HALMSTAD = json.loads((ML / "results/real64/sources.json").read_text())["obtained"]
DUT = json.loads((ML / "results/dut63/sources.json").read_text())
DATA65 = json.loads((ML / "results/data65/sources.json").read_text())["sources"]
COCO_ROOT = "https://s3.amazonaws.com/images.cocodataset.org"


def sha(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def archives(raw: Path, fetch: bool) -> dict:
    h, f = HALMSTAD
    vdd = next(source for source in DATA65 if source["name"].startswith("Visual drone"))
    dut = DUT["detection_files"]["validation"][0]
    sources = {
        "halmstad.zip": (h["download"], h["file_sha256"]),
        "halmstad.xlsx": (h["description_xlsx"]["url"], h["description_xlsx"]["sha256"]),
        "skymonioring.tar": (f["download"], f["file_sha256"]),
        "val-00002.parquet": (f"{DUT['source']}/resolve/{DUT['revision']}/{dut['path']}?download=true", dut["sha256"]),
        "vdd.zip": (vdd["url"] + "/files/Visual%20drone%20detection.v2i.yolov11_no_augmentation.zip?download=1", vdd["sha256"]),
        "coco-annotations.zip": (COCO_ROOT + "/annotations/annotations_trainval2017.zip",
                                 "113a836d90195ee1f884e704da6304dfaaecff1f023f49b6ca93c4aaae470268"),
    }
    for name, (url, expected) in sources.items():
        path = raw / name
        if fetch:
            download(url, path)
        if sha(path) != expected:
            raise ValueError(f"SHA-256 mismatch: {path}")
    return {name: expected for name, (_, expected) in sources.items()}


def halmstad_records(raw: Path, out: Path) -> list[dict]:
    lock_path = ML / "results/real64/split_summary.json"
    lock = json.loads(lock_path.read_text())["groups"]["halmstad"]
    sealed = set(json.loads((lock_path.parent / "sealed_test.json").read_text())["sealed_test_videos"])
    groups = {seq: (group, lock["group_splits"][group])
              for group, sequences in lock["group_sequences"].items() for seq in sequences}
    videos = out / "halmstad-videos"
    videos.mkdir()
    description = read_description(raw / "halmstad.xlsx")
    with zipfile.ZipFile(raw / "halmstad.zip") as archive:
        for member in archive.namelist():
            name = Path(member).name
            if "/Video_V/" not in member or not re.fullmatch(r"V_[A-Z]+_\d+(\.mp4|_LABELS\.mat)", name):
                continue
            video = name.split(".")[0].removesuffix("_LABELS")
            seq = f"halmstad:{video}"
            # Only own videos with a known train/validation group. Never decode sealed clips.
            if seq in sealed or groups.get(seq, (None, None))[1] not in {"train", "validation"}:
                continue
            if video not in description or "http" in str(description[video]["source_note"]):
                raise ValueError(f"Missing or conflicting provenance for {video}")
            (videos / name).write_bytes(archive.read(member))
    records, _ = halmstad(videos, raw / "halmstad.xlsx", out, every=30)
    for record in records:
        seq = record["sequence_id"]
        group, split = groups[seq]
        record.update(group=group, split=split, source_id=seq)
    # A drone-video frame without a target annotation is ambiguous.
    return [r for r in records if r["annotations"] or r["other_objects"]]


def flying_records(raw: Path, out: Path) -> list[dict]:
    target = out / "flying-raw"
    target.mkdir()
    with tarfile.open(raw / "skymonioring.tar") as archive:
        for member in archive:
            if member.isfile() and re.fullmatch(r"(train|val|valid|test)_\d+\.(jpg|txt)", member.name):
                with archive.extractfile(member) as source:
                    (target / member.name).write_bytes(source.read())
    records = flying(target, out)
    if len(records) != 1630:
        raise ValueError(f"Unexpected Flying Object count: {len(records)}")
    for record in records:
        record.update(group=record["source_group"], split="test", source_id=record["source_group"])
    return records


def external_positives(raw: Path, out: Path) -> list[dict]:
    dut = [r for r in read_shard(raw / "val-00002.parquet", "val", out / "dut") if not r["auto_issues"]]
    for record in dut:
        record.update(dataset="dut", group="dut:unknown-scenes", source_id="dut:val-shard", split="test")
    vdd_dir = out / "vdd"
    with zipfile.ZipFile(raw / "vdd.zip") as archive:
        for member in archive.namelist():
            if re.fullmatch(r"(test|train|valid)/(images/[^/]+\.jpg|labels/[^/]+\.txt)", member):
                path = vdd_dir / member
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(member))
    vdd = src_vdd(vdd_dir)
    if len(vdd) != 717:
        raise ValueError(f"Unexpected VDD count: {len(vdd)}")
    for record in vdd:
        record.update(split="test", source_id="vdd:school-site")
    return dut + vdd


def coco_background(raw: Path, fetch: bool) -> list[dict]:
    """COCO has no drone category. Use only as weakly labelled background evaluation."""
    with zipfile.ZipFile(raw / "coco-annotations.zip") as archive:
        labels = json.loads(archive.read("annotations/instances_val2017.json"))
    excluded = {c["id"] for c in labels["categories"] if c["name"] in {"airplane", "bird", "kite"}}
    blocked = {a["image_id"] for a in labels["annotations"] if a["category_id"] in excluded}
    images = [im for im in labels["images"] if im["id"] not in blocked]
    images.sort(key=lambda im: hashlib.sha256(f"crop-cascade-v1:{im['id']}".encode()).hexdigest())

    def load(im):
        path = raw / "coco" / im["file_name"]
        if fetch:
            download(COCO_ROOT + "/val2017/" + im["file_name"], path)
        return dict(id=f"coco:{im['id']}", file=str(path.resolve()), dataset="coco",
                    group="coco:val2017", source_id="coco:val2017", split="test",
                    width=im["width"], height=im["height"], annotations=[])

    with ThreadPoolExecutor(max_workers=12) as pool:
        return list(pool.map(load, images[:128]))


def audit(records: list[dict], root: Path) -> tuple[list[dict], dict]:
    """Fail on crossing known provenance. Quarantine whole held-out groups for cross-split image matches."""
    roles = {}
    ids = set()
    for record in records:
        if record["id"] in ids:
            raise ValueError(f"Duplicate frame id: {record['id']}")
        ids.add(record["id"])
        for key in ("group", "source_id", "video_sha256"):
            identity = record.get(key)
            if identity and roles.setdefault((key, identity), record["split"]) != record["split"]:
                raise ValueError(f"Cross-split {key}: {identity}")
        path = (root / record["file"]).resolve()
        record["file"] = str(path.relative_to(root)) if path.is_relative_to(root) else str(path)
        if "mean_rgb_hex" not in record:
            with Image.open(path) as image:
                record.update(fingerprints(image))
        if "sha256" not in record:
            record["sha256"] = sha(path)

    # Compare development with evaluation, and train with calibration.
    parts = {split: [r for r in records if r["split"] == split] for split in ("train", "validation", "test")}
    @lru_cache(maxsize=None)
    def thumbnail(file: str) -> np.ndarray:
        with Image.open(root / file) as image:
            return np.array(image.convert("RGB").resize((32, 32), Image.Resampling.BOX), dtype=np.int16)

    findings = []
    ignored = Counter()
    quarantined = set()
    for earlier, later in (("train", "validation"), ("train", "test"), ("validation", "test")):
        for a in parts[earlier]:
            for b in parts[later]:
                for match in duplicate_pairs((a, b)):
                    if match["kind"] == "near_candidate":
                        first, second = thumbnail(a["file"]), thumbnail(b["file"])
                        mad = np.abs(first - second).mean()
                        if mad >= 5:
                            ignored["spatial_mismatch"] += 1
                            continue
                        match["thumbnail_mad_255"] = float(mad)
                    findings.append(match | {"held_out_group": b["group"]})
                    quarantined.add(b["group"])
    return ([r for r in records if r["group"] not in quarantined],
            {"cross_split_pixel_matches": findings, "quarantined_groups": sorted(quarantined),
             "nonconfirming_dhash_candidates": dict(ignored),
             "status": "Known groups, sources and video hashes disjoint. Unknown scene/pretraining provenance remains."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    raw, out = args.raw.resolve(), args.output.resolve()
    sources = archives(raw, args.download)
    out.mkdir(parents=True)
    records = halmstad_records(raw, out) + flying_records(raw, out) + external_positives(raw, out)
    records += coco_background(raw, args.download)
    records, leakage = audit(records, out)
    write_json(out / "manifest.json", {"version": 1, "archives_sha256": sources, "leakage": leakage, "records": records})
    print({split: sum(r["split"] == split for r in records) for split in ("train", "validation", "test")})


if __name__ == "__main__":
    main()

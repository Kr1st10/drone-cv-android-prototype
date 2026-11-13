"""Measure warm desktop CPU overhead and process RSS in separate baseline/cascade processes."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time

import cv2
import numpy as np

from ml.cascade.prepare import write_json
from ml.cascade.run import detector_for, frame_pixels, load_split, quantiles
from ml.cascade.runtime import BASE_CONF, CANDIDATE_CONF, SIZE, TOP_K, CropVerifier, proposals


def rss_kib():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())], text=True).strip())


def worker(args):
    cv2.setNumThreads(1)
    records = load_split(args.manifest, "test")
    # Same inputs in both processes; include all source types in a fixed sample.
    datasets = sorted({r["dataset"] for r in records})
    picked = []
    for dataset in datasets:
        source = [r for r in records if r["dataset"] == dataset]
        picked.extend(source[::17][:20])
    start_rss = rss_kib()
    detector = detector_for(args.yolo)
    detector_rss = rss_kib()
    before_session = time.perf_counter_ns()
    verifier = CropVerifier(args.classifier) if args.worker == "cascade" else None
    session_ms = (time.perf_counter_ns() - before_session) / 1e6 if verifier else None
    ready_rss = rss_kib()

    def one(rgb):
        rows = proposals(*detector.run(rgb), confidence=CANDIDATE_CONF if verifier else BASE_CONF)
        return verifier.score(rgb, rows) if verifier else rows

    warmup = frame_pixels(args.manifest, picked[0])
    for _ in range(5):
        one(warmup)
    for record in picked:
        one(frame_pixels(args.manifest, record))
    # Same number and order of full-frame decodes in both processes.
    warm_rss = rss_kib()
    frame_ms = []
    for record in picked:
        rgb = frame_pixels(args.manifest, record)
        start = time.perf_counter_ns()
        one(rgb)
        frame_ms.append((time.perf_counter_ns() - start) / 1e6)

    stress = {}
    if verifier:
        # Repeat the busiest actual post-NMS proposals to obtain a full batch of K.
        busiest = (warmup, np.empty((0, 5)))
        for record in picked:
            rgb = frame_pixels(args.manifest, record)
            rows = proposals(*detector.run(rgb))[:TOP_K]
            if len(rows) > len(busiest[1]):
                busiest = rgb, rows
        rgb, rows = busiest
        if len(rows):
            for count in (1, TOP_K):
                batch = rows[np.arange(count) % len(rows)]
                for _ in range(10):
                    verifier.score(rgb, batch)
                elapsed = []
                for _ in range(300):
                    start = time.perf_counter_ns()
                    verifier.score(rgb, batch)
                    elapsed.append((time.perf_counter_ns() - start) / 1e6)
                stress[str(count)] = quantiles(elapsed)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    isolation = None
    if verifier is None:
        # Measure the extra session and arena after warming YOLO with the same frames,
        # without further full-frame decoding or YOLO inference between RSS samples.
        before = rss_kib()
        verifier = CropVerifier(args.classifier)
        ready = rss_kib()
        rgb = warmup
        h, w = rgb.shape[:2]
        fixed = np.tile([w / 4, h / 4, 3 * w / 4, 3 * h / 4, .5], (TOP_K, 1))
        for _ in range(20):
            verifier.score(rgb, fixed)
        isolation = {"before_kib": before, "after_load_kib": ready,
                     "after_warming_batch8_kib": rss_kib()}
    print(json.dumps({"frames": len(picked), "runtime_rss_kib": start_rss, "detector_rss_kib": detector_rss,
                      "sessions_ready_rss_kib": ready_rss, "warmed_rss_kib": warm_rss,
                      "peak_rss_kib": peak / 1024 if sys.platform == "darwin" else peak,
                      "classifier_load_ms": session_ms, "pipeline_ms": quantiles(frame_ms),
                      "crop_batch_ms": stress, "incremental_classifier_rss": isolation}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--yolo", type=Path, required=True)
    parser.add_argument("--classifier", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--worker", choices=("baseline", "cascade"))
    args = parser.parse_args()
    if args.worker:
        worker(args)
        return
    runs = {}
    for mode in ("baseline", "cascade"):
        command = [sys.executable, "-m", "ml.cascade.benchmark", *sys.argv[1:], "--worker", mode]
        runs[mode] = json.loads(subprocess.check_output(command, text=True))
    write_json(args.output, {"platform": platform.platform(), "rss_unit": "KiB", "runs": runs,
                             "model_bytes": args.classifier.stat().st_size,
                             "input_batch_bytes": TOP_K * 3 * SIZE * SIZE * 4})


if __name__ == "__main__":
    main()

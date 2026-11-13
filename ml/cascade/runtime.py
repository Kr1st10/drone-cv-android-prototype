"""Offline CPU cascade using the project's verified YOLO11s ONNX."""
from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from ml.scripts import drone_detector as yolo

SIZE = 48
CONTEXT = 1.2
NMS_IOU = 0.7
BASE_CONF = 0.50
CANDIDATE_CONF = 0.05
TOP_K = 8


def session(path: Path, threads: int) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


class ProposalDetector:
    def __init__(self, model: Path):
        self.session = session(model, threads=2)
        image, = self.session.get_inputs()
        output, = self.session.get_outputs()
        if image.shape != [1, 3, 640, 640] or output.shape != [1, 5, 8400]:
            raise ValueError("Expected the project YOLO11s FP32 detector")
        self.input_name, self.output_name = image.name, output.name

    def run(self, rgb: np.ndarray):
        image, info = yolo.preprocess(rgb)
        raw = self.session.run([self.output_name], {self.input_name: image})[0]
        return raw, info


def proposals(raw, info, confidence=CANDIDATE_CONF) -> np.ndarray:
    detections = yolo.postprocess(raw, info, conf=confidence, iou=NMS_IOU)
    return np.array([[d.x1, d.y1, d.x2, d.y2, d.score] for d in detections
                     if d.x2 > d.x1 and d.y2 > d.y1], dtype=np.float64).reshape(-1, 5)


def crop(rgb: np.ndarray, box: np.ndarray) -> np.ndarray:
    x1, y1, x2, y2 = box[:4]
    dx, dy = (x2 - x1) * (CONTEXT - 1) / 2, (y2 - y1) * (CONTEXT - 1) / 2
    height, width = rgb.shape[:2]
    left = max(0, int(np.floor(x1 - dx)))
    top = max(0, int(np.floor(y1 - dy)))
    right = min(width, int(np.ceil(x2 + dx)))
    bottom = min(height, int(np.ceil(y2 + dy)))
    region = rgb[top:bottom, left:right]
    if not region.size:
        raise ValueError("Candidate lies outside the image")
    h, w = region.shape[:2]
    scale = SIZE / max(w, h)
    resized = cv2.resize(region, (max(1, round(w * scale)), max(1, round(h * scale))),
                         interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    h, w = resized.shape[:2]
    patch = np.full((SIZE, SIZE, 3), yolo.PAD_VALUE, dtype=np.uint8)
    top, left = (SIZE - h) // 2, (SIZE - w) // 2
    patch[top:top + h, left:left + w] = resized
    return patch


def tensor(patches: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(patches.transpose(0, 3, 1, 2), dtype=np.float32) / np.float32(255)


class CropVerifier:
    def __init__(self, model: Path):
        self.session = session(model, threads=1)
        image, = self.session.get_inputs()
        score, = self.session.get_outputs()
        if image.shape[1:] != [3, SIZE, SIZE] or image.type != "tensor(float)" or score.shape[1:] != [1]:
            raise ValueError("Expected float32 NCHW crop tensor and one probability per crop")
        self.input_name, self.output_name = image.name, score.name

    def probabilities(self, rgb: np.ndarray, boxes: np.ndarray) -> np.ndarray:
        if len(boxes) == 0:
            return np.empty(0, dtype=np.float32)
        patches = np.stack([crop(rgb, box) for box in boxes])
        return self.session.run([self.output_name], {self.input_name: tensor(patches)})[0][:, 0]

    def score(self, rgb: np.ndarray, boxes: np.ndarray) -> np.ndarray:
        selected = boxes[:TOP_K]
        probabilities = self.probabilities(rgb, selected)
        return np.column_stack((selected, probabilities, selected[:, 4] * probabilities))


def timed_frame(detector, verifier, rgb):
    start = time.perf_counter_ns()
    raw, info = detector.run(rgb)
    raw_done = time.perf_counter_ns()
    baseline = proposals(raw, info, BASE_CONF)
    base_done = time.perf_counter_ns()
    candidates = proposals(raw, info)
    nms_done = time.perf_counter_ns()
    rescored = verifier.score(rgb, candidates)
    verify_done = time.perf_counter_ns()
    timings = {
        "shared_preprocess_ort_ms": (raw_done - start) / 1e6,
        "baseline_nms_ms": (base_done - raw_done) / 1e6,
        "low_nms_ms": (nms_done - base_done) / 1e6,
        "crop_verifier_ms": (verify_done - nms_done) / 1e6,
        "added_ms": ((verify_done - base_done) - (base_done - raw_done)) / 1e6,
    }
    return baseline, candidates, rescored, timings

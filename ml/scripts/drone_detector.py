#!/usr/bin/env python3
"""Minimal, dependency-light ONNX Runtime inference for the YOLO11s drone detector.

This file is the reference implementation the Android code must reproduce:
letterbox -> NCHW float32 RGB [0,1] -> ONNX -> decode [1,5,8400] -> NMS -> undo letterbox.

CLI:
    python ml/scripts/drone_detector.py IMAGE [IMAGE ...] [--model PATH] [--conf 0.25]
           [--iou 0.7] [--save-dir DIR]
Prints one JSON object per image; boxes are in original-image pixels (x1, y1, x2, y2).
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

DEFAULT_MODEL = Path(__file__).resolve().parents[1] / "weights" / "yolo11s-drone-640.onnx"
INPUT_SIZE = 640
PAD_VALUE = 114
CLASS_NAMES = {0: "drone"}


@dataclass
class Detection:
    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    class_id: int = 0
    label: str = "drone"


@dataclass
class LetterboxInfo:
    scale: float  # resized = original * scale
    pad_x: float  # left padding in input pixels
    pad_y: float  # top padding in input pixels
    orig_w: int
    orig_h: int


def letterbox(img_rgb: np.ndarray, size: int = INPUT_SIZE) -> tuple[np.ndarray, LetterboxInfo]:
    """Resize keeping aspect ratio and pad to size x size (same rounding as Ultralytics LetterBox)."""
    import cv2

    h, w = img_rgb.shape[:2]
    r = min(size / h, size / w)
    new_w, new_h = int(round(w * r)), int(round(h * r))
    dw, dh = (size - new_w) / 2, (size - new_h) / 2
    if (w, h) != (new_w, new_h):
        img_rgb = cv2.resize(img_rgb, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    out = cv2.copyMakeBorder(img_rgb, top, bottom, left, right, cv2.BORDER_CONSTANT,
                             value=(PAD_VALUE, PAD_VALUE, PAD_VALUE))
    return out, LetterboxInfo(scale=r, pad_x=left, pad_y=top, orig_w=w, orig_h=h)


def preprocess(img_rgb: np.ndarray, size: int = INPUT_SIZE) -> tuple[np.ndarray, LetterboxInfo]:
    """RGB uint8 HWC -> float32 NCHW [1,3,size,size] in [0,1]."""
    lb, info = letterbox(img_rgb, size)
    x = lb.astype(np.float32) / 255.0
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
    return x, info


def nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> np.ndarray:
    """Greedy NMS on xyxy boxes. Returns kept indices sorted by descending score."""
    if boxes.shape[0] == 0:
        return np.zeros((0,), dtype=np.int64)
    x1, y1, x2, y2 = boxes.T
    areas = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    order = np.argsort(-scores, kind="stable")
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest]); yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest]); yy2 = np.minimum(y2[i], y2[rest])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thr]
    return np.asarray(keep, dtype=np.int64)


def postprocess(output: np.ndarray, info: LetterboxInfo, conf: float = 0.25, iou: float = 0.7,
                max_det: int = 300) -> list[Detection]:
    """Decode raw output [1, 4+nc, N] (cx, cy, w, h in input pixels; per-class scores in [0,1])."""
    out = np.asarray(output)
    if out.ndim != 3 or out.shape[0] != 1 or out.shape[1] < 5:
        raise ValueError(f"unexpected output shape {out.shape}, expected [1, 4+nc, N]")
    pred = out[0].T  # [N, 4+nc]
    cls_scores = pred[:, 4:]
    class_ids = cls_scores.argmax(axis=1)
    scores = cls_scores[np.arange(pred.shape[0]), class_ids]
    m = scores > conf
    if not np.any(m):
        return []
    cxcywh, scores, class_ids = pred[m, :4], scores[m], class_ids[m]
    boxes = np.empty_like(cxcywh)
    boxes[:, 0] = cxcywh[:, 0] - cxcywh[:, 2] / 2
    boxes[:, 1] = cxcywh[:, 1] - cxcywh[:, 3] / 2
    boxes[:, 2] = cxcywh[:, 0] + cxcywh[:, 2] / 2
    boxes[:, 3] = cxcywh[:, 1] + cxcywh[:, 3] / 2
    # Single class model -> class-agnostic NMS is equivalent to per-class NMS.
    keep = nms(boxes, scores, iou)[:max_det]
    boxes, scores, class_ids = boxes[keep], scores[keep], class_ids[keep]
    # Undo letterbox: input pixels -> original image pixels, clip to image.
    boxes[:, [0, 2]] = (boxes[:, [0, 2]] - info.pad_x) / info.scale
    boxes[:, [1, 3]] = (boxes[:, [1, 3]] - info.pad_y) / info.scale
    boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, info.orig_w)
    boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, info.orig_h)
    return [Detection(float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(s), int(c),
                      CLASS_NAMES.get(int(c), str(int(c))))
            for b, s, c in zip(boxes, scores, class_ids)]


class DroneDetector:
    def __init__(self, model_path: str | Path = DEFAULT_MODEL, threads: int = 0):
        import onnxruntime as ort

        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
        self.session = ort.InferenceSession(str(model_path), so, providers=["CPUExecutionProvider"])
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        self.input_size = int(inp.shape[2])
        self.output_name = self.session.get_outputs()[0].name

    def raw(self, x: np.ndarray) -> np.ndarray:
        return self.session.run([self.output_name], {self.input_name: x})[0]

    def detect(self, img_rgb: np.ndarray, conf: float = 0.25, iou: float = 0.7) -> list[Detection]:
        x, info = preprocess(img_rgb, self.input_size)
        return postprocess(self.raw(x), info, conf, iou)


def load_rgb(path: str | Path) -> np.ndarray:
    import cv2

    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(path)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def draw(img_rgb: np.ndarray, dets: list[Detection]) -> np.ndarray:
    import cv2

    out = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
    for d in dets:
        p1, p2 = (int(round(d.x1)), int(round(d.y1))), (int(round(d.x2)), int(round(d.y2)))
        cv2.rectangle(out, p1, p2, (0, 0, 255), 2)
        cv2.putText(out, f"{d.label} {d.score:.2f}", (p1[0], max(12, p1[1] - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+")
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--iou", type=float, default=0.7)
    ap.add_argument("--save-dir", default=None, help="write annotated images here")
    args = ap.parse_args()
    det = DroneDetector(args.model)
    for p in args.images:
        img = load_rgb(p)
        dets = det.detect(img, args.conf, args.iou)
        print(json.dumps({"image": str(p), "width": img.shape[1], "height": img.shape[0],
                          "detections": [asdict(d) for d in dets]}))
        if args.save_dir:
            import cv2

            Path(args.save_dir).mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(Path(args.save_dir) / Path(p).name), draw(img, dets))


if __name__ == "__main__":
    main()

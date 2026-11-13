"""Train a small crop CNN on mined training proposals and export a portable ONNX."""
from __future__ import annotations

import argparse
import json
from collections import Counter
import math
from pathlib import Path
import time

import numpy as np

from ml.cascade.prepare import ML, sha, write_json
from ml.cascade.runtime import CANDIDATE_CONF, NMS_IOU, SIZE, TOP_K, crop, tensor
from ml.scripts.drone_detector import load_rgb
from ml.scripts.evaluate import iou_matrix


def crop_labels(boxes: np.ndarray, gt: np.ndarray) -> np.ndarray:
    """1=drone, 0=background or another object, -1=ambiguous; never train on -1."""
    if not len(gt):
        return np.zeros(len(boxes), dtype=np.int8)
    ious = iou_matrix(boxes[:, :4], gt)
    centers = (boxes[:, :2] + boxes[:, 2:4]) / 2
    gt_centers = (gt[:, :2] + gt[:, 2:]) / 2
    in_gt = ((centers[:, None, :] >= gt[None, :, :2]) &
             (centers[:, None, :] <= gt[None, :, 2:])).all(axis=2)
    gt_in_pred = ((gt_centers[None, :, :] >= boxes[:, None, :2]) &
                  (gt_centers[None, :, :] <= boxes[:, None, 2:4])).all(axis=2)
    positive = ((ious >= .3) | ((ious >= .1) & in_gt & gt_in_pred)).any(axis=1)
    # Avoid labelling an off-centre or poorly localised drone as background.
    close = (np.abs(centers[:, None, :] - gt_centers[None, :, :]) <=
             1.5 * (gt[:, 2:] - gt[:, :2])[None, :, :]).all(axis=2)
    return np.where(positive, 1, np.where((ious >= .05).any(axis=1) | close.any(axis=1), -1, 0))


def drone_boxes(record: dict) -> np.ndarray:
    return np.array([a["xyxy"] for a in record["annotations"] if a["class"] == "drone"],
                    dtype=np.float64).reshape(-1, 4)


def train(manifest: Path, records: list[dict], mined: dict, output: Path):
    import onnx
    import onnxruntime as ort
    import torch
    from torch import nn

    seed, epochs = 65, 20
    torch.set_num_threads(2)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)
    layers = [
        nn.Conv2d(3, 12, 3, stride=2, padding=1), nn.ReLU(),
        nn.Conv2d(12, 20, 3, stride=2, padding=1), nn.ReLU(),
        nn.Conv2d(20, 24, 3, stride=2, padding=1), nn.ReLU(),
        nn.AvgPool2d(3), nn.Flatten(), nn.Linear(96, 1),
    ]
    model = nn.Sequential(*layers)
    patches, labels, strata = [], [], []
    ignored = 0
    for record in records:
        if record["split"] != "train":
            raise ValueError("Classifier may only consume training frames")
        candidates = np.asarray(mined[record["id"]], dtype=np.float64).reshape(-1, 5)[:TOP_K]
        y = crop_labels(candidates, drone_boxes(record))
        ignored += int((y < 0).sum())
        if (y >= 0).any():
            path = manifest.parent / record["file"]
            if sha(path) != record["sha256"]:
                raise ValueError(f"Frame bytes differ from manifest: {path}")
            rgb = load_rgb(path)
            if rgb.shape[:2] != (record["height"], record["width"]):
                raise ValueError(f"Decoded frame dimensions differ from manifest: {path}")
            for box, label in zip(candidates, y):
                if label >= 0:
                    patches.append(crop(rgb, box))
                    labels.append(int(label))
                    strata.append((int(label), record["group"]))

    count = Counter(labels)
    if len(count) != 2:
        raise ValueError("Training requires mined candidates of both classes")
    group_counts = Counter(strata)
    weights = np.array([1 / math.sqrt(group_counts[stratum]) for stratum in strata])
    for label in (0, 1):
        mask = np.asarray(labels) == label
        weights[mask] /= weights[mask].sum()
    x = torch.from_numpy(tensor(np.stack(patches)))
    y = torch.tensor(labels, dtype=torch.float32).unsqueeze(1)
    weight = torch.tensor(weights / weights.mean(), dtype=torch.float32).unsqueeze(1)
    rng = torch.Generator().manual_seed(seed)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002)
    loss_fn = nn.BCEWithLogitsLoss(reduction="none")
    losses = []
    started = time.perf_counter()
    for _ in range(epochs):
        batch_losses = []
        for indices in torch.randperm(len(x), generator=rng).split(64):
            batch = x[indices]
            flip = torch.rand(len(indices), generator=rng) < .5
            batch[flip] = batch[flip].flip(-1)
            optimizer.zero_grad()
            loss = (loss_fn(model(batch), y[indices]) * weight[indices]).mean()
            loss.backward()
            optimizer.step()
            batch_losses.append(float(loss.detach()) * len(indices))
        losses.append(sum(batch_losses) / len(x))
    seconds = time.perf_counter() - started

    exported = nn.Sequential(model.eval(), nn.Sigmoid()).eval()
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(exported, x[:1], str(output), opset_version=17, dynamo=False,
                      input_names=["rgb"], output_names=["p_drone"],
                      dynamic_axes={"rgb": {0: "crops"}, "p_drone": {0: "crops"}})
    onnx.checker.check_model(str(output))
    check = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    samples = x[torch.randperm(len(x), generator=rng)[:32]]
    errors = []
    for n in (1, 2, 8, 32):
        actual = check.run(None, {"rgb": samples[:n].numpy()})[0]
        expected = exported(samples[:n]).detach().numpy()
        np.testing.assert_allclose(actual, expected, atol=2e-6, rtol=1e-5)
        errors.append(float(np.max(np.abs(actual - expected))))
    write_json(output.with_suffix(".json"), {
        "architecture": "RGB48, Conv3s2 12/20/24, ReLU, AvgPool3, Linear, Sigmoid",
        "seed": seed, "epochs": epochs, "seconds": seconds, "torch": torch.__version__,
        "parameters": sum(p.numel() for p in model.parameters()), "train_frames": len(records),
        "crops_by_label": dict(count), "ambiguous_skipped": ignored, "train_losses": losses,
        "max_onnx_export_abs_error": max(errors), "onnx_bytes": output.stat().st_size,
        "onnx_sha256": sha(output), "manifest_sha256": sha(manifest),
        "training_groups": sorted({record["group"] for record in records}),
        "crop_counts_by_group_and_label": [
            {"group": group, "label": label, "crops": n}
            for (label, group), n in sorted(group_counts.items())
        ],
    })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--mined", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest_data = json.loads(args.manifest.read_text())
    cache = json.loads(args.mined.read_text())
    if cache["manifest_sha256"] != sha(args.manifest):
        raise ValueError("Mining cache belongs to a different manifest")
    production_sha = json.loads((ML / "model_manifest.json").read_text())["android"]["onnx_sha256"]
    if (cache["candidate_conf"], cache["nms_iou"], cache["top_k"], cache["yolo_sha256"]) != (
        CANDIDATE_CONF, NMS_IOU, TOP_K, production_sha
    ):
        raise ValueError("Mining cache has incompatible proposal settings or YOLO weights")
    train(args.manifest, [r for r in manifest_data["records"] if r["split"] == "train"],
          cache["proposals"], args.output)

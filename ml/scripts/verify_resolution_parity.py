#!/usr/bin/env python3
"""Check raw PyTorch vs static ONNX outputs on representative inputs, no inference benchmark."""
import json
from pathlib import Path
import numpy as np
import torch
from ultralytics import YOLO
import drone_detector as dd
from resolution_experiment import ML, OUT, WEIGHTS, SIZES, sha256

def main():
    torch.set_num_threads(2)
    model = YOLO(str(WEIGHTS / 'best.pt')).model.float().eval()
    cases = [ML/'data/pathikg_test/images/00001.jpg', ML/'data/pathikg_test/images/00022.jpg',
             ML/'data/coco_neg/images/000000400922.jpg']
    results = {}
    for size in SIZES:
        det = dd.DroneDetector(WEIGHTS/f'yolo11s-drone-{size}.onnx', threads=2)
        records = []
        for path in cases:
            x, _ = dd.preprocess(dd.load_rgb(path), size)
            with torch.no_grad():
                y = model(torch.from_numpy(x))
            if isinstance(y, (tuple, list)): y = y[0]
            a=y.cpu().numpy(); b=det.raw(x)
            if a.shape != b.shape: raise AssertionError((a.shape,b.shape))
            box=float(np.max(np.abs(a[:, :4, :] - b[:, :4, :])))
            score=float(np.max(np.abs(a[:, 4:, :] - b[:, 4:, :])))
            records.append({'image': str(path.relative_to(ML)), 'max_abs_box_px': box, 'max_abs_score': score})
            print(size,path.name,box,score,flush=True)
            if box > 0.1 or score > 0.001: raise AssertionError('ONNX differs from checkpoint')
        results[str(size)] = records
        del det
    out={'checkpoint_sha256':sha256(WEIGHTS/'best.pt'), 'absolute_tolerance':{'box_px':0.1,'score':0.001}, 'results':results}
    (OUT/'parity.json').write_text(json.dumps(out,indent=2)+'\n')

if __name__ == '__main__': main()

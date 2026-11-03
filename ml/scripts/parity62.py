#!/usr/bin/env python3
"""Check raw single-class YOLO11s checkpoint against exported static ONNX."""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
import torch
import ultralytics
from ultralytics import YOLO
import drone_detector as dd


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--checkpoint', type=Path, required=True); p.add_argument('--onnx', type=Path, required=True)
    p.add_argument('--image', type=Path, action='append', required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args(); torch.set_num_threads(2)
    model = YOLO(str(a.checkpoint)).model.float().eval()
    graph = onnx.load(str(a.onnx)); onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(a.onnx), providers=['CPUExecutionProvider'])
    ins, outs = session.get_inputs(), session.get_outputs()
    if len(ins) != 1 or ins[0].shape != [1,3,640,640] or len(outs) != 1 or outs[0].shape != [1,5,8400]: raise ValueError('unexpected tensor shapes')
    results=[]
    for img in a.image:
        x,_ = dd.preprocess(dd.load_rgb(img), 640)
        with torch.no_grad(): y = model(torch.from_numpy(x))
        if isinstance(y,(tuple,list)): y=y[0]
        pt=y.cpu().numpy(); exported=session.run(None,{ins[0].name:x})[0]
        if pt.shape != exported.shape: raise ValueError('output shape mismatch')
        box=float(np.max(np.abs(pt[:,:4,:]-exported[:,:4,:]))); score=float(np.max(np.abs(pt[:,4:,:]-exported[:,4:,:])))
        results.append({'image_name':img.name,'image_sha256':sha(img),'max_abs_box_px':box,'max_abs_score':score})
        if box > .1 or score > .001: raise ValueError('raw outputs differ beyond tolerance')
    out={'checkpoint_sha256':sha(a.checkpoint),'onnx_sha256':sha(a.onnx),
         'input':{'name':ins[0].name,'shape':ins[0].shape,'type':ins[0].type},
         'output':{'name':outs[0].name,'shape':outs[0].shape,'type':outs[0].type},
         'absolute_tolerance':{'box_px':.1,'score':.001},'samples':results,
         'versions':{'python':platform.python_version(),'torch':torch.__version__,'ultralytics':ultralytics.__version__,'onnx':onnx.__version__,'onnxruntime':ort.__version__},
         'note':'Raw pre-NMS outputs; parity is not accuracy, latency, Android or QNN compatibility.'}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps(out,indent=2))

if __name__ == '__main__': main()

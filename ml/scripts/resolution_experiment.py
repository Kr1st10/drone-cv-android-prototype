#!/usr/bin/env python3
"""Stage 4.2: same YOLO11s weights and stage 4.1 subset, static 640/960/1280 ONNX vs SAHI 416.

Run from repository root after stage 4.1 data preparation and pip install -r ml/requirements.txt:
  python ml/scripts/resolution_experiment.py export
  for mode in 640 960 1280 sahi416; do python ml/scripts/resolution_experiment.py run --mode $mode; done
  python ml/scripts/resolution_experiment.py report
Each mode is a fresh process; raw per-image results are ignored, summary.json is reproducible output.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import platform
import resource
import shutil
import time
from pathlib import Path

import numpy as np
import drone_detector as dd
import sahi_experiment as se
from fetch_and_export import fetch_checkpoint, export_onnx
from evaluate import load_gt

ML = Path(__file__).resolve().parents[1]
OUT = ML / 'results' / 'resolution'
WEIGHTS = ML / 'weights'
CONF = 0.5
THREADS = 2
SIZES = (640, 960, 1280)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def export():
    import onnx
    import onnxruntime as ort
    import torch
    import ultralytics
    from ultralytics import YOLO
    pt = fetch_checkpoint()  # validates source weights SHA-256 against model_manifest.json
    baseline = WEIGHTS / 'yolo11s-drone-640.onnx'
    if not baseline.exists():
        export_onnx(pt)
    info = {}
    for size in SIZES:
        target = WEIGHTS / f'yolo11s-drone-{size}.onnx'
        if size != 640:
            model = YOLO(str(pt))
            generated = Path(model.export(format='onnx', imgsz=size, opset=17, simplify=True,
                                          dynamic=False, half=False, nms=False, device='cpu'))
            graph = onnx.load(str(generated))
            props = [p for p in graph.metadata_props if p.key != 'date']
            del graph.metadata_props[:]; graph.metadata_props.extend(props)
            onnx.checker.check_model(graph)
            onnx.save(graph, str(target))
            if generated.resolve() != target.resolve(): generated.unlink()
        session = ort.InferenceSession(str(target), providers=['CPUExecutionProvider'])
        shape = session.get_inputs()[0].shape
        assert shape == [1, 3, size, size], f'Unexpected static input: {shape}'
        info[str(size)] = {'file': target.name, 'sha256': sha256(target), 'input': shape,
                           'output': session.get_outputs()[0].shape}
        print(f'export {size}: {info[str(size)]}', flush=True)
        del session
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'exports.json').write_text(json.dumps({'pt_sha256': sha256(pt), 'models': info,
        'versions': {'torch': torch.__version__, 'ultralytics': ultralytics.__version__,
                     'onnx': onnx.__version__, 'onnxruntime': ort.__version__}}, indent=2) + '\n')


def run(mode):
    import onnxruntime as ort
    import cv2
    size = 640 if mode == 'sahi416' else int(mode)
    if mode not in ('640','960','1280','sahi416'): raise ValueError(mode)
    subset = se.load_subset()
    pos, neg = subset['positives'], subset['negatives']
    if len(pos) != 360 or len(neg) != 200: raise ValueError('Expected stage 4.1 subset: 360 positives + 200 negatives')
    items = [('pos', x, ML / 'data/pathikg_test/images' / x['file']) for x in pos] + [
             ('neg', x, ML / 'data/coco_neg/images' / x['file']) for x in neg]
    # Match stage 4.1: decode all images before timing; preprocessing, inference and NMS are measured.
    images = {it['file']: dd.load_rgb(path) for _, it, path in items}
    detector = se.OnnxDetect(WEIGHTS / f'yolo11s-drone-{size}.onnx', threads=THREADS)
    model_input = detector.det.session.get_inputs()[0].shape
    if model_input != [1,3,size,size]: raise ValueError(f'Unexpected input shape: {model_input}')
    raw_original = detector.det.raw
    model_elapsed = [0.0]
    def timed_raw(x):
        started = time.perf_counter()
        try: return raw_original(x)
        finally: model_elapsed[0] += (time.perf_counter() - started) * 1000
    detector.det.raw = timed_raw
    def predict(img):
        if mode == 'sahi416': return se.sahi_predict(img, detector, CONF, 416, 0.2, True, 'IOS')
        return detector(img, CONF)
    for _ in range(3): predict(images[pos[0]['file']])
    records=[]
    for idx, (kind, it, _) in enumerate(items):
        img=images[it['file']]
        gt=(load_gt(ML/'data/pathikg_test/labels'/it['file'].replace('.jpg','.txt'), img.shape[1], img.shape[0])
            if kind == 'pos' else np.zeros((0,4)))
        model_elapsed[0]=0.0
        t=time.perf_counter(); dets=predict(img); ms=(time.perf_counter()-t)*1000
        model_ms=model_elapsed[0]
        r=se.eval_image(dets,gt)
        sizes=np.sqrt((gt[:,2]-gt[:,0])*(gt[:,3]-gt[:,1]))
        records.append({'file':it['file'],'kind':kind,'subset':it.get('subset'), 'tp':r['tp'],
                        'fp':r['fp'],'fn':r['fn'],'hit':r['gt_hit'], 'sizes':sizes.tolist(), 'ms':ms, 'model_ms':model_ms})
        if (idx+1)%100==0: print(f'{mode}: {idx+1}/{len(items)}',flush=True)
    # ru_maxrss is peak of whole fresh process, includes model, cached decoded inputs, imports etc.
    cpu='unknown'
    for line in Path('/proc/cpuinfo').read_text().splitlines():
        if line.startswith('model name'): cpu=line.split(':',1)[1].strip(); break
    OUT.mkdir(parents=True, exist_ok=True)
    result={'mode':mode,'confidence':CONF,'match_iou':se.MATCH_IOU,'nms_iou':se.NMS_IOU,
            'threads':THREADS,'model_sha256':sha256(WEIGHTS/f'yolo11s-drone-{size}.onnx'),
            'subset_sha256':sha256(ML/'results/sahi/subset.json'),
            'environment':{'cpu':cpu,'logical_cpus':__import__('os').cpu_count(), 'platform':platform.platform(),
                           'python':platform.python_version(),'onnxruntime':ort.__version__,
                           'numpy':np.__version__,'opencv':cv2.__version__},
            'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'images':records}
    (OUT / f'raw_{mode}.json').write_text(json.dumps(result,separators=(',',':')))
    print(f'wrote {mode}, peak RSS {result["peak_rss_kib"]} KiB',flush=True)


def summarize(data):
    pos=[r for r in data['images'] if r['kind']=='pos']; neg=[r for r in data['images'] if r['kind']=='neg']
    tp=sum(r['tp'] for r in pos); fp_pos=sum(r['fp'] for r in pos); fn=sum(r['fn'] for r in pos)
    fp_neg=sum(r['fp'] for r in neg); hit=[(h,s) for r in pos for h,s in zip(r['hit'],r['sizes'])]
    by_size={}
    for label,lo,hi in [('<16',0,16),('16-24',16,24),('24-32',24,32),('32-96',32,96),('>=96',96,float('inf'))]:
        arr=[h for h,s in hit if lo<=round(float(s), 2)<hi]  # stage 4.1 stores sizes rounded to 0.01 px
        by_size[label]={'n':len(arr),'tp':sum(arr),'recall':sum(arr)/len(arr) if arr else None}
    times=[r['ms'] for r in data['images']]
    model_times=[r['model_ms'] for r in data['images']]
    return {'images':len(data['images']),'positive_images':len(pos),'negative_images':len(neg),
            'gt':tp+fn,'tp':tp,'fn':fn,'fp_positive':fp_pos,'fp_negative':fp_neg,'fp_all':fp_pos+fp_neg,
            'precision_all':tp/(tp+fp_pos+fp_neg) if tp+fp_pos+fp_neg else 0,
            'recall':tp/(tp+fn) if tp+fn else 0,'recall_by_size':by_size,
            'negative_images_with_fp':sum(r['fp']>0 for r in neg),
            'latency_ms':{'mean':float(np.mean(times)),'median':float(np.median(times)),'p90':float(np.percentile(times,90))},
            'model_inference_ms':{'mean':float(np.mean(model_times)),'median':float(np.median(model_times))},
            'peak_rss_kib':data['peak_rss_kib'],'model_sha256':data['model_sha256'],
            'subset_sha256':data['subset_sha256'],'environment':data['environment']}


def report():
    modes=('640','960','1280','sahi416')
    result={m:summarize(json.loads((OUT/f'raw_{m}.json').read_text())) for m in modes}
    if len({r['subset_sha256'] for r in result.values()}) != 1: raise ValueError('Subset hashes differ')
    if len({json.dumps(r['environment'],sort_keys=True) for r in result.values()}) != 1: raise ValueError('Environments differ')
    (OUT/'summary.json').write_text(json.dumps({'confidence':CONF,'match_iou':se.MATCH_IOU,'nms_iou':se.NMS_IOU,
        'memory_note':'Linux peak RSS for each complete fresh process, includes decoded images and libraries',
        'timing_note':'latency_ms: preprocess + inference + postprocess; model_inference_ms: sum of ORT session calls; JPEG decoding excluded; per mode fresh process',
        'results':result},indent=2)+'\n')
    print(json.dumps(result,indent=2))


def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    sub.add_parser('export'); runp=sub.add_parser('run'); runp.add_argument('--mode',required=True,choices=['640','960','1280','sahi416']); sub.add_parser('report')
    a=p.parse_args()
    if a.cmd=='export': export()
    elif a.cmd=='run': run(a.mode)
    else: report()
if __name__ == '__main__': main()

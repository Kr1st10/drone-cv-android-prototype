"""Geometry, metrics and NMS regressions for stage 4.2 (no model required)."""
import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import drone_detector as dd
import resolution_experiment as rexp

class ResolutionTests(unittest.TestCase):
    def test_letterbox_and_inverse_coordinates_at_all_resolutions(self):
        img=np.zeros((480,640,3),np.uint8)
        for size in (640,960,1280):
            x,info=dd.preprocess(img,size)
            self.assertEqual(x.shape,(1,3,size,size))
            # Encode a known box in model-input coordinates and verify exact inverse transform.
            x1,y1,x2,y2=100.,80.,120.,100.
            cx=((x1+x2)/2)*info.scale+info.pad_x; cy=((y1+y2)/2)*info.scale+info.pad_y
            out=np.array([[[cx],[cy],[(x2-x1)*info.scale],[(y2-y1)*info.scale],[.9]]],dtype=np.float32)
            d=dd.postprocess(out,info,0.5,0.7)
            self.assertEqual(len(d),1)
            np.testing.assert_allclose([d[0].x1,d[0].y1,d[0].x2,d[0].y2],[x1,y1,x2,y2],atol=1e-4)

    def test_nms_suppresses_duplicate(self):
        boxes=np.array([[0,0,20,20],[0,0,20,20],[40,40,60,60]],float)
        self.assertEqual(dd.nms(boxes,np.array([.9,.8,.7]),.7).tolist(),[0,2])

    def test_precision_includes_negative_detections(self):
        data={'images':[{'kind':'pos','tp':1,'fp':1,'fn':0,'hit':[True],'sizes':[20.],'ms':10,'model_ms':7},
                        {'kind':'neg','tp':0,'fp':2,'fn':0,'hit':[],'sizes':[],'ms':20,'model_ms':14}],
              'peak_rss_kib':1,'model_sha256':'a','subset_sha256':'b','environment':{}}
        s=rexp.summarize(data)
        self.assertEqual((s['fp_positive'],s['fp_negative'],s['precision_all']),(1,2,.25))
        self.assertEqual((s['recall_by_size']['16-24']['n'],s['recall_by_size']['16-24']['recall']),(1,1))
        self.assertEqual(s['latency_ms']['median'],15)

if __name__=='__main__': unittest.main()

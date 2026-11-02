"""Regression tests for report precision scope and latency denominator, without inference."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import sahi_experiment as se


class ReportMetricsTest(unittest.TestCase):
    def test_precision_scopes_include_each_negative_detection(self):
        r = {'tp': 289, 'fp': 22,
             'negatives': {'hard': {'detections': 43}, 'random': {'detections': 19}}}
        self.assertAlmostEqual(289 / (289 + 22), 0.9292604501607717)
        self.assertAlmostEqual(se.precision_all(r), 289 / (289 + 22 + 43 + 19))
        self.assertEqual(f'{se.precision_all(r):.3f}', '0.775')

    def test_no_predictions_zero(self):
        r = {'tp': 0, 'fp': 0, 'negatives': {'hard': {'detections': 0}, 'random': {'detections': 0}}}
        self.assertEqual(se.precision_all(r), 0.0)

    def test_report_generator_uses_saved_aggregate_and_same_baseline(self):
        # Synthetic aggregates keep this test stable if later runs change measurements.
        def record(tp, fp, hard, random, mean, p50, p90, pos_mean):
            return dict(tp=tp, fp=fp, fn=383-tp, precision=tp/(tp+fp), recall=tp/383,
                        f1=0.0, dup_fp_on_matched_gt=0,
                        vs_baseline=dict(gt_gained=0, gt_lost=0),
                        negatives=dict(hard=dict(images=100, images_with_detections=0, detections=hard),
                                       random=dict(images=100, images_with_detections=0, detections=random)),
                        recall_by_size={k: dict(n_gt=1, recall=0.0) for k in se.SIZE_BUCKETS},
                        latency_ms=dict(mean=mean, p50=p50, p90=p90, mean_pos_640x480=pos_mean),
                        inferences_per_image=dict(mean=1, min=1, max=1))
        base = record(289, 22, 43, 19, 102.71308928571429, 101.6, 104.8, 102.3)
        sahi = record(311, 22, 72, 43, 523.2364285714286, 529.3, 587.5, 549.2)
        sahi320 = record(309, 42, 92, 56, 762.2059642857142, 749.5, 845.7, 789.2)
        summary = {name: {'0.25': r, '0.5': r} for name, r in
                   [('baseline', base), ('sahi_416_ov0.2_full', sahi), ('sahi_320_ov0.2_full', sahi320)]}
        env = dict(cpu='test', logical_cpus=2, ort_intra_op_threads=2, python='test',
                   onnxruntime='test', sahi='test', numpy='test', opencv='test', onnx_sha256='test')
        data = dict(env=env, confs=[0.25, 0.5], nms_iou=0.7, match_iou=0.5)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / 'sahi_eval.json').write_text(json.dumps(data))
            with patch.object(se, 'OUT_DIR', out), patch.object(se, 'summarize', return_value=summary):
                with contextlib.redirect_stdout(io.StringIO()):
                    se.report()
            report = (out / 'REPORT_TABLES.md').read_text()
        self.assertIn('| P позитивы | P вся выборка |', report)
        self.assertIn('| baseline | 0.929 | 0.775 |', report)
        self.assertIn('| sahi_416_ov0.2_full | 0.934 | 0.694 |', report)
        self.assertIn('| 523.2 | 529.3 | 587.5 | 549.2 | 5.09 |', report)
        self.assertIn('| 762.2 | 749.5 | 845.7 | 789.2 | 7.42 |', report)


if __name__ == '__main__':
    unittest.main()

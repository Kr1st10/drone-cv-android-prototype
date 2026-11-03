import copy
import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('analyzer', Path(__file__).parents[1] / 'scripts/analyze_android_sessions.py')
a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)


def sample(n=20):
    frames = [dict(offset_ms=i+1, conversion_ms=1., preprocess_ms=2., ort_ms=3., postprocess_ms=4., pipeline_ms=11.) for i in range(n)]
    return dict(schema_version=1, started_epoch_ms=10, device='d', android_release='10', android_sdk=29, app_version='v', model={}, duration_ms=1000., interrupted=False, reason=None, frames=frames, resources=[dict(offset_ms=1,pss_kb=100),dict(offset_ms=2,pss_kb=120)], completed_frames=n, unstored_frames=0, analyzer_callbacks_accepted=n+1, accepted_callbacks_not_completed=1, processed_fps_session=n, pss_first_to_last_sample_delta_kb=20, timing_summary_ms={k:a.summary([f[v] for f in frames]) for k,v in a.STAGES.items()})


def test_summary_nearest_rank_and_small_sample():
    assert a.summary(list(range(1, 21)))['p95_nearest_rank'] == 19
    assert a.summary([1,2])['median'] == 1.5
    assert a.summary([1,2])['p95_nearest_rank'] is None
    assert a.summary([]) is None
    with pytest.raises(ValueError): a.summary([float('nan')])


def test_roundtrip_and_wall_fps():
    r=a.analyze(sample()); assert not r['errors']; assert r['fps']==20
    assert r['ort_share_of_pipeline']==pytest.approx(3/11)
    assert r['pss_delta_kb']==20


def test_mismatches_are_reported():
    d=sample(); d['timing_summary_ms']['conversion']['mean']=999; d['completed_frames']+=1
    r=a.analyze(d); assert any('mean' in x for x in r['errors']); assert any('completed' in x for x in r['errors'])


def test_out_of_order_and_out_of_range():
    d=sample(); d['frames'][0]['offset_ms']=1001
    r=a.analyze(d); assert any('invalid offset' in x for x in r['errors']); assert any('non-monotonic' in x for x in r['errors'])


def test_truncation_and_interruption():
    d=sample(); d['unstored_frames']=2; d['completed_frames']+=2; d['analyzer_callbacks_accepted']+=2; d['processed_fps_session']=22; d['interrupted']=True; d['reason']='pause'
    r=a.analyze(d); assert not r['errors']; assert len(r['warnings'])==3


def test_empty_zero_duration():
    d=sample(0); d['duration_ms']=0; d['processed_fps_session']=None; d['resources']=[]; d['pss_first_to_last_sample_delta_kb']=None
    r=a.analyze(d); assert r['fps'] is None and not r['errors']; assert r['minute_windows']==[]


def test_unsupported_version():
    d=sample(); d['schema_version']=2
    with pytest.raises(ValueError): a.analyze(d)


def test_frame_at_stop_is_counted_in_last_window():
    d=sample(); d['frames'][-1]['offset_ms']=d['duration_ms']
    r=a.analyze(d); assert sum(w['frames'] for w in r['minute_windows']) == d['completed_frames']


def test_cli_rejects_incompatible_configs(tmp_path):
    import json, subprocess, sys
    one=sample(); two=copy.deepcopy(one); two['device']='different'
    for i, item in enumerate([one,two]): (tmp_path / f'{i}.json').write_text(json.dumps(item))
    out=tmp_path / 'out.json'
    result=subprocess.run([sys.executable, str(Path(__file__).parents[1] / 'scripts/analyze_android_sessions.py'),str(tmp_path/'0.json'),str(tmp_path/'1.json'),'--output',str(out)],capture_output=True)
    assert result.returncode != 0 and json.loads(out.read_text())['config_mismatches']


def test_thread_comparison_accepts_only_expected_difference():
    d=sample(); d['model']={'intra_op_threads':2,'inter_op_threads':1,'execution_mode':'SEQUENTIAL','execution_provider':'CPU','backend':'ONNX Runtime CPU, intra-op 2, inter-op 1','sha256':'abc'}
    d['build_type']='debug'; d['warmup']={'method':'manual','completed_frames_before_session':30}
    r=a.analyze(d); e=copy.deepcopy(d); e['model']['intra_op_threads']=4; e['model']['backend']='ONNX Runtime CPU, intra-op 4, inter-op 1'
    assert a.thread_comparison_key(r)==a.thread_comparison_key(a.analyze(e))
    e['model']['inter_op_threads']=2
    with pytest.raises(ValueError): a.thread_comparison_key(a.analyze(e))


def test_legacy_report_is_analyzable_but_not_silently_comparable():
    r=a.analyze(sample()); assert not r['errors']
    with pytest.raises(ValueError): a.thread_comparison_key(r)


def test_thread_backend_conflict_and_missing_warmup_rejected():
    d=sample(); d['model']={'intra_op_threads':4,'inter_op_threads':1,'execution_mode':'SEQUENTIAL','execution_provider':'CPU','backend':'ONNX Runtime CPU, intra-op 2, inter-op 1'}; d['build_type']='debug'
    d['warmup']={'method':'manual','completed_frames_before_session':30}
    with pytest.raises(ValueError): a.thread_comparison_key(a.analyze(d))
    d['model']['backend']='ONNX Runtime CPU, intra-op 4, inter-op 1'; del d['warmup']
    with pytest.raises(ValueError): a.thread_comparison_key(a.analyze(d))

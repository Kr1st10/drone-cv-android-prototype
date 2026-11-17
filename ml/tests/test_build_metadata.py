"""Build/configuration provenance is recorded evidence, never the analyst's environment."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from timeline_analysis import read_timeline, analyze_timeline, metadata_provenance


def recording(path, metadata=()):
    rows = [('header', dict(start_ns='100', mode='yolo')),
            *[('metadata', data) for data in metadata]]
    rows.append(('session_end', dict(stop_ns='200', recording_complete=True,
                                    dropped_count='0', accepted_count=str(len(rows)),
                                    written_count=str(len(rows)))))
    path.write_text(''.join(json.dumps(dict(schema='dronecv-session-timeline-1', session_id='recorded',
                                           event_id=str(i), event_ns='100', type=kind, data=data))+'\n'
                            for i, (kind, data) in enumerate(rows, 1)))


def test_old_and_unknown_metadata_are_not_filled_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv('BUILD_GIT_SHA', 'a'*40)
    path = tmp_path/'old.ndjson'
    recording(path)
    old = read_timeline(path)['provenance']
    assert old['fields']['git_sha'] is None
    assert old['fields']['git_dirty'] is None
    assert old['fields']['version_code'] is None
    assert not old['conflicts']
    recording(path, [dict(git_sha=None, git_dirty=None, version_code=None)])
    unknown = read_timeline(path)['provenance']
    assert unknown['fields']['git_sha'] is None
    assert unknown['records'][1]['data']['git_dirty'] is None


def test_full_identity_and_session_configuration_survive_analysis(tmp_path):
    camera = dict(scope='latest_context_not_frame_bound', requested_physical_id='2',
                  latest_active_physical_id=None, requested_zoom=5, confirmed_zoom=None,
                  latest_capture_zoom=4.9, requested_af=1, actual_af=None)
    meta = dict(git_sha='f'*40, git_dirty=True, app_version='0.5.2', version_code=7,
                build_type='debug', mode='yolo', confidence=.5, nms_iou=.7,
                nms_max_detections=300, intra_op_threads=2, model_asset='test.onnx',
                model_sha256='a'*64, model_input_size=640, camera_context=camera)
    path = tmp_path/'new.ndjson'
    recording(path, [meta, dict(calibration_image=dict(width=640, height=480, data_url='large-image'))])
    timeline = read_timeline(path)
    assert timeline['recording_complete']
    provenance = timeline['provenance']
    assert all(provenance['fields'][key] == value for key, value in meta.items())
    assert provenance['records'][2]['data']['calibration_image'] == dict(width=640, height=480)
    assert analyze_timeline(path, max_coordinate_age_ns=0)['provenance'] == provenance
    assert 'camera_context' not in timeline['intervals'][0]
    other = tmp_path/'other.ndjson'
    recording(other, [dict(git_sha='b'*40, confidence=.8)])
    assert read_timeline(other)['provenance']['fields']['git_sha'] == 'b'*40
    assert read_timeline(other)['provenance']['fields']['camera_context'] is None
    assert provenance['fields']['confidence'] == .5


def test_conflicting_flat_and_historical_nested_metadata_are_explicit(tmp_path):
    path = tmp_path/'conflict.ndjson'
    recording(path, [dict(git_sha='a'*40, git_dirty=False, version_code=7),
                     dict(camera_context=dict(git_sha='b'*40, git_dirty=True), version_code=8)])
    provenance = read_timeline(path)['provenance']
    for key in ('git_sha', 'git_dirty', 'version_code'):
        assert provenance['fields'][key] is None
        assert len(provenance['conflicts'][key]) == 2
    assert provenance['camera_context_scope'] == 'latest_context_not_frame_bound'
    same = metadata_provenance([dict(type='metadata', data=dict(git_dirty=False)),
                                dict(type='header', data=dict(git_dirty=False))])
    assert same['fields']['git_dirty'] is False
    assert not same['conflicts']

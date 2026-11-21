export function motionFixture({ AB, Manual, policy, factor = 'aa', id = 'synthetic-aa' }) {
  const series = AB.create({ id, factor: 'mode', pair_count: 2,
    variants: { A: { value: 'yolo' }, B: { value: factor === 'ab' ? 'yolo_lk' : 'yolo' } } });
  series.manual_selection_rule = policy;
  series.manual_observations = [];
  const known = value => ({ status: 'known', value });
  const runs = [];
  function add(run_id, pair_index, slot, complete, drops, details = {}) {
    Object.assign(AB.begin(series, { run_id, pair_index, slot, ...details }), {
      complete, abort_reason: complete ? null : 'Синтетическая остановка',
    });
    const run = { schema: 'dronecv-motion-run-1', run_id, series_id: series.id, complete, samples: [],
      scenario: { version: 'simple-motion-v1', laps: 3, target_width_px: 75, max_speed_px_s: 150,
        acceleration_px_s2: 500, workspace: { x: 0, y: 0, width: 900, height: 700 }, calibration_size_px: 48, sync_module_px: 18 },
      photo: { sha256: 'test-photo', width: 800, height: 600, bbox: [100, 100, 200, 200] },
      conditions: { viewport: { width: 900, height: 700 } } };
    runs.push(run);
    if (drops == null) return;
    Manual.save(series.manual_observations, series, run, {
      operator: { device: 'test-phone', mode: series.variants[slot].value, build_id: 'test-build',
        model_sha256: 'test-model', zoom: '1×', orientation: 'landscape', camera_config: 'rear',
        setup_id: 'tripod', distance_cm: 70, route_visible: true, settings: { confidence: 0.5 } },
      capture: known('before_hide'), drops: known(drops), laps: [known('clean'), known('clean'), known(drops ? 'violation' : 'clean')],
      before_hide: known(true), coverage: { scenario_complete: true },
    });
  }
  const ids = factor === 'ab' ? ['b0000001', 'b0000002'] : ['a0000001', 'a0000002'];
  add(ids[0], 1, 'A', true, 0);
  add(ids[1], 1, 'B', true, 1);
  if (factor === 'aa') {
    add('a0000003', 1, 'A', true, null, { repeat_of: ids[0], repeat_reason: 'Проверка повтора' });
    AB.select(series, 1, 'A', 'a0000003');
    add('a0000004', 2, 'B', false, null);
    add('a0000005', 2, 'A', true, 0);
  }
  return { series, runs };
}

export function pilotFixture(images, manifest, sample) {
  const settings = { phone: 'test-phone', zoom: '1x', distance_cm: 70, mode: 'quick', scaleMode: 'fit',
    experiment_kind: 'gallery', observation_unit: 'window' };
  const runs = ['synthetic-A', 'synthetic-B'].map((run_id, index) => {
    const sample_ids = images.map(image => image.id);
    const showOrder = index ? sample_ids.slice().reverse() : sample_ids;
    return { run_id, sample_id: sample.sample_id, sample_name: sample.name, shows: 20, ...settings,
      trial: { run_id, sample_ids, manifest_version: manifest.version, manifest_sha256: manifest.sha256, settings: { ...settings },
        order: showOrder.map(id => ({ id, attempt: 1, level: null })) } };
  });
  const [first, second, third, fourth] = images.filter(image => image.drone);
  const negative = images.find(image => !image.drone);
  function row(run, image, detection, details = {}) {
    return { run_id: run.run_id, image_id: image.id, category: image.category, detection,
      step: run.trial.order.findIndex(step => step.id === image.id), ...details };
  }
  const [a, b] = runs;
  const records = [
    row(a, first, 'box_on_object', { fp_count: 1 }), row(b, first, 'no_box'),
    row(a, second, 'box_on_object', { false_alarm: false }), row(b, second, 'box_on_object', { extra_box_observed: false }),
    row(a, third, 'no_box'), row(b, fourth, 'box_on_object', { extra_box_observed: true }),
    row(a, negative, 'box_elsewhere'), row(b, negative, 'no_box'),
  ];
  return { runs, records, images, manifest };
}

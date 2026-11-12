(function (root) {
  'use strict';

  const target = 20;
  const intervalMs = 1000;
  const timingFields = ['conversion_ms', 'preprocess_ms', 'ort_ms', 'postprocess_ms', 'pipeline_ms'];
  const conditionFields = ['reference', 'view', 'equivalent_range_m', 'monitor_distance_cm', 'background', 'camera'];
  const nonnegative = value => Number.isFinite(value) && value >= 0;
  const id = value => Number.isSafeInteger(value) && value >= 0;
  const probability = value => nonnegative(value) && value <= 1;

  function analyze(report, startMs, conditions = {}, filename = null) {
    if (report?.schema_version !== 1 || !Array.isArray(report.frames)) {
      throw new TypeError('Нужен диагностический JSON Android schema_version=1 с массивом frames.');
    }
    if (!nonnegative(startMs)) throw new RangeError('Укажите начало серии в секундах от начала записи.');
    const samples = [];
    let unknown = 0;
    let duplicates = 0;
    const eligible = [];

    report.frames.forEach((row, index) => {
      const signal = row?.target_signal;
      const version = signal?.schema_version ?? report.target_signal_schema_version;
      if (version !== 2 || !id(signal?.frame_id) || signal.frame_id === 0 ||
          !id(signal.source_id) || !id(signal.analyzer_entry_ns) || signal.analyzer_entry_ns === 0 ||
          !nonnegative(row.offset_ms) || !timingFields.every(field => nonnegative(row[field])) ||
          (signal.status !== 'detected' && signal.status !== 'no_target')) {
        unknown++;
        return;
      }
      eligible.push({ row, signal, index });
    });

    eligible.sort((a, b) => a.row.offset_ms - b.row.offset_ms || a.index - b.index);
    const seen = new Set();
    let nextMs = startMs;
    let source = null;
    let sourceChanged = false;
    for (const { row, signal, index } of eligible) {
      const prefix = signal.source_id + ':';
      const keys = [prefix + 'frame:' + signal.frame_id, prefix + 'entry:' + signal.analyzer_entry_ns];
      const capture = signal.timestamp_source === 'elapsed_realtime' && id(signal.capture_ns) &&
        signal.capture_ns > 0 && signal.capture_ns <= signal.analyzer_entry_ns ? signal.capture_ns : null;
      if (capture !== null) keys.push(prefix + 'capture:' + capture);
      const duplicate = keys.some(key => seen.has(key));
      keys.forEach(key => seen.add(key));
      if (duplicate) {
        duplicates++;
        continue;
      }
      if (samples.length === target) continue;
      // Avoid mixing camera bindings inside a single series.
      if (source !== null && source !== signal.source_id) {
        sourceChanged = true;
        break;
      }
      if (row.offset_ms < nextMs) continue;
      source = signal.source_id;
      const candidate = signal.status === 'detected';
      samples.push({
        attempt: samples.length + 1, offset_ms: row.offset_ms, diagnostic_row: index + 1,
        source_id: source, frame_id: signal.frame_id, analyzer_entry_ns: signal.analyzer_entry_ns, capture_ns: capture,
        candidate, confidence: candidate && probability(signal.confidence) ? signal.confidence : null,
      });
      nextMs = row.offset_ms + intervalMs;
    }

    const loggedThreshold = probability(report.model?.confidence) ? report.model.confidence : null;
    const enteredThreshold = probability(conditions.confidence_threshold) ? conditions.confidence_threshold : null;
    const checked = samples.length;
    const withCandidate = samples.filter(sample => sample.candidate).length;
    return {
      schema: 'dronecv-yolo-pilot-1',
      source: {
        filename, device: report.device ?? null, app_version: report.app_version ?? null,
        started_epoch_ms: report.started_epoch_ms ?? null, duration_ms: report.duration_ms ?? null,
        model: report.model?.name ?? null, model_sha256: report.model?.sha256 ?? null,
        interrupted: report.interrupted === true, unstored_frames: report.unstored_frames ?? null,
      },
      conditions: {
        ...Object.fromEntries(conditionFields.map(field => [field, conditions[field] ?? null])),
        confidence_threshold: loggedThreshold ?? enteredThreshold,
        confidence_threshold_source: loggedThreshold !== null ? 'android' : enteredThreshold !== null ? 'operator' : null,
      },
      selection: { start_ms: startMs, minimum_interval_ms: intervalMs, target, time_basis: 'yolo_completion_offset_ms' },
      summary: {
        checked, with_candidate: withCandidate, without_candidate: checked - withCandidate,
        candidate_fraction: checked ? withCandidate / checked : null, complete: checked === target,
      },
      input_rows: { total: report.frames.length, insufficient_evidence: unknown, duplicates, stopped_on_source_change: sourceChanged },
      ground_truth: { tp: null, fn: null, fp: null, recall: null, successful_range_m: null,
        reason: 'missing_per_frame_yolo_boxes_images_and_verified_annotations' },
      independent_trials: false,
      samples,
    };
  }

  function toCsv(result) {
    const shared = {
      schema: result.schema, ...result.source, ...result.conditions, ...result.selection, ...result.summary,
      ...result.input_rows, ...result.ground_truth, independent_trials: result.independent_trials,
    };
    const fields = ['attempt', 'offset_ms', 'diagnostic_row', 'source_id', 'frame_id', 'analyzer_entry_ns',
      'capture_ns', 'candidate', 'confidence'];
    function cell(value) {
      if (value == null) return '';
      // Text can come from the Android file or the operator. Keep spreadsheet formulas inert.
      const safe = typeof value === 'string' && /^\s*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : String(value);
      return '"' + safe.replaceAll('"', '""') + '"';
    }
    const rows = result.samples.length ? result.samples : [{}];
    const header = [...Object.keys(shared), ...fields];
    return [header.map(cell).join(','), ...rows.map(row =>
      [...Object.values(shared), ...fields.map(field => row[field])].map(cell).join(','))].join('\r\n') + '\r\n';
  }

  const pilot = { analyze, toCsv };
  if (typeof module === 'object') module.exports = pilot;
  else root.YoloPilot = pilot;
})(globalThis);

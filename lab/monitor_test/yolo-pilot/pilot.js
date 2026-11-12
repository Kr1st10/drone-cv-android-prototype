(function (root) {
  'use strict';

  const timeline = typeof module === 'object' ? require('./timeline.js') : root.YoloPilotTimeline;
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
    let unknown = 0;
    const records = [];

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
      const capture = signal.timestamp_source === 'elapsed_realtime' && id(signal.capture_ns) &&
        signal.capture_ns > 0 && signal.capture_ns <= signal.analyzer_entry_ns ? signal.capture_ns : null;
      const candidate = signal.status === 'detected';
      records.push({
        time: row.offset_ms,
        binding: signal.source_id,
        sample: {
          offset_ms: row.offset_ms, diagnostic_row: index + 1,
          source_id: signal.source_id, frame_id: signal.frame_id, analyzer_entry_ns: signal.analyzer_entry_ns,
          capture_ns: capture, candidate, confidence: candidate && probability(signal.confidence) ? signal.confidence : null,
          evidence: 'diagnostic_frame_target_signal', completion_link: 'embedded',
        },
      });
    });

    const interrupted = report.interrupted === true;
    return summarize({
      records, unknown, total: report.frames.length, startMs, startOffset: startMs, step: intervalMs,
      loggedThreshold: probability(report.model?.confidence) ? report.model.confidence : null,
      source: {
        format: 'android-diagnostic-json-1', mode: records.length ? 'yolo' : null,
        device: report.device ?? null, app_version: report.app_version ?? null,
        started_epoch_ms: report.started_epoch_ms ?? null, duration_ms: report.duration_ms ?? null,
        model: report.model?.name ?? null, model_sha256: report.model?.sha256 ?? null,
        interrupted, unstored_frames: report.unstored_frames ?? null,
        recording_complete: interrupted || report.unstored_frames > 0 ? false : null,
        completion_link: 'embedded',
      },
    }, conditions, filename);
  }

  function analyzeText(text, startSeconds, conditions = {}, filename = null) {
    const input = text.replace(/^\uFEFF/, '');
    let first;
    try { first = JSON.parse(input.split('\n', 1)[0]); } catch { /* A legacy JSON can be pretty-printed. */ }
    if (first?.schema === timeline.schema) {
      return summarize(timeline.decode(input, startSeconds), conditions, filename);
    }
    return analyze(JSON.parse(input), Number(startSeconds) * 1000, conditions, filename);
  }

  function summarize(decoded, conditions, filename) {
    const { records, source, startMs, startOffset, step, loggedThreshold, total, unknown, diagnostics } = decoded;
    const fromTimeline = source.format === timeline.schema;
    const samples = [];
    let duplicates = 0;
    const seen = new Set();
    let next = startOffset;
    let binding = null;
    let sourceChanged = false;
    records.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.sample.diagnostic_row - b.sample.diagnostic_row));
    for (const record of records) {
      const { sample, time } = record;
      const prefix = sample.source_id + ':';
      const keys = [prefix + 'frame:' + sample.frame_id, prefix + 'entry:' + sample.analyzer_entry_ns];
      if (sample.capture_ns !== null) keys.push(prefix + 'capture:' + sample.capture_ns);
      const duplicate = keys.some(key => seen.has(key));
      keys.forEach(key => seen.add(key));
      if (duplicate) {
        duplicates++;
        continue;
      }
      if (samples.length === target) continue;
      if (binding !== null && binding !== record.binding) {
        sourceChanged = true;
        break;
      }
      if (time < next) continue;
      binding = record.binding;
      samples.push({ attempt: samples.length + 1, ...sample });
      next = time + step;
    }

    const enteredThreshold = probability(conditions.confidence_threshold) ? conditions.confidence_threshold : null;
    const checked = samples.length;
    const withCandidate = samples.filter(sample => sample.candidate).length;
    return {
      schema: 'dronecv-yolo-pilot-1',
      source: { filename, ...source },
      conditions: {
        ...Object.fromEntries(conditionFields.map(field => [field, conditions[field] ?? null])),
        confidence_threshold: loggedThreshold ?? enteredThreshold,
        confidence_threshold_source: loggedThreshold !== null ? 'android' : enteredThreshold !== null ? 'operator' : null,
      },
      selection: {
        start_ms: startMs, start_ns: fromTimeline ? String(startOffset) : null, minimum_interval_ms: intervalMs, target,
        time_basis: fromTimeline ? 'yolo_state_publication_elapsed_realtime' : 'yolo_completion_offset_ms',
      },
      summary: {
        checked, with_candidate: withCandidate, without_candidate: checked - withCandidate,
        candidate_fraction: checked ? withCandidate / checked : null,
        // Timeline publications prove their own outcome but cannot establish coverage of diagnostic_frame.
        complete: checked === target && source.completion_link === 'embedded' &&
          source.recording_complete !== false && unknown === 0,
      },
      input_rows: {
        total, insufficient_evidence: unknown, duplicates, stopped_on_source_change: sourceChanged,
        diagnostic_frames_unlinked: diagnostics ?? null,
      },
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
      'capture_ns', 'candidate', 'confidence', 'offset_ns', 'publication_ns', 'generation', 'state_event_id', 'evidence',
      'sample_completion_link'];
    function cell(value) {
      if (value == null) return '';
      // Text can come from the Android file or the operator. Keep spreadsheet formulas inert.
      const content = Array.isArray(value) ? JSON.stringify(value) : String(value);
      const safe = typeof value === 'string' && /^\s*[=+@-]|^[\t\r\n]/.test(value) ? "'" + content : content;
      return '"' + safe.replaceAll('"', '""') + '"';
    }
    const rows = result.samples.length ? result.samples.map(row => ({ ...row, sample_completion_link: row.completion_link })) : [{}];
    const header = [...Object.keys(shared), ...fields];
    return [header.map(cell).join(','), ...rows.map(row =>
      [...Object.values(shared), ...fields.map(field => row[field])].map(cell).join(','))].join('\r\n') + '\r\n';
  }

  const pilot = { analyze, analyzeText, toCsv };
  if (typeof module === 'object') module.exports = pilot;
  else root.YoloPilot = pilot;
})(globalThis);

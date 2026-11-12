(function (root) {
  'use strict';

  const schema = 'dronecv-session-timeline-1';
  const clock = 'elapsed_realtime_ns';
  const nsPerSecond = 1_000_000_000n;
  const uint = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
  const probability = value => typeof value === 'number' && value >= 0 && value <= 1;

  function startNs(seconds) {
    const parts = /^(\d*)(?:\.(\d{0,9}))?$/.exec(seconds);
    if (!parts || !(parts[1] || parts[2])) {
      throw new RangeError('Укажите начало серии в секундах с точностью до 9 знаков после точки.');
    }
    return BigInt(parts[1] || '0') * nsPerSecond + BigInt((parts[2] ?? '').padEnd(9, '0'));
  }

  function read(text) {
    const issues = new Set();
    const events = [];
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    let lastId = 0n;
    let session = null;
    for (const [index, line] of lines.entries()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        issues.add('invalid_line');
        continue;
      }
      const id = uint(event?.event_id), time = uint(event?.event_ns);
      if (event?.schema !== schema || typeof event.session_id !== 'string' || !event.session_id ||
          id === null || id === 0n || time === null || typeof event.type !== 'string' ||
          !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
        issues.add('invalid_event');
        continue;
      }
      session ??= event.session_id;
      if (event.session_id !== session) {
        issues.add('mixed_sessions');
        continue;
      }
      if (id !== lastId + 1n) issues.add('event_id_gap_or_repeat');
      lastId = id;
      events.push({ ...event, id, time, line: index + 1 });
    }
    const header = events[0];
    const start = uint(header?.data.start_ns);
    if (header?.type !== 'header' || header.line !== 1 || start === null || header.data.clock !== clock ||
        header.time !== start) {
      throw new TypeError('Нужен корректный header NDJSON с часами elapsed_realtime_ns.');
    }
    const footers = events.filter(event => event.type === 'session_end');
    const footer = footers[0];
    const stop = uint(footer?.data.stop_ns);
    const end = footer?.data;
    if (events.filter(event => event.type === 'header').length !== 1) issues.add('repeated_header');
    if (footers.length !== 1 || footer !== events.at(-1) || stop === null || stop < start || footer.time !== stop) {
      issues.add('missing_or_invalid_end');
    }
    if (events.some(event => event.type === 'recording_failure')) issues.add('recording_failure');
    if (end) {
      if (end.recording_complete !== true || uint(end.dropped_count) !== 0n || uint(end.missing_ranges) !== 0n ||
          ['missing_first_event_id', 'missing_last_event_id', 'missing_first_ns', 'missing_last_ns']
            .some(field => end[field] != null)) issues.add('reported_loss');
      const beforeEnd = BigInt(events.indexOf(footer));
      if (uint(end.accepted_count) !== beforeEnd || uint(end.written_count) !== beforeEnd ||
          footer.id !== beforeEnd + 1n) issues.add('inconsistent_counts');
    }
    return {
      events: footer ? events.slice(0, events.indexOf(footer)) : events,
      total: events.length, session, header: header.data, footer: end, start, stop, issues,
    };
  }

  function validBox(box) {
    return Array.isArray(box) && box.length === 4 && box.every(probability) &&
      box[0] <= box[2] && box[1] <= box[3];
  }

  function readState(event, start, stop) {
    const d = event.data;
    const time = uint(d.publication_ns), entry = uint(d.analyzer_entry_ns);
    if (d.publication_clock !== clock || time === null || time < start || time > event.time ||
        (stop !== null && time > stop) || entry === null || entry === 0n || entry > time ||
        uint(d.source_id) === null || uint(d.generation) === null ||
        uint(d.frame_id) === null || d.frame_id === '0' || d.detector_frame_id !== d.frame_id) return null;
    const candidate = d.reason === 'update';
    if (candidate) {
      if (!validBox(d.box) || d.last_yolo_frame_id !== d.detector_frame_id ||
          d.last_yolo_accepted_ns !== d.publication_ns ||
          d.last_yolo_analyzer_entry_ns !== d.analyzer_entry_ns) return null;
    } else if (d.box !== null) return null;

    const capture = d.timestamp_source === 'elapsed_realtime' ? uint(d.capture_ns) : null;
    return {
      time: time - start,
      binding: d.source_id + ':' + d.generation,
      sample: {
        offset_ms: Number(time - start) / 1e6,
        offset_ns: String(time - start),
        publication_ns: d.publication_ns,
        source_id: d.source_id, generation: d.generation, frame_id: d.frame_id,
        analyzer_entry_ns: d.analyzer_entry_ns, capture_ns: capture !== null && capture > 0n && capture <= entry ? d.capture_ns : null,
        candidate, confidence: null, state_event_id: event.event_id, diagnostic_row: event.line,
        evidence: 'state_detector_frame', completion_link: 'unknown',
      },
    };
  }

  function decode(text, seconds) {
    const startOffset = startNs(seconds);
    const { events, total, session, header, footer, start, stop, issues } = read(text);
    const diagnostics = events.filter(event => event.type === 'diagnostic_frame').length;
    const metadata = events.filter(event => event.type === 'metadata');
    const modes = new Set([header, ...metadata.map(event => event.data)].map(data => data.mode).filter(mode => mode != null));
    const mode = modes.size === 1 ? [...modes][0] : null;
    const thresholds = new Set([header, ...metadata.map(event => event.data)].map(data => data.confidence).filter(probability));
    const eligible = [];
    const byFrame = new Map();
    const conflicting = new Set();
    let unknown = 0;
    for (const event of events) {
      const d = event.data;
      if (event.type !== 'state' || d.result_source !== 'yolo' ||
          !['update', 'no_detection'].includes(d.reason)) continue;
      const record = mode === 'yolo' ? readState(event, start, stop) : null;
      if (!record) {
        unknown++;
        continue;
      }
      // A publication may come from work already in flight when recording started.
      if (uint(d.analyzer_entry_ns) < start) continue;
      const key = d.source_id + ':' + d.frame_id;
      const first = byFrame.get(key);
      if (first && (first.candidate !== record.sample.candidate ||
          first.analyzer_entry_ns !== record.sample.analyzer_entry_ns ||
          first.capture_ns !== record.sample.capture_ns || first.generation !== record.sample.generation)) {
        conflicting.add(key);
      }
      byFrame.set(key, record.sample);
      eligible.push({ key, ...record });
    }
    const records = eligible.filter(record => !conflicting.has(record.key));
    unknown += eligible.length - records.length;
    return {
      records, startOffset, startMs: Number(startOffset) / 1e6, step: nsPerSecond,
      loggedThreshold: thresholds.size === 1 ? [...thresholds][0] : null,
      source: {
        format: schema, session_id: session, mode, device: header.device ?? null,
        measurement_clock: header.measurement_clock ?? null,
        recording_start_ns: String(start), recording_stop_ns: stop === null ? null : String(stop),
        app_version: header.app_version ?? null, started_epoch_ms: header.started_epoch_ms ?? null,
        duration_ms: stop !== null && stop >= start ? Number(stop - start) / 1e6 : null,
        model: header.model_asset ?? null, model_sha256: header.model_sha256 ?? null,
        interrupted: footer?.interrupted === true, unstored_frames: null,
        recording_complete: issues.size === 0, integrity_issues: [...issues],
        mode_confirmed: mode === 'yolo', threshold_conflict: thresholds.size > 1,
        completion_link: 'unknown',
      },
      total, unknown,
      diagnostics,
    };
  }

  const timeline = { schema, decode };
  if (typeof module === 'object') module.exports = timeline;
  else root.YoloPilotTimeline = timeline;
})(globalThis);

'use strict';

const form = document.querySelector('#pilot');
const statusLine = document.querySelector('#status');
const resultSection = document.querySelector('#result');
const table = document.querySelector('#attempts');
const body = table.tBodies[0];
const percent = new Intl.NumberFormat('ru', { style: 'percent', maximumFractionDigits: 2 });
const seconds = new Intl.NumberFormat('ru', { maximumFractionDigits: 3 });
const integrityLabels = {
  invalid_line: 'повреждённая строка',
  invalid_event: 'некорректное событие',
  mixed_sessions: 'смешаны разные сессии',
  event_id_gap_or_repeat: 'разрыв или повтор event_id',
  repeated_header: 'повтор заголовка',
  missing_or_invalid_end: 'нет корректного завершения записи',
  recording_failure: 'ошибка записи',
  reported_loss: 'журнал сообщает о потерях',
  inconsistent_counts: 'расхождение счётчиков',
};
let result = null;
let revision = 0;

// Each opened pilot retains the conditions serialized when its fullscreen presentation settled.
const stimulusParam = () => new URLSearchParams(location.hash.slice(1)).get('stimulus');
const initialStimulus = stimulusParam();
const sameStimulus = () => stimulusParam() === initialStimulus;
function readCapturedStimulus(json) {
  if (!json) return null;
  try {
    const stimulus = JSON.parse(json);
    const validBackground =
      (stimulus?.background === 'neutral_gray_808080_v1' && stimulus.background_hex === '#808080') ||
      (stimulus?.background === 'neutral' && stimulus.background_hex === '#FFFFFF') ||
      (stimulus?.background === 'sky' && stimulus.background_hex === null &&
        stimulus.background_asset === 'reference_assets/sky.svg');
    if (!['original', 'clean'].includes(stimulus?.stimulus_variant) ||
        !/^IMG_\d{4}$/.test(stimulus.source_photo_id) ||
        ![stimulus.source_sha256, stimulus.asset_sha256].every(value => /^[a-f0-9]{64}$/.test(value)) ||
        !validBackground) throw new TypeError();
    for (const field of ['reference', 'view', 'equivalent_range_m', 'monitor_distance_cm', 'background', 'camera']) {
      if (typeof stimulus[field] !== (field.endsWith('_m') || field.endsWith('_cm') ? 'number' : 'string')) throw new TypeError();
    }
    return stimulus;
  } catch {
    document.querySelector('#capturedStimulus').hidden = false;
    document.querySelector('#capturedStimulus').textContent = 'Условия показа в ссылке повреждены. Откройте пилот из стенда повторно.';
    form.querySelector('button[type="submit"]').disabled = true;
    return null;
  }
}
const capturedStimulus = readCapturedStimulus(initialStimulus);
if (capturedStimulus) {
  for (const field of ['reference', 'view', 'equivalent_range_m', 'monitor_distance_cm', 'background', 'camera']) {
    const input = form.elements[field];
    input.value = capturedStimulus[field];
    input.readOnly = true;
  }
  const note = document.querySelector('#capturedStimulus');
  note.hidden = false;
  note.textContent = `Условия показа сохранены · ${capturedStimulus.source_photo_id} · ${capturedStimulus.stimulus_variant === 'clean' ? 'Чистый фон' : 'Оригинал'}`;
}

function clearResult() {
  revision++;
  result = null;
  resultSection.hidden = true;
  statusLine.textContent = '';
}

form.addEventListener('input', clearResult);
window.addEventListener('hashchange', () => {
  if (sameStimulus()) return;
  clearResult();
  location.reload();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearResult();
  const submitted = revision;
  const { report: file, start, threshold_pct: threshold, ...fields } = Object.fromEntries(new FormData(form));
  const conditions = { ...fields, ...capturedStimulus };
  try {
    for (const field of ['equivalent_range_m', 'monitor_distance_cm']) {
      conditions[field] = Number(conditions[field]);
      if (!(conditions[field] > 0) || !Number.isFinite(conditions[field])) {
        throw new RangeError('Дальность и расстояние до экрана должны быть положительными числами.');
      }
    }
    for (const field of ['reference', 'view', 'background', 'camera']) {
      conditions[field] = conditions[field].trim();
      if (!conditions[field]) throw new TypeError('Заполните все условия серии.');
    }
    if (threshold !== '') conditions.confidence_threshold = Number(threshold) / 100;
    statusLine.textContent = 'Читаю журнал…';
    const text = await file.text();
    if (submitted !== revision || !sameStimulus()) return;
    result = YoloPilot.analyzeText(text, start, conditions, file.name);
    render(result);
  } catch (error) {
    if (submitted === revision) statusLine.textContent = 'Импорт не выполнен. ' + error.message;
  }
});

function render(run) {
  const { summary, source, selection, input_rows: rows } = run;
  const fromTimeline = rows.diagnostic_frames_unlinked !== null;
  const status = summary.complete ? 'Полная серия' : fromTimeline && summary.checked === selection.target
    ? 'Полнота серии не подтверждена' : 'Неполная серия';
  statusLine.textContent = `${status} · ${summary.checked} из ${selection.target}`;
  const share = summary.candidate_fraction === null ? '—' : percent.format(summary.candidate_fraction);
  document.querySelector('#summary').textContent =
    `Проверено ${summary.checked}. С кандидатом ${summary.with_candidate}, без кандидата ${summary.without_candidate}. Доля с кандидатом ${share}.`;
  const threshold = run.conditions.confidence_threshold;
  const thresholdSource = run.conditions.confidence_threshold_source === 'android' ? 'журнал' : 'ввод оператора';
  const details = [
    threshold === null ? 'Порог confidence неизвестен.' : `Порог confidence ${percent.format(threshold)} (${thresholdSource}).`,
    `Результатов с недостаточными или противоречивыми данными: ${rows.insufficient_evidence}.`,
    `Повторных строк: ${rows.duplicates}.`,
  ];
  if (fromTimeline) {
    details.push(`NDJSON · режим ${source.mode ?? 'неизвестен'}. Время отсчитывается до публикации результата YOLO.`);
    details.push(`Строк diagnostic_frame без доказанной связи с результатом: ${rows.diagnostic_frames_unlinked}.`);
    details.push('Доля относится к отобранным публикациям state. Полноту серии по журналу завершений подтвердить нельзя.');
    if (source.integrity_issues.length) {
      details.push('Проблемы целостности — ' + source.integrity_issues.map(issue => integrityLabels[issue]).join(', ') + '.');
    }
    if (source.threshold_conflict) details.push('Журнал содержит разные пороги confidence.');
    if (!source.mode_confirmed) details.push('Чистый режим YOLO не подтверждён.');
  } else {
    details.push('Время отсчитывается до завершения инференса YOLO.');
  }
  if (rows.stopped_on_source_change) details.push('Отбор завершён при смене источника камеры.');
  if (source.interrupted) details.push('Android отметил запись как прерванную.');
  if (source.unstored_frames > 0) details.push(`В журнал не вошло инференсов: ${source.unstored_frames}.`);
  document.querySelector('#details').textContent = details.join(' ');
  body.replaceChildren();
  table.hidden = run.samples.length === 0;
  for (const sample of run.samples) {
    const row = body.insertRow();
    const values = [
      sample.attempt, seconds.format(sample.offset_ms / 1000), `${sample.source_id} / ${sample.frame_id}`,
      sample.candidate ? 'Есть' : 'Нет', sample.confidence === null ? '—' : percent.format(sample.confidence),
    ];
    for (const value of values) row.insertCell().textContent = value;
  }
  resultSection.hidden = false;
}

function download(name, mime, data) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelector('#csv').addEventListener('click', () => {
  if (result && sameStimulus()) download('yolo-pilot.csv', 'text/csv;charset=utf-8', '\uFEFF' + YoloPilot.toCsv(result));
});
document.querySelector('#json').addEventListener('click', () => {
  if (result && sameStimulus()) download('yolo-pilot.json', 'application/json', JSON.stringify(result, null, 2) + '\n');
});

'use strict';

const fileInput = document.querySelector('#reports');
const errors = document.querySelector('#errors');
const form = document.querySelector('#conditions');
const editor = form.querySelector('fieldset');
const formStatus = document.querySelector('#conditions-status');
const runSelect = document.querySelector('#run-select');
const runsBody = document.querySelector('#runs tbody');
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
let runs = [];
let revision = 0;

function sourceLabel(source) {
  return source.archive ? `${source.archive} / ${source.path}` : source.filename;
}

async function analyze(source, start = 0, conditions = {}) {
  const run = YoloPilot.analyzeText(await source.text(), start, conditions, source.filename);
  run.source = {
    run_name: source.title, archive_id: source.id ?? null, archive_file: source.archive ?? null,
    archive_path: source.path ?? null, ...run.source,
  };
  return run;
}

fileInput.addEventListener('change', async () => {
  const submitted = ++revision;
  const files = Array.from(fileInput.files);
  runs = [];
  errors.replaceChildren();
  errors.hidden = true;
  resultSection.hidden = true;
  editor.disabled = runSelect.disabled = false;
  statusLine.textContent = files.length ? 'Читаю журналы…' : '';
  if (!files.length) return;

  const imported = [];
  const onError = (filename, error) => {
    if (submitted !== revision) return;
    const message = document.createElement('li');
    message.textContent = `${filename} — ${error.message}`;
    errors.append(message);
    errors.hidden = false;
  };
  for (const file of files) {
    try {
      const sources = await YoloPilotArchive.journals(file, onError);
      for (const source of sources) {
        if (submitted !== revision) return;
        try {
          imported.push({ source, result: await analyze(source), draft: { start: '0' } });
        } catch (error) {
          onError(sourceLabel(source), error);
        }
      }
    } catch (error) {
      onError(file.name, error);
    }
  }
  if (submitted !== revision) return;
  runs = imported;
  statusLine.textContent = runs.length ? `Загружено прогонов: ${runs.length}.` : 'Не удалось загрузить ни одного прогона.';
  if (!runs.length) return;
  runSelect.replaceChildren(...runs.map(({ source }, index) => new Option(`${index + 1}. ${source.title}`, index)));
  renderRuns();
  showSelected();
  resultSection.hidden = false;
});

function renderRuns() {
  runsBody.replaceChildren();
  runs.forEach(({ source, result }, index) => {
    const row = runsBody.insertRow();
    const { summary, selection } = result;
    const name = row.insertCell();
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${index + 1}. ${source.title}`;
    button.addEventListener('click', () => {
      if (runSelect.disabled) return;
      runSelect.value = String(index);
      showSelected();
    });
    name.append(button);
    if (result.source.integrity_issues?.length) {
      const warning = document.createElement('small');
      warning.textContent = 'Проблемы целостности';
      name.append(warning);
    }
    row.insertCell().textContent = `${summary.checked} / ${selection.target}`;
    row.insertCell().textContent = summary.with_candidate;
    row.insertCell().textContent = summary.candidate_fraction === null ? '—' : percent.format(summary.candidate_fraction);
  });
}

function showSelected() {
  const run = runs[runSelect.value];
  for (const input of form.querySelectorAll('input')) input.value = run.draft[input.name] ?? '';
  formStatus.textContent = run.dirty ? 'Примените условия, чтобы включить их в CSV.' : '';
  document.querySelector('#run-title').textContent = run.source.title;
  document.querySelector('#run-source').textContent = sourceLabel(run.source);
  render(run.result);
}

runSelect.addEventListener('change', showSelected);
form.addEventListener('input', () => {
  const run = runs[runSelect.value];
  run.draft = Object.fromEntries(new FormData(form));
  run.dirty = true;
  formStatus.textContent = 'Примените условия, чтобы включить их в CSV.';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const run = runs[runSelect.value];
  const submitted = revision;
  const { start, threshold_pct: threshold, ...fields } = Object.fromEntries(new FormData(form));
  const conditions = Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, value.trim() || null]));
  for (const field of ['equivalent_range_m', 'monitor_distance_cm']) {
    if (conditions[field] === null) continue;
    conditions[field] = Number(conditions[field]);
    if (!(conditions[field] > 0) || !Number.isFinite(conditions[field])) {
      formStatus.textContent = 'Укажите положительную дальность и расстояние до экрана либо оставьте поле пустым.';
      return;
    }
  }
  if (threshold !== '') conditions.confidence_threshold = Number(threshold) / 100;
  editor.disabled = runSelect.disabled = true;
  formStatus.textContent = 'Обновляю прогон…';
  try {
    const result = await analyze(run.source, start || 0, conditions);
    if (submitted !== revision) return;
    run.result = result;
    run.dirty = false;
    renderRuns();
    showSelected();
    formStatus.textContent = 'Условия применены.';
  } catch (error) {
    if (submitted === revision) formStatus.textContent = error.message;
  } finally {
    if (submitted === revision) editor.disabled = runSelect.disabled = false;
  }
});

function render(run) {
  const { summary, source, selection, input_rows: rows } = run;
  const fromTimeline = rows.diagnostic_frames_unlinked !== null;
  const status = summary.complete ? 'Полная серия' : fromTimeline && summary.checked === selection.target
    ? 'Полнота серии не подтверждена' : 'Неполная серия';
  document.querySelector('#series-status').textContent = `${status} · ${summary.checked} из ${selection.target}`;
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
  if (runs.length) download('yolo-pilot-runs.csv', 'text/csv;charset=utf-8', '\uFEFF' + YoloPilot.toSummaryCsv(runs.map(run => run.result)));
});
document.querySelector('#attempt-csv').addEventListener('click', () => {
  const run = runs[runSelect.value]?.result;
  if (run) download('yolo-pilot.csv', 'text/csv;charset=utf-8', '\uFEFF' + YoloPilot.toCsv(run));
});
document.querySelector('#json').addEventListener('click', () => {
  const run = runs[runSelect.value]?.result;
  if (run) download('yolo-pilot.json', 'application/json', JSON.stringify(run, null, 2) + '\n');
});

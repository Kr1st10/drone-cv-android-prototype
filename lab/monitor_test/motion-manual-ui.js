(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const choices = {
    capture: [['before_hide', 'До скрытия'], ['after_return', 'После появления'], ['no_capture', 'Захвата не было']],
    lap: [['clean', 'Чистый'], ['violation', 'С нарушением']],
    frame: [['true', 'Да'], ['false', 'Нет']],
  };
  let active = null, warnedSeries = null, openDraft;
  let setup, setupTargets = [], confirmationKey = null;
  const drafts = new Map();

  function node(parent, tag, text) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    parent.append(element);
    return element;
  }

  function control(parent, label, tag, name, type) {
    const wrapper = node(parent, 'p');
    const caption = node(wrapper, 'label', label + ' ');
    const field = node(caption, tag);
    field.name = name;
    if (type) field.type = type;
    return field;
  }

  function select(parent, label, name, options, value) {
    const input = control(parent, label, 'select', name);
    for (const [key, label] of options) node(input, 'option', label).value = key;
    input.value = value ?? '';
    return input;
  }

  function setupFields(parent, initial = {}, deviations = '') {
    const fields = {};
    for (const [key, label] of Object.entries({
      device: 'Телефон', build_id: 'ID сборки / SHA APK', model_sha256: 'SHA-256 модели',
      setup_id: 'Установка', zoom: 'Зум', orientation: 'Ориентация', camera_config: 'Камера и кадрирование',
      distance_cm: 'Расстояние, см', settings: 'Фактические настройки приложения (JSON)',
    })) {
      fields[key] = control(parent, label, key === 'settings' ? 'textarea' : 'input', key, key === 'distance_cm' ? 'number' : null);
      fields[key].value = key === 'settings' && initial.settings ? JSON.stringify(initial.settings) : initial[key] ?? '';
    }
    fields.distance_cm.step = 'any';
    fields.mode = select(parent, 'Фактический режим', 'mode',
      [['', 'Не подтверждён'], ['yolo', 'YOLO'], ['yolo_lk', 'YOLO + LK']], initial.mode);
    fields.route_visible = control(parent, 'Дрон целиком в превью на всём маршруте', 'input', 'route_visible', 'checkbox');
    fields.route_visible.checked = initial.route_visible === true;
    fields.deviations = control(parent, 'Отклонения от условий', 'textarea', 'deviations');
    fields.deviations.value = deviations;
    return fields;
  }

  function readSetup(fields) {
    const operator = {};
    for (const [key, field] of Object.entries(fields)) {
      if (['route_visible', 'deviations', 'settings', 'distance_cm'].includes(key)) continue;
      if (field.value.trim()) operator[key] = field.value.trim();
    }
    if (fields.distance_cm.value) {
      const distance = fields.distance_cm.valueAsNumber;
      if (!Number.isFinite(distance) || distance <= 0) throw Error('Укажите положительное расстояние в сантиметрах.');
      operator.distance_cm = distance;
    }
    if (fields.settings.value.trim()) {
      try { operator.settings = JSON.parse(fields.settings.value); }
      catch { throw Error('Настройки приложения должны быть JSON-объектом.'); }
      if (!operator.settings || typeof operator.settings !== 'object' || Array.isArray(operator.settings)) {
        throw Error('Настройки приложения должны быть JSON-объектом.');
      }
    }
    if (fields.route_visible.checked) operator.route_visible = true;
    return { operator, deviations: fields.deviations.value.trim(), provenance: 'operator' };
  }

  const targetKey = value => MotionAB.canonical(value);
  function invalidateSetup(message) {
    if (!confirmationKey && !confirmed.checked) return;
    confirmationKey = null;
    confirmed.checked = false;
    setupNotice.textContent = message;
  }

  function targets(next, retry) {
    setupTargets = [next, retry];
    const target = setupTargets[Number(targetChoice.value)];
    if (confirmationKey && confirmationKey !== targetKey(target)) {
      invalidateSetup('Цель запуска изменилась. Подтвердите условия заново.');
    }
    targetLabel.textContent = target
      ? 'Серия ' + target.series_id + ', пара ' + target.pair_index + ', вариант ' + target.slot + ', попытка ' + target.attempt
      : 'Нет доступной попытки для подтверждения.';
    confirmed.disabled = !target;
  }

  function confirmation(target) {
    if (!confirmed.checked) return null;
    if (confirmationKey !== targetKey(target)) {
      invalidateSetup('Выбран другой запуск. Подтвердите условия для него.');
      throw Error('Подтвердите условия для выбранного запуска.');
    }
    const actual = readSetup(setup);
    if (!Object.keys(actual.operator).length && !actual.deviations) throw Error('Укажите фактические условия или отклонение.');
    return actual;
  }

  function answerField(parent, label, key, values, answer, decode = value => value) {
    const box = node(parent, 'div');
    const options = [['', 'Без ответа'], ...values, ['uncertain', 'Не удалось оценить']];
    if (key !== 'capture') options.push(['not_applicable', 'Неприменимо']);
    const input = select(box, label, key, options, answer.status === 'known' ? String(answer.value) : answer.status === 'unanswered' ? '' : answer.status);
    const reason = control(box, 'Причина', 'input', key + '_reason');
    reason.value = answer.reason ?? '';
    const reasonRequired = () => ['uncertain', 'not_applicable'].includes(input.value);
    function update() { reason.closest('p').hidden = !reasonRequired(); reason.required = reasonRequired(); }
    input.addEventListener('change', update);
    update();
    return () => reasonRequired() ? { status: input.value, reason: reason.value } :
      input.value ? { status: 'known', value: decode(input.value) } : { status: 'unanswered' };
  }

  function dropsField(parent, answer) {
    const input = select(parent, 'Число незапланированных срывов', 'drops_status',
      [['unanswered', 'Без ответа'], ['known', 'Известно'], ['uncertain', 'Не удалось оценить'], ['not_applicable', 'Неприменимо']], answer.status);
    const count = control(parent, 'Количество', 'input', 'drops', 'number');
    count.min = 0;
    count.step = 1;
    count.value = answer.value ?? '';
    const reason = control(parent, 'Причина', 'input', 'drops_reason');
    reason.value = answer.reason ?? '';
    function update() {
      count.required = input.value === 'known';
      reason.required = ['uncertain', 'not_applicable'].includes(input.value);
      count.closest('p').hidden = !count.required;
      reason.closest('p').hidden = !reason.required;
    }
    input.addEventListener('change', update);
    update();
    return () => count.required ? { status: 'known', value: count.valueAsNumber } :
      reason.required ? { status: input.value, reason: reason.value } : { status: 'unanswered' };
  }

  function editor(series, run, attempt, save) {
    const baseline = {
      answer: structuredClone(series.manual_observations?.find(item => item.run_id === run.run_id)),
      attempt: structuredClone(attempt),
    };
    const entry = MotionManual.read(series.manual_observations ?? [], series, run);
    const form = document.createElement('form');
    form.id = 'manualForm';
    node(form, 'p', 'Пара ' + attempt.pair_index + ', вариант ' + attempt.slot + ', запуск ' + run.run_id);
    const fields = node(form, 'fieldset');
    const actual = node(fields, 'details');
    node(actual, 'summary', 'Фактические условия попытки');
    const operator = setupFields(actual, { ...run.conditions, ...entry.operator },
      entry.operator.deviations);
    const capture = answerField(fields, 'Первый правильный захват', 'capture', choices.capture, entry.capture);
    const laps = entry.laps.map((answer, index) => answerField(fields, 'Круг ' + (index + 1), 'lap_' + (index + 1), choices.lap, answer));
    const drops = dropsField(fields, entry.drops);
    const before = answerField(fields, 'Правильная рамка перед скрытием', 'before_hide', choices.frame, entry.before_hide, value => value === 'true');
    const after = answerField(fields, 'Правильная рамка после появления', 'after_return', choices.frame, entry.after_return, value => value === 'true');
    const full = control(fields, 'Сценарий просмотрен полностью', 'input', 'scenario_complete', 'checkbox');
    full.checked = entry.coverage?.scenario_complete === true;
    const window = select(fields, 'Окно после появления', 'return_coverage',
      [['', 'Охват не указан'], ['complete', 'Просмотрено полностью'], ['partial', 'Просмотрено частично'], ['not_started', 'Не началось']],
      entry.coverage?.after_return);
    const notes = control(fields, 'Примечание', 'textarea', 'notes');
    notes.value = entry.notes;
    node(form, 'button', 'Сохранить оценку').type = 'submit';
    const key = JSON.stringify([series.id, run.run_id]);
    const draft = { form, baseline, seriesId: series.id, runId: run.run_id, attempt, dirty: false, exportable: false, pending: false };
    function edited() {
      draft.dirty = true;
      draft.exportable = false;
      status(key, 'Есть несохранённые изменения.');
      renderExportWarning();
    }
    form.addEventListener('input', edited);
    form.addEventListener('change', edited);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      try {
        const actual = readSetup(operator);
        if (actual.deviations) actual.operator.deviations = actual.deviations;
        const coverage = { scenario_complete: full.checked };
        if (window.value) coverage.after_return = window.value;
        const patch = {
          operator: actual.operator, coverage, capture: capture(), laps: laps.map(read => read()),
          before_hide: before(), after_return: after(), notes: notes.value,
        };
        const answers = { ...patch, drops: drops() };
        for (const key of ['capture', 'laps', 'drops', 'before_hide', 'after_return']) {
          if (MotionAB.canonical(answers[key]) !== MotionAB.canonical(entry[key])) patch[key] = answers[key];
          else delete patch[key];
        }
        draft.pending = true;
        button.disabled = fields.disabled = true;
        status(key, 'Сохранение…');
        await save(series.id, run.run_id, patch, baseline);
        status(key, 'Сохранено');
        if (drafts.get(key)?.form === form) drafts.delete(key);
        if (active === key) show(series, run, attempt, save);
      } catch (error) {
        draft.exportable = error.manualDraft === true;
        draft.dirty = true;
        status(key, error.message);
      } finally { draft.pending = false; button.disabled = fields.disabled = false; renderExportWarning(); }
    });
    return draft;
  }

  const notices = new Map();
  function status(key, value) {
    notices.set(key, value);
    if (active === key) $('manualStatus').textContent = value;
  }

  function show(series, run, attempt, save) {
    active = run ? JSON.stringify([series.id, run.run_id]) : null;
    $('manualPanel').hidden = !series;
    if (warnedSeries !== series?.id) warnedSeries = null;
    renderExportWarning();
    $('manualStatus').textContent = active ? notices.get(active) ?? '' : '';
    const root = $('manualEditor');
    if (!run) {
      root.textContent = 'Выберите попытку пары и откройте её ручную оценку.';
      return;
    }
    const previous = drafts.get(active);
    const latest = series.manual_observations?.find(item => item.run_id === run.run_id);
    if (previous && !previous.dirty && !previous.pending &&
        (MotionAB.canonical(previous.baseline.answer) !== MotionAB.canonical(latest) ||
         MotionAB.canonical(previous.baseline.attempt) !== MotionAB.canonical(attempt))) {
      drafts.delete(active);
      status(active, '');
    }
    if (!drafts.has(active)) drafts.set(active, editor(series, run, attempt, save));
    const { form } = drafts.get(active);
    if (root.firstChild !== form) root.replaceChildren(form);
  }

  setup = setupFields($('manualSetup'));
  const confirmed = control($('manualSetup'), 'Подтверждаю введённые условия для этого запуска', 'input', 'confirm_setup', 'checkbox');
  confirmed.id = 'manualConfirmSetup';
  const targetChoice = select($('manualSetup'), 'Подтвердить для', 'setup_target',
    [['0', 'Следующий вариант'], ['1', 'Выбранный повтор']], '0');
  const targetLabel = node($('manualSetup'), 'p');
  const setupNotice = node($('manualSetup'), 'p');
  setupNotice.setAttribute('role', 'status');
  targetChoice.addEventListener('change', () => targets(...setupTargets));
  confirmed.addEventListener('change', () => {
    confirmationKey = confirmed.checked ? targetKey(setupTargets[Number(targetChoice.value)]) : null;
    setupNotice.textContent = '';
  });
  for (const field of Object.values(setup)) {
    field.addEventListener('input', () => invalidateSetup('Условия изменились. Подтвердите их заново.'));
    field.addEventListener('change', () => invalidateSetup('Условия изменились. Подтвердите их заново.'));
  }

  const exportWarning = node($('manualPanel'), 'div');
  exportWarning.id = 'manualExportWarning';
  exportWarning.setAttribute('role', 'status');

  function renderExportWarning() {
    exportWarning.replaceChildren();
    if (!warnedSeries) return false;
    const excluded = [...drafts.values()].filter(draft => draft.seriesId === warnedSeries &&
      (draft.pending || (draft.dirty && !draft.exportable)));
    if (!excluded.length) return false;
    node(exportWarning, 'p', 'Экспорт не включает несохранённые оценки этой серии. Откройте и сохраните их перед выгрузкой.');
    for (const { seriesId, runId, attempt } of excluded) {
      const button = node(exportWarning, 'button', 'Открыть черновик ' + runId + ', пара ' +
        attempt.pair_index + ', вариант ' + attempt.slot + ', попытка ' + attempt.attempt);
      button.type = 'button';
      button.addEventListener('click', () => openDraft(seriesId, runId));
    }
    return true;
  }

  function warnUnsaved(seriesId, open) {
    warnedSeries = seriesId;
    openDraft = open;
    if (!renderExportWarning()) return false;
    const draft = drafts.get(active);
    if (draft?.seriesId === seriesId && (draft.pending || (draft.dirty && !draft.exportable))) {
      status(active, 'Экспорт не включает открытый черновик. Сохраните оценку перед выгрузкой.');
    }
    exportWarning.querySelector('button')?.focus();
    return true;
  }

  window.MotionManualUI = { show, targets, confirmation, warnUnsaved,
    resetConfirmation: () => { confirmationKey = null; confirmed.checked = false; } };
})();

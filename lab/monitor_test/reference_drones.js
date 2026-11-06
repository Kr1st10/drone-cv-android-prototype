/* Local reference photographs. Missing identity/projection evidence must never produce metres. */
(function (root) {
  'use strict';
  const profiles = [
    {
      id: 'skydroid_mx330t', model: 'Skydroid MX330T', dimensions_mm: [578.5, 528.7, 80.5], propeller_in: 10,
      source: 'https://manuals.plus/m/cdf383498692198d887fa10755c69ab9184b1a1d70a87d5783d38abe953515f9',
      dimension_note: 'Габариты с установленными пропеллерами; руководство MX330T, раздел 12.',
      photo: {
        id: 'skydroid_top', view: 'top', label: 'Сверху — кандидат MX330/MX330T',
        file: 'reference_assets/skydroid_top.jpg', width: 416, height: 416, bounds_px: [90, 117, 330, 297],
        url: 'https://rcdrone.top/cdn/shop/files/Skydroid-MX330T-AI-FPV-Drone-24.webp?v=1743424171&width=416',
        source: 'https://rcdrone.top/products/skydroid-mx330-mx330t-drone',
        model_confirmed: false, projection_confirmed: false, axis: null,
        issue: 'Карточка объединяет MX330 и MX330T. Модификация и связь оси на фото с габаритом 578,5 мм не подтверждены.'
      }
    },
    {
      id: 'unik_sd_10ufp', model: 'UNIK SD-10UFP', dimensions_mm: [590, 530, 200], propeller_in: 10,
      source: 'https://nebodron.com.ua/en/drons/fpv-dron-10-dyujmiv-unik-sd-10ufp-z-s-stjemoyu-iniciaci-ta-djetjektorom-bpla-tinysa-ultra-en',
      dimension_note: 'Данные приложенного пакета: с пропеллерами и антенной. Источник при проверке 2026-11-06 вернул HTTP 525; повторно подтвердить размеры не удалось.',
      photo: {
        id: 'unik_near_top', view: 'near_top', label: 'Почти сверху — файл недоступен',
        file: null, width: null, height: null, bounds_px: null,
        url: 'https://nebodron.com.ua/image/cache/catalog/Drone%20Initiation/7-800x800.jpg',
        source: 'https://nebodron.com.ua/en/drons/fpv-dron-10-dyujmiv-unik-sd-10ufp-z-s-stjemoyu-iniciaci-ta-djetjektorom-bpla-tinysa-ultra-en',
        model_confirmed: false, projection_confirmed: false, axis: null,
        issue: 'Оригинал возвращает HTTP 525. В пакете отмечена перспектива; габарит с антенной нельзя приравнивать к ширине пропеллеров.'
      }
    },
    {
      id: 'gedz_10_dji', model: 'GEDZ 10 DJI', dimensions_mm: [500, 419, 60], propeller_in: 10,
      source: 'https://gedz.tech/gedz-10-dji',
      dimension_note: 'Производитель: 500 × 419 × 60 мм с пропеллерами; без них 335 × 251 × 60 мм.',
      photo: {
        id: 'gedz_top', view: 'plan_candidate', label: 'Плановый ракурс с оснасткой — верх не подтверждён',
        file: 'reference_assets/gedz_top.png', width: 800, height: 800, bounds_px: [85, 147, 722, 665],
        url: 'https://flasharmy-cdn.fsn1.your-objectstorage.com/image/cache/new-goods/fpvdrone1_4-800x800.png',
        source: 'https://flasharmy.com.ua/bpla-gedz-10-dji',
        model_confirmed: true, projection_confirmed: false, axis: null,
        issue: 'На снимке видна цилиндрическая оснастка. Строгий вид сверху, конфигурация и соответствие оси силуэта габаритам 500 × 419 мм не подтверждены.'
      }
    }
  ];
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

  /**
   * Measure the annotated object in CSS pixels, then reuse the gallery's mm and range functions.
   * `render` is the actually loaded image/scale and unclipped-object flag, never a desired CSS size.
   * A quantitative photo needs confirmed identity/projection plus axis {from, to, real_cm, source}.
   * Returns null for unavailable/unverified geometry; no side effects or guessed dimensions.
   */
  function measure(profile, render, distanceCm, mmPerCssPx, geometry) {
    const p = profile?.photo, empty = { display_width_cm: null, display_axis_cm: null, equivalent_distance_m: null };
    if (!p?.file || !render?.visible || render.width !== p.width || render.height !== p.height) return empty;
    const width = geometry.physicalWidth(p.bounds_px, p.width, p.height, render.scale, mmPerCssPx);
    const result = { ...empty, display_width_cm: positive(width) ? width / 10 : null };
    const a = p.axis;
    if (!p.model_confirmed || !p.projection_confirmed || !a || !positive(a.real_cm) || !a.source ||
        ![a.from, a.to].every(v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) &&
          v[0] >= p.bounds_px?.[0] && v[0] <= p.bounds_px?.[2] && v[1] >= p.bounds_px?.[1] && v[1] <= p.bounds_px?.[3])) return result;
    const axisMm = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]) * render.scale * mmPerCssPx;
    if (positive(width) && positive(axisMm)) {
      result.display_axis_cm = axisMm / 10;
      result.equivalent_distance_m = geometry.equivalentDistance(a.real_cm, distanceCm, axisMm);
    }
    return result;
  }

  /** Mount only the new tab. Settings use their own storage key; legacy trials/results are untouched. */
  function mount({ element, load, save, getCalibration, getDistance, geometry }) {
    const saved = load('reference_tab', {});
    let selected = profiles.find(p => p.id === saved?.model_id) || profiles[0];
    let scale = positive(saved?.scale_percent) && saved.scale_percent <= 200 ? saved.scale_percent : 100;
    let loaded = false;
    element.innerHTML = `
      <h3>Эксперимент с эталонными БПЛА</h3>
      <label>Коптер <select id="referenceDrone"></select></label>
      <p><span id="referenceDimensions"></span> · <span id="referenceSpecSource"></span></p>
      <p id="referenceView"></p>
      <div id="referenceViewport"><img id="referenceDisplay" alt=""><p id="referenceMissing" class="hidden">Фотография недоступна.</p></div>
      <p><label>Масштаб <input id="referenceScale" type="range" min="0.1" max="200" step="0.1"></label>
      <label><input id="referenceScaleNumber" type="number" min="0.1" max="200" step="any" aria-label="Масштаб фотографии, %"> %</label>
      <button id="referenceHalf">Уменьшить вдвое</button><button id="referenceDouble">Увеличить вдвое</button></p>
      <p id="referenceReadout" aria-live="polite"></p><p id="referenceIssue" class="warn"></p>
      <p class="muted">Лабораторная эквивалентная дальность по угловому размеру. Не измерение дальности обнаружения в полёте.</p>
      <details><summary>Дополнительно: источник фотографии и геометрия</summary>
        <p>100 % = один пиксель исходного файла на один CSS px. Белые поля не входят в измерение объекта. При обрезке объекта расчёт недоступен.</p>
        <p id="referenceDimensionNote"></p><p id="referenceDiagnostics"></p><p id="referencePhotoSource"></p>
        <p>Разрешение авторов на использование и публикацию фотографий подтверждено пользователем 2026-11-06. Это не подтверждение проекции.</p>
      </details>`;
    const $ = id => element.querySelector('#' + id);
    const select = $('referenceDrone'), image = $('referenceDisplay'), viewport = $('referenceViewport');
    for (const p of profiles) select.add(new Option(p.model, p.id));
    function persist() { save('reference_tab', { model_id: selected.id, view: selected.photo.view, scale_percent: scale }); }
    function link(node, url, label) { const a = document.createElement('a'); a.href = url; a.textContent = label; a.target = '_blank'; a.rel = 'noopener noreferrer'; node.replaceChildren(a); }
    function choose() {
      selected = profiles.find(p => p.id === select.value) || profiles[0];
      const p = selected.photo; loaded = false; image.removeAttribute('src');
      $('referenceDimensions').textContent = `${selected.dimensions_mm.join(' × ')} мм; пропеллеры ${selected.propeller_in}″`;
      $('referenceDimensionNote').textContent = selected.dimension_note;
      link($('referenceSpecSource'), selected.source, 'Источник характеристик');
      link($('referencePhotoSource'), p.source, 'Страница источника фотографии');
      $('referenceView').textContent = p.label;
      image.alt = selected.model + ' — ' + p.label;
      if (p.file) image.src = p.file;
      persist(); update();
    }
    function update() {
      const p = selected.photo, cal = getCalibration();
      $('referenceScale').value = scale;
      if (document.activeElement !== $('referenceScaleNumber')) $('referenceScaleNumber').value = scale;
      image.style.width = p.width * scale / 100 + 'px';
      image.classList.toggle('hidden', !loaded);
      $('referenceMissing').classList.toggle('hidden', loaded);
      const r = image.getBoundingClientRect(), v = viewport.getBoundingClientRect(), b = p.bounds_px;
      const panel = element.closest('.panel'), clip = panel.getBoundingClientRect();
      const left = Math.max(v.left, 0, clip.left + panel.clientLeft), top = Math.max(v.top, 0, clip.top + panel.clientTop);
      const right = Math.min(v.right, innerWidth, clip.left + panel.clientLeft + panel.clientWidth);
      const bottom = Math.min(v.bottom, innerHeight, clip.top + panel.clientTop + panel.clientHeight);
      const actualScale = p.width ? r.width / p.width : null;
      const visible = loaded && !!b && r.left + b[0] * actualScale >= left - 0.1 && r.top + b[1] * actualScale >= top - 0.1 &&
        r.left + b[2] * actualScale <= right + 0.1 && r.top + b[3] * actualScale <= bottom + 0.1;
      const m = measure(selected, { width: image.naturalWidth, height: image.naturalHeight, scale: actualScale, visible },
        getDistance(), cal?.mm_per_css_px, geometry);
      const fmt = n => n == null ? 'нет данных' : n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
      $('referenceReadout').textContent = `Масштаб: ${scale} %. Ширина силуэта на экране: ${fmt(m.display_width_cm)} см. Эквивалентная дальность: ${fmt(m.equivalent_distance_m)} м.`;
      if (m.display_axis_cm != null) $('referenceReadout').textContent += ` Размер расчётной оси: ${fmt(m.display_axis_cm)} см.`;
      $('referenceIssue').textContent = [p.issue, !loaded ? 'Локальная фотография не загружена.' : !visible ? 'Объект обрезан видимой областью. Уменьшите масштаб или прокрутите к фотографии.' : '',
        !$('referenceScaleNumber').validity.valid ? 'Некорректный масштаб: применяется последнее допустимое значение.' : '',
        !cal ? 'Нужна актуальная калибровка экрана.' : '', !positive(getDistance()) ? 'Введите расстояние от камеры до экрана.' : ''].filter(Boolean).join(' ');
      $('referenceDiagnostics').textContent = `ID: ${selected.id}; ракурс: ${p.view}; границы файла [x1, y1, x2, y2]: ${b ? b.join(', ') : 'нет'}; физическая ось: ${p.axis ? JSON.stringify(p.axis) : 'не подтверждена'}.`;
      return { model_id: selected.id, photo_id: p.id, view: p.view, scale_percent: scale, screen_distance_cm: getDistance(),
        display_width_cm: m.display_width_cm, display_axis_cm: m.display_axis_cm, equivalent_distance_m: m.equivalent_distance_m, calibration_id: cal?.id ?? null };
    }
    function setScale(value) {
      const n = Number(value);
      if (!positive(n) || n < 0.1 || n > 200) { $('referenceScaleNumber').setCustomValidity('Введите масштаб от 0,1 до 200 %.'); update(); return; }
      $('referenceScaleNumber').setCustomValidity(''); scale = n; persist(); update();
    }
    image.onload = () => { loaded = image.naturalWidth === selected.photo.width && image.naturalHeight === selected.photo.height; update(); };
    image.onerror = () => { loaded = false; update(); };
    select.onchange = choose;
    $('referenceScale').oninput = e => setScale(e.target.value);
    $('referenceScaleNumber').oninput = e => setScale(e.target.value);
    $('referenceHalf').onclick = () => setScale(Math.max(0.1, scale / 2));
    $('referenceDouble').onclick = () => setScale(Math.min(200, scale * 2));
    select.value = selected.id; choose();
    return { update, snapshot: update };
  }
  root.DroneReferences = { profiles, measure, mount };
})(typeof window === 'undefined' ? globalThis : window);

/* Local reference images. Strict geometry and explicitly assumed range estimates stay separate. */
(function (root) {
  'use strict';
  const profiles = [
    {
      "id": "skydroid_mx330t",
      "estimate_dimensions_mm": { "length": 578.5, "width": 528.7 },
      "model": "Skydroid MX330T",
      "dimensions_mm": [
        578.5,
        528.7,
        80.5
      ],
      "propeller_in": 10,
      "source": "https://manuals.plus/m/cdf383498692198d887fa10755c69ab9184b1a1d70a87d5783d38abe953515f9",
      "dimension_note": "Габариты с установленными пропеллерами; руководство MX330T, раздел 12.",
      "photos": [
        {
          "id": "skydroid_top",
          "review_segment": {
            "label": "Центры противоположных моторов — кандидат, не подтверждённая физическая ось",
            "from": [140, 147],
            "to": [281, 266],
            "nominal_real_mm": 430,
            "source": "https://manuals.plus/m/cdf383498692198d887fa10755c69ab9184b1a1d70a87d5783d38abe953515f9",
            "status": "unconfirmed",
            "issue": "430 мм указаны для MX330T, но точная рама на общей иллюстрации MX330/MX330T не установлена. Ракурс выглядит плановым; независимого подтверждения проекции нет. Номинал не используется в расчёте дальности."
          },
          "view": "top",
          "label": "Сверху — кандидат MX330/MX330T",
          "file": "reference_assets/skydroid_top.jpg",
          "width": 416,
          "height": 416,
          "bounds_px": [
            90,
            117,
            330,
            297
          ],
          "url": "https://rcdrone.top/cdn/shop/files/Skydroid-MX330T-AI-FPV-Drone-24.webp?v=1743424171&width=416",
          "source": "https://rcdrone.top/products/skydroid-mx330-mx330t-drone",
          "sha256": "659839b4f3f303ce8e66663ae1751858bb65aa865ed3e875317ce885e6f93f0a",
          "model_confirmed": false,
          "object_complete": true,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Модификация MX330T не подтверждена общей карточкой. Габариты L/W не размечены на исходнике; положение лопастей отличается от предельного паспортного контура."
        },
        {
          "id": "skydroid_front",
          "view": "front",
          "label": "Спереди — MX330T",
          "file": "reference_assets/skydroid_front.jpg",
          "width": 1000,
          "height": 1000,
          "bounds_px": [
            0,
            260,
            1000,
            670
          ],
          "url": "https://funyat.com/cdn/shop/files/mx330t-drone-thermal-imaging.jpg?v=1758160978&width=1445",
          "source": "https://funyat.com/products/mx330t-10inch-fpv-drone-dual-light-2k-camera-thermal-imaging-drone-20km-gps-3kg-payload-rtk-ai-tracking-folding-quadcopter",
          "sha256": "c8649c9ec2518d91df67fc1efec44ff099205297277fe13c73cfc3d787f1a406",
          "model_confirmed": true,
          "object_complete": false,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Фронтальный перспективный ракурс; пропеллеры у краёв файла обрезаны. Верхние L/W нельзя приравнивать к горизонтали снимка."
        },
        {
          "id": "skydroid_oblique_candidate",
          "view": "oblique_candidate",
          "label": "Под углом — источник указывает MX330, версия T не подтверждена",
          "file": "reference_assets/skydroid_oblique_candidate.png",
          "width": 800,
          "height": 800,
          "bounds_px": [
            25,
            230,
            790,
            570
          ],
          "url": "https://ecdn6-nc.globalso.com/upload/p/1618/image_product/2024-08/high-precision-ultra-fast-flying-drones-mx330-4.png",
          "source": "https://www.edinguas.com/high-precision-ultra-fast-flying-drones-mx330/",
          "sha256": "1cf0d7f251fc130c672fb1e53770d583bb2207e0372a228d197719a122d4930a",
          "model_confirmed": false,
          "object_complete": true,
          "projection_confirmed": false,
          "axis": null,
          "issue": "На странице источника указана MX330, не подтверждён MX330T. Снимок показан для просмотра, исключён из метрических эталонов; перспектива и размытие винтов."
        }
      ]
    },
    {
      "id": "unik_sd_10ufp",
      "estimate_dimensions_mm": { "length": 530, "width": 590 },
      "model": "UNIK SD-10UFP",
      "dimensions_mm": [
        590,
        530,
        200
      ],
      "propeller_in": 10,
      "source": "https://nebodron.com.ua/en/drons/fpv-dron-10-dyujmiv-unik-sd-10ufp-z-s-stjemoyu-iniciaci-ta-djetjektorom-bpla-tinysa-ultra-en",
      "dimension_note": "W × D × H = 590 × 530 × 200 мм с пропеллерами и антенной; подтверждено индексированным текстом источника. Живая страница HTTP 525; пиксельные оси не установлены.",
      "photos": [
        {
          "id": "unik_near_top",
          "view": "near_top",
          "label": "Почти сверху — недоступно",
          "file": null,
          "width": null,
          "height": null,
          "bounds_px": null,
          "url": "https://nebodron.com.ua/image/cache/catalog/Drone%20Initiation/7-800x800.jpg",
          "source": "https://nebodron.com.ua/en/drons/fpv-dron-10-dyujmiv-unik-sd-10ufp-z-s-stjemoyu-iniciaci-ta-djetjektorom-bpla-tinysa-ultra-en",
          "sha256": null,
          "model_confirmed": false,
          "object_complete": false,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Файл 7: HTTPS 525, HTTP 404; копии в предоставленном ZIP нет. Оси W/D включают антенну, привязка точек и перспектива не проверены."
        },
        {
          "id": "unik_oblique_a",
          "view": "oblique",
          "label": "Под углом ¾ (A) — недоступно",
          "file": null,
          "width": null,
          "height": null,
          "bounds_px": null,
          "url": "https://nebodron.com.ua/image/cache/catalog/Drone%20Initiation/3-800x800.jpg",
          "source": "https://nebodron.com.ua/en/drons/fpv-dron-10-dyujmiv-unik-sd-10ufp-z-s-stjemoyu-iniciaci-ta-djetjektorom-bpla-tinysa-ultra-en",
          "sha256": null,
          "model_confirmed": false,
          "object_complete": false,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Файл 3: HTTPS 525, HTTP 404; копии в предоставленном ZIP нет. Без изображения невозможно проверить модель, перспективу и измерительные точки."
        },
        {
          "id": "unik_oblique_b",
          "view": "oblique",
          "label": "Под углом ¾ (B) — недоступно",
          "file": null,
          "width": null,
          "height": null,
          "bounds_px": null,
          "url": "https://nebodron.com.ua/image/cache/catalog/Drone%20Initiation/6-800x800.jpg",
          "source": "https://nebodron.com.ua/en/drons/fpv-dron-10-dyujmiv-unik-sd-10ufp-z-s-stjemoyu-iniciaci-ta-djetjektorom-bpla-tinysa-ultra-en",
          "sha256": null,
          "model_confirmed": false,
          "object_complete": false,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Файл 6: HTTPS 525, HTTP 404; копии в предоставленном ZIP нет. Без изображения невозможно проверить модель, перспективу и измерительные точки."
        }
      ]
    },
    {
      "id": "gedz_10_dji",
      "estimate_dimensions_mm": { "length": 500, "width": 419 },
      "model": "GEDZ 10 DJI",
      "dimensions_mm": [
        500,
        419,
        60
      ],
      "propeller_in": 10,
      "source": "https://gedz.tech/gedz-10-dji",
      "dimension_note": "Производитель: 500 × 419 × 60 мм с пропеллерами; без них 335 × 251 × 60 мм.",
      "photos": [
        {
          "id": "gedz_top",
          "view": "top",
          "label": "Плановый ракурс с оснасткой — верх не подтверждён",
          "file": "reference_assets/gedz_top.png",
          "width": 800,
          "height": 800,
          "bounds_px": [
            85,
            147,
            722,
            665
          ],
          "url": "https://flasharmy-cdn.fsn1.your-objectstorage.com/image/cache/new-goods/fpvdrone1_4-800x800.png",
          "source": "https://flasharmy.com.ua/bpla-gedz-10-dji",
          "sha256": "7e4cd764af0f2bf0bc420a3658462b04e179325f9a4d80c3295e21c41498be44",
          "model_confirmed": true,
          "object_complete": true,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Габариты с пропеллерами 500 × 419 мм подтверждены, но размерных линий к фото нет. 335 × 251 мм без винтов — общий габарит, не расстояние между моторами; его концы на этом изображении не установлены, центр рамы перекрыт оснасткой. Положение лопастей, проекция и соответствие концов оси не установлены; наличие цилиндра само по себе не запрещает ось рамы."
        },
        {
          "id": "gedz_oblique",
          "view": "oblique",
          "label": "Под углом ¾ — конфигурация не подтверждена",
          "file": "reference_assets/gedz_oblique.png",
          "width": 800,
          "height": 800,
          "bounds_px": [
            0,
            16,
            797,
            595
          ],
          "url": "https://flasharmy-cdn.fsn1.your-objectstorage.com/image/cache/new-goods/fpvdrone1_1-800x800.png",
          "source": "https://flasharmy.com.ua/bpla-gedz-10-dji",
          "sha256": "ad85555e540da64dcad12f2d9e8f78f7a09991536469ffaef2c7754ba96ade38",
          "model_confirmed": false,
          "object_complete": false,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Карточка GEDZ 10 DJI, но комплектующие/конфигурация отличаются от планового снимка и не верифицированы. Перспектива и обрезка пропеллера у края; метрическая привязка отсутствует."
        },
        {
          "id": "gedz_side",
          "view": "side",
          "label": "Профиль с цилиндрической оснасткой",
          "file": "reference_assets/gedz_side.png",
          "width": 800,
          "height": 800,
          "bounds_px": [
            0,
            260,
            800,
            590
          ],
          "url": "https://flasharmy-cdn.fsn1.your-objectstorage.com/image/cache/new-goods/fpvdrone1_6-800x800.png",
          "source": "https://flasharmy.com.ua/bpla-gedz-10-dji",
          "sha256": "50ade8bf44ae4ca0b7f0676abbfee014677268c73618e53a3c9cc8e39462742b",
          "model_confirmed": true,
          "object_complete": false,
          "projection_confirmed": false,
          "axis": null,
          "issue": "Профиль с оснасткой; концы пропеллеров обрезаны границами файла. Верхние размеры 500/419 мм не соответствуют видимому отрезку профиля. Габарит 335 мм без винтов не привязан к видимым концам рамы; межмоторное расстояние не дано."
        }
      ]
    }
  ];
  // Replace these data fields after measuring the cabinet drone; no geometry code changes needed.
  profiles.unshift({
    ...profiles[0], id: 'cabinet_reference', model: 'Эталонный БПЛА из кабинета',
    dimension_note: 'Временные тестовые данные Skydroid MX330T. Настоящий эталон ещё не измерен.',
    photos: ['front', 'oblique_candidate', 'top'].map((view, i) => ({
      ...profiles[0].photos.find(p => p.view === view), id: 'cabinet_' + view,
      label: ['Спереди — 0°', 'Под углом ¾ — поворот корпуса 45°', 'Сверху — контрольный ракурс'][i],
      projection_width_mm: [528.7, 600, 528.7][i], projection_status: 'preliminary',
      transparent: false, model_confirmed: false, projection_confirmed: false, review_segment: null,
      issue: 'Временное фото Skydroid, не фотография кабинетного эталона. Ракурс и ширина видимой проекции предварительные; 45° на фото не подтверждены.' + (view === 'front' ? ' Фронтальный исходник обрезан: оценка относится только к размеченной видимой части, не полному габариту.' : '')
    }))
  });
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

  /**
   * Measure the annotated object in CSS pixels, then reuse the gallery's mm and range functions.
   * `render` is the decoded image/actual CSS scale; visible means valid loaded geometry, independent of preview clipping.
   * `render.photo_id` selects that photo only; omitted IDs select the primary photo, unknown IDs return nulls.
   * A quantitative photo needs confirmed identity/projection plus axis {from, to, real_cm, source}.
   * Returns null for unavailable/unverified geometry; no side effects or guessed dimensions.
   */
  function measure(profile, render, distanceCm, mmPerCssPx, geometry) {
    const p = render?.photo_id ? profile?.photos?.find(p => p.id === render.photo_id) : profile?.photos?.[0];
    const empty = { display_width_cm: null, display_axis_cm: null, equivalent_distance_m: null };
    if (!p?.file || p.object_complete === false || !render?.visible || render.width !== p.width || render.height !== p.height) return empty;
    const width = geometry.physicalWidth(p.bounds_px, p.width, p.height, render.scale, mmPerCssPx);
    const result = { ...empty, display_width_cm: positive(width) ? width / 10 : null };
    const a = p.axis;
    if (p.object_complete === false || !p.model_confirmed || !p.projection_confirmed || !a || !positive(a.real_cm) || !a.source ||
        ![a.from, a.to].every(v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) &&
          v[0] >= p.bounds_px?.[0] && v[0] <= p.bounds_px?.[2] && v[1] >= p.bounds_px?.[1] && v[1] <= p.bounds_px?.[3])) return result;
    const axisMm = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]) * render.scale * mmPerCssPx;
    if (positive(width) && positive(axisMm)) {
      result.display_axis_cm = axisMm / 10;
      result.equivalent_distance_m = geometry.equivalentDistance(a.real_cm, distanceCm, axisMm);
    }
    return result;
  }

  /** Horizontal visible silhouette + assumed physical extent; never a verified photo axis. */
  function estimate(profile, render, distanceCm, mmPerCssPx, geometry) {
    const p = render?.photo_id ? profile?.photos?.find(p => p.id === render.photo_id) : profile?.photos?.[0];
    const empty = { display_width_cm: null, display_axis_cm: null, equivalent_distance_m: null,
      assumed_extent_mm: null, assumption: null };
    if (!p?.file || !render?.visible || render.width !== p.width || render.height !== p.height) return empty;
    const widthMm = geometry.physicalWidth(p.bounds_px, p.width, p.height, render.scale, mmPerCssPx);
    if (!positive(widthMm)) return empty;
    const d = profile.estimate_dimensions_mm;
    let extent, assumption;
    if (positive(p.projection_width_mm)) {
      extent = p.projection_width_mm;
      assumption = 'Предварительная оценка: отдельная ширина размеченной видимой проекции этого ракурса. Временные тестовые данные; не формула габаритного прямоугольника и не подтверждённая геометрия.';
    } else if (p.view === 'front' || p.view === 'top' || p.view === 'near_top') {
      extent = d?.width;
      assumption = p.view === 'front' ? 'Спереди: поперечный габарит W.' : 'Сверху: горизонталь силуэта принята за поперечную паспортную ось W.';
    } else if (p.view === 'side') {
      extent = d?.length; assumption = 'Сбоку: продольный габарит L.';
    } else if (p.view === 'oblique' || p.view === 'oblique_candidate') {
      extent = positive(d?.width) && positive(d?.length) ? (d.width + d.length) / Math.SQRT2 : null;
      assumption = '¾: условный угол 45°, W·cos(45°) + L·sin(45°).';
    }
    if (!positive(extent)) return { ...empty, display_width_cm: widthMm / 10 };
    if (p.object_complete === false && !positive(p.projection_width_mm)) return { ...empty, display_width_cm: widthMm / 10,
      assumption: 'Исходник обрезан. Видимая часть не приравнивается полному габариту: дальность недоступна без физически обоснованного отрезка.' };
    if (p.object_complete === false) assumption += ' Исходник обрезан: предварительно оценивается только видимая размеченная часть.';
    if (!p.model_confirmed) assumption += ' Точная модель/комплектация изображения не подтверждена.';
    return { ...empty, display_width_cm: widthMm / 10, assumed_extent_mm: extent,
      equivalent_distance_m: geometry.equivalentDistance(extent / 10, distanceCm, widthMm), assumption };
  }

  function reviewSegmentLength(photo, render, mmPerCssPx) {
    const a = photo?.review_segment;
    if (!a || !photo.file || !render?.visible || render.width !== photo.width || render.height !== photo.height ||
        !positive(render.scale) || !positive(mmPerCssPx) ||
        ![a.from, a.to].every(v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) &&
          v[0] >= 0 && v[0] <= photo.width && v[1] >= 0 && v[1] <= photo.height)) return null;
    const length = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]) * render.scale * mmPerCssPx;
    return positive(length) ? length : null;
  }

  /** Mount only the new tab. Settings use their own storage key; legacy trials/results are untouched. */
  function mount({ element, load, save, getCalibration, getDistance, geometry }) {
    const saved = load('reference_tab', {});
    let selected = profiles.find(p => p.id === saved?.model_id) || profiles[0];
    let scale = positive(saved?.scale_percent) && saved.scale_percent >= 0.01 && saved.scale_percent <= 1000 ? saved.scale_percent : 25;
    let loaded = false, loadState = 'missing', loadGeneration = 0, trialTransition = false, targetError = '';
    let background = saved?.background === 'sky' ? 'sky' : 'neutral';
    let camera = saved?.camera === '1' ? '1' : '5';
    let mode = saved?.range_mode === 'strict' ? 'strict' : 'approximate';
    element.innerHTML = `
      <h3>Эксперимент с эталонными БПЛА</h3>
      <label>Коптер <select id="referenceDrone"></select></label>
      <label>Фотография <select id="referencePhotoSelect"></select></label>
      <label>Расчёт <select id="referenceRangeMode"><option value="approximate">Приближённая оценка</option><option value="strict">Строгий: подтверждённая ось</option></select></label>
      <p><span id="referenceDimensions"></span> · <span id="referenceSpecSource"></span></p>
      <p id="referenceView"></p>
      <div id="referenceViewport"><img id="referenceDisplay" alt=""><svg id="referenceSegmentOverlay" aria-hidden="true" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none"></svg><p id="referenceMissing" class="hidden">Фотография недоступна.</p></div>
      <p><label>Масштаб <input id="referenceScale" type="range" min="0.1" max="1000" step="0.1"></label>
      <label><input id="referenceScaleNumber" type="number" min="0.01" max="1000" step="any" aria-label="Масштаб фотографии, %"> %</label>
      <button id="referenceHalf">Уменьшить вдвое</button><button id="referenceDouble">Увеличить вдвое</button></p>
      <p><label>Желаемая эквивалентная дальность, м <input id="referenceTarget" type="text" inputmode="decimal" placeholder="100,00"></label><button id="referenceApplyTarget">Рассчитать масштаб</button><span id="referenceTargetStatus" role="status"></span></p>
      <p><label>Камера Xiaomi 17 Pro <select id="referenceCamera"><option value="5">Физическая телекамера 5× — план опыта</option><option value="1">1× — сравнение</option></select></label></p>
      <p>1×/5× — обозначение условий опыта. Дальность не умножается на 5; камера меняет размер объекта в кадре YOLO. Использование физического телевика проверяется на телефоне.</p>
      <p><label>Фон <select id="referenceBackground"><option value="neutral">Нейтральный однотонный</option><option value="sky">Фиксированное небо</option></select></label><button id="referenceTrial">Режим испытания</button></p>
      <p id="referenceBackgroundNote"></p>
      <p id="referenceReadout" aria-live="polite"></p>
      <details id="referenceSegmentReview" class="hidden"><summary>Проверяемая моторная диагональ — не подтверждена</summary><label><input id="referenceSegmentToggle" type="checkbox"> Показать проверяемый отрезок A–B (не подтверждён)</label><p id="referenceSegmentReadout"></p></details><p id="referenceAssumption" class="warn"></p><p id="referenceIssue" class="warn"></p>
      <p class="muted">Лабораторная эквивалентная дальность по угловому размеру. Не измерение дальности обнаружения в полёте.</p>
      <details><summary>Дополнительно: источник фотографии и геометрия</summary>
        <p>100 % = один пиксель исходного файла на один CSS px. Белые поля не входят в измерение объекта. Предпросмотр может обрезать изображение, не меняя расчёт. Полноэкранный режим отдельно проверяет, помещается ли объект на экране. Обрезанный силуэт не приравнивается полному габариту. Для него нужен отдельный достоверный отрезок.</p>
        <p id="referenceDimensionNote"></p><p id="referenceDiagnostics"></p><p id="referencePhotoSource"></p>
        <p>Разрешение авторов на использование и публикацию фотографий подтверждено пользователем 2026-11-06. Это не подтверждение проекции.</p>
      </details>`;
    const $ = id => element.querySelector('#' + id);
    const select = $('referenceDrone'), photoSelect = $('referencePhotoSelect'), viewport = $('referenceViewport');
    let image = $('referenceDisplay');
    const decodedImages = new Map();
    let photo = selected.photos.find(p => p.id === saved?.photo_id) || selected.photos[0];
    for (const p of profiles) select.add(new Option(p.model, p.id));
    function persist() { save('reference_tab', { model_id: selected.id, photo_id: photo.id, view: photo.view, scale_percent: scale, range_mode: mode, background, camera }); }
    function link(node, url, label) { const a = document.createElement('a'); a.href = url; a.textContent = label; a.target = '_blank'; a.rel = 'noopener noreferrer'; node.replaceChildren(a); }
    function choosePhoto() {
      photo = selected.photos.find(p => p.id === photoSelect.value) || selected.photos[0];
      const p = photo, generation = ++loadGeneration;
      loaded = false; loadState = p.file ? 'loading' : 'missing'; targetError = '';
      $('referenceDimensions').textContent = `${selected.dimensions_mm.join(' × ')} мм; пропеллеры ${selected.propeller_in}″`;
      $('referenceDimensionNote').textContent = selected.dimension_note;
      link($('referenceSpecSource'), selected.source, 'Источник характеристик');
      link($('referencePhotoSource'), p.source, 'Страница источника фотографии');
      $('referenceView').textContent = p.label;
      // Decode a separate request-owned image. Old events can never publish into the new selection.
      const expected = p.file && new URL(p.file, document.baseURI).href;
      const cached = decodedImages.get(expected);
      const next = cached || new Image(); next.id = 'referenceDisplay';
      next.alt = selected.model + ' — ' + p.label;
      next.onload = () => {
        if (generation !== loadGeneration || next.currentSrc !== expected) return;
        loaded = next.naturalWidth === p.width && next.naturalHeight === p.height;
        loadState = loaded ? 'ready' : 'error';
        if (loaded) { decodedImages.set(expected, next); if (image !== next) image.replaceWith(next); image = next; }
        update();
      };
      next.onerror = () => { if (generation === loadGeneration) { loaded = false; loadState = 'error'; update(); } };
      if (cached) next.onload();
      else if (p.file) next.src = p.file;
      else {
        const empty = document.createElement('img'); empty.id = 'referenceDisplay'; empty.alt = '';
        image.replaceWith(empty); image = empty;
      }
      persist(); update();
    }
    function chooseModel(preferredPhoto = null) {
      selected = profiles.find(p => p.id === select.value) || profiles[0];
      photoSelect.replaceChildren();
      for (const p of selected.photos) photoSelect.add(new Option(p.label, p.id));
      photoSelect.value = selected.photos.some(p => p.id === preferredPhoto) ? preferredPhoto : selected.photos[0].id;
      choosePhoto();
    }
    function update() {
      const p = photo, cal = getCalibration();
      $('referenceRangeMode').value = mode;
      $('referenceBackground').value = background; $('referenceCamera').value = camera;
      viewport.classList.toggle('reference-sky', background === 'sky');
      $('referenceBackgroundNote').textContent = background === 'sky' && !p.transparent ? 'Локальный рисунок неба. Исходное фото непрозрачное: его собственный фон остаётся прямоугольником; корректное наложение дрона на небо не имитируется.' : background === 'sky' ? 'Локальный рисунок неба; используется прозрачный исходник.' : 'Нейтральный однотонный фон. Собственный фон фотографии сохраняется.';
      $('referenceScale').value = scale;
      if (document.activeElement !== $('referenceScaleNumber')) $('referenceScaleNumber').value = scale;
      image.style.width = p.width * scale / 100 + 'px';
      image.classList.toggle('hidden', !loaded);
      $('referenceMissing').classList.toggle('hidden', loaded);
      $('referenceMissing').textContent = loadState === 'loading' ? 'Загрузка выбранной фотографии…' : loadState === 'error' ? 'Ошибка загрузки или неверные размеры фотографии.' : 'Фотография недоступна.';
      const r = image.getBoundingClientRect(), v = viewport.getBoundingClientRect(), b = p.bounds_px;
      const trial = document.fullscreenElement === viewport;
      const panel = trial ? viewport : element.closest('.panel'), clip = panel.getBoundingClientRect();
      const left = Math.max(v.left, 0, clip.left + panel.clientLeft), top = Math.max(v.top, 0, clip.top + panel.clientTop);
      const right = Math.min(v.right, innerWidth, clip.left + panel.clientLeft + panel.clientWidth);
      const bottom = Math.min(v.bottom, innerHeight, clip.top + panel.clientTop + panel.clientHeight);
      const actualScale = loaded && p.width ? r.width / p.width : null;
      const previewVisible = loaded && !!b && r.left + b[0] * actualScale >= left - 0.1 && r.top + b[1] * actualScale >= top - 0.1 &&
        r.left + b[2] * actualScale <= right + 0.1 && r.top + b[3] * actualScale <= bottom + 0.1;
      const m = (mode === 'strict' ? measure : estimate)(selected, { photo_id: p.id, width: image.naturalWidth, height: image.naturalHeight, scale: actualScale, visible: loaded },
        getDistance(), cal?.mm_per_css_px, geometry);
      const capacityWidth = trial ? Math.min(v.width, innerWidth) : screen.width;
      const capacityHeight = trial ? Math.min(v.height, innerHeight) : screen.height;
      const fullscreenFits = loaded && !!b && positive(actualScale) &&
        capacityWidth / 2 + (b[0] - p.width / 2) * actualScale >= -0.1 &&
        capacityHeight / 2 + (b[1] - p.height / 2) * actualScale >= -0.1 &&
        capacityWidth / 2 + (b[2] - p.width / 2) * actualScale <= capacityWidth + 0.1 &&
        capacityHeight / 2 + (b[3] - p.height / 2) * actualScale <= capacityHeight + 0.1;
      const fmt = n => n == null ? 'нет данных' : n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
      const candidate = p.review_segment, overlay = $('referenceSegmentOverlay');
      const segmentMm = reviewSegmentLength(p, { width: image.naturalWidth, height: image.naturalHeight, scale: actualScale, visible: loaded }, cal?.mm_per_css_px);
      $('referenceSegmentReview').classList.toggle('hidden', !candidate);
      overlay.replaceChildren();
      overlay.classList.toggle('hidden', !candidate || !loaded || !$('referenceSegmentToggle').checked);
      if (candidate) {
        overlay.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
        overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
        const svg = (tag, attrs) => {
          const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
          for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
          overlay.append(node); return node;
        };
        svg('line', { x1: candidate.from[0], y1: candidate.from[1], x2: candidate.to[0], y2: candidate.to[1],
          stroke: '#b00060', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' });
        for (const [i, point] of [candidate.from, candidate.to].entries()) {
          svg('circle', { cx: point[0], cy: point[1], r: 3, fill: '#fff', stroke: '#b00060' });
          svg('text', { x: point[0] + 6, y: point[1] - 6, fill: '#b00060', 'font-size': 14 }).textContent = i ? 'B' : 'A';
        }
        $('referenceSegmentReadout').textContent = `${candidate.label}. A=(${candidate.from.join(', ')}), B=(${candidate.to.join(', ')}) px оригинала ${p.width}×${p.height}. ` +
          `Длина A–B на экране: ${fmt(segmentMm == null ? null : segmentMm / 10)} см. ${candidate.issue} ` +
          'Для ручной проверки включите A–B и измерьте линейкой расстояние между центрами меток. Программное значение не заменяет физический замер линейкой.';
      }

      if (trial && (m.equivalent_distance_m == null || !fullscreenFits)) {
        targetError = 'Испытание остановлено: калибровка недействительна или изображение обрезано.';
        document.exitFullscreen().catch(() => {});
      }
      const range = loadState === 'loading' ? 'Загрузка выбранной фотографии…' : m.equivalent_distance_m == null ? 'нет данных' :
        `${mode === 'approximate' ? '≈ ' : ''}${m.equivalent_distance_m.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} м`;
      $('referenceAssumption').textContent = mode === 'approximate' ?
        `Приближённая оценка, не точная дальность и не подтверждённая геометрия. ${m.assumption || 'Для оценки нужны доступное изображение и ширина видимого коптера.'}${positive(m.assumed_extent_mm) ? ` Принятый габарит: ${fmt(m.assumed_extent_mm)} мм.` : ''}` :
        'Строгий режим: метры доступны только для подтверждённой физической оси и проекции.';
      $('referenceReadout').textContent = `Масштаб: ${scale} %. До экрана: ${fmt(getDistance())} см. Ширина силуэта на экране: ${fmt(m.display_width_cm)} см. Эквивалентная дальность: ${range}.`;
      if (m.display_axis_cm != null) $('referenceReadout').textContent += ` Размер расчётной оси: ${fmt(m.display_axis_cm)} см.`;
      $('referenceTargetStatus').textContent = targetError;
      $('referenceIssue').textContent = [p.issue, !loaded ? (loadState === 'loading' ? 'Загрузка выбранной фотографии…' : 'Локальная фотография не загружена или её размеры неверны.') : !previewVisible ? 'Предпросмотр показывает часть изображения. Расчёт использует полный размер объекта при заданном масштабе.' : '',
        loaded && !fullscreenFits ? 'Объект не помещается на экране в полноэкранном режиме. Уменьшите масштаб; математическая дальность показана для полного размера.' : '',
        !$('referenceScaleNumber').validity.valid ? 'Некорректный масштаб: применяется последнее допустимое значение.' : '',
        !cal ? 'Нужна актуальная калибровка экрана.' : '', !positive(getDistance()) ? 'Введите расстояние от камеры до экрана.' : ''].filter(Boolean).join(' ');
      $('referenceDiagnostics').textContent = `ID: ${selected.id}; ракурс: ${p.view}; границы файла [x1, y1, x2, y2]: ${b ? b.join(', ') : 'нет'}; физическая ось: ${p.axis ? JSON.stringify(p.axis) : 'не подтверждена'}.`;
      return { model_id: selected.id, photo_id: p.id, view: p.view, scale_percent: scale, screen_distance_cm: getDistance(),
        load_state: loadState, preview_visible: previewVisible, fullscreen_fits: fullscreenFits,
        image_width_css_px: loaded ? r.width : null, image_height_css_px: loaded ? r.height : null, review_segment_display_mm: segmentMm,
        camera_label: camera + '×', background, range_mode: mode, assumed_extent_mm: m.assumed_extent_mm ?? null, assumption: m.assumption ?? null,
        display_width_cm: m.display_width_cm, display_axis_cm: m.display_axis_cm, equivalent_distance_m: m.equivalent_distance_m, calibration_id: cal?.id ?? null };
    }
    function setScale(value) {
      const n = Number(value);
      if (!positive(n) || n < 0.01 || n > 1000) { $('referenceScaleNumber').setCustomValidity('Введите масштаб от 0,01 до 1000 %.'); update(); return; }
      $('referenceScaleNumber').setCustomValidity(''); scale = n; persist(); update();
    }
    $('referenceSegmentToggle').onchange = update;
    $('referenceRangeMode').onchange = e => { mode = e.target.value === 'strict' ? 'strict' : 'approximate'; persist(); update(); };
    select.onchange = () => chooseModel();
    photoSelect.onchange = choosePhoto;
    $('referenceScale').oninput = e => setScale(e.target.value);
    $('referenceScaleNumber').oninput = e => setScale(e.target.value);
    $('referenceHalf').onclick = () => setScale(Math.max(0.01, scale / 2));
    $('referenceDouble').onclick = () => setScale(Math.min(1000, scale * 2));
    // Fullscreen changes viewport dimensions, but must not change CSS-pixel physical scale.
    const environment = () => ({ dpr: devicePixelRatio, width: screen.width, height: screen.height,
      available_width: screen.availWidth, available_height: screen.availHeight,
      visual_scale: window.visualViewport?.scale ?? 1 });
    function calibrationEnvironmentMatches(before, after, referenceActive = false) {
      const transitioning = trialTransition || document.fullscreenElement === viewport;
      if (!transitioning && !referenceActive) return false;
      // Viewport resizing does not change mm/CSSpx. Still reject screen/zoom changes and ordinary window moves.
      return before && after && Object.keys(environment()).every(k => before[k] === after[k]) &&
        (transitioning || (before.x === after.x && before.y === after.y));
    }
    $('referenceCamera').onchange = e => { camera = e.target.value; persist(); update(); };
    $('referenceBackground').onchange = e => { background = e.target.value; persist(); update(); };
    $('referenceApplyTarget').onclick = () => {
      targetError = '';
      const target = Number($('referenceTarget').value.trim().replace(',', '.'));
      viewport.scrollIntoView({ block: 'center' });
      const cal = getCalibration();
      if (!positive(target)) targetError = 'Введите положительную дальность в метрах, например 100,00.';
      else if (!cal) targetError = 'Нужна актуальная калибровка экрана.';
      else if (!loaded || !positive(getDistance())) targetError = 'Нужны загруженное изображение и расстояние до монитора.';
      else {
        // Probe at unit scale: independent of current clipping; never use rounded readout values.
        const unit = (mode === 'strict' ? measure : estimate)(selected,
          { photo_id: photo.id, width: image.naturalWidth, height: image.naturalHeight, scale: 1, visible: true },
          getDistance(), cal.mm_per_css_px, geometry);
        const needed = unit.equivalent_distance_m / target * 100;
        if (!positive(needed)) targetError = 'У этого ракурса нет физической ширины проекции для выбранного режима расчёта.';
        else if (needed < 0.01 || needed > 1000) targetError = 'Заданная дальность требует масштаба вне диапазона 0,01–1000 %.';
        else {
          const previous = scale;
          setScale(needed);
          const actual = update();
          if (!positive(actual.equivalent_distance_m) || !actual.fullscreen_fits) {
            setScale(previous);
            targetError = 'Требуемый объект не помещается на экране в полноэкранном режиме. Увеличьте заданную дальность или уменьшите масштаб.';
          } else targetError = 'Масштаб рассчитан. Фактическая дальность показана ниже с учётом CSS-размера; предварительные размеры остаются оценкой. Вместимость окончательно проверяется при входе в полноэкранный режим.';
        }
      }
      update();
    };
    $('referenceTrial').onclick = async () => {
      targetError = '';
      viewport.scrollIntoView({ block: 'center' });
      const state = update();
      if (!positive(state.equivalent_distance_m)) { targetError = 'Сначала получите корректную геометрию изображения: проверьте калибровку, ракурс, расстояние и обрезку.'; update(); return; }
      if (!state.fullscreen_fits) { targetError = 'Объект не помещается на экране в полноэкранном режиме. Уменьшите масштаб.'; update(); return; }
      if (!viewport.requestFullscreen) { targetError = 'Браузер не поддерживает полноэкранный режим.'; update(); return; }
      trialTransition = true;
      try { await viewport.requestFullscreen(); update(); }
      catch { targetError = 'Браузер не разрешил полноэкранный режим.'; update(); }
      finally { if (document.fullscreenElement !== viewport) trialTransition = false; }
    };
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === viewport) { update(); return; }
      if (trialTransition) {
        // Give resize/visualViewport events the same controlled transition exemption on exit.
        requestAnimationFrame(() => requestAnimationFrame(() => { update(); trialTransition = false; }));
      }
    });
    // No legacy gallery shortcuts or scrolling while the clean stimulus is visible.
    document.addEventListener('keydown', e => {
      if (document.fullscreenElement === viewport) e.stopImmediatePropagation();
    }, true);
    select.value = selected.id; chooseModel(photo.id);
    return { update, snapshot: update, calibrationEnvironmentMatches };
  }
  root.DroneReferences = { profiles, measure, estimate, reviewSegmentLength, mount };
})(typeof window === 'undefined' ? globalThis : window);

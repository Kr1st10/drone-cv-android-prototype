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
  const cabinetDimensions = {
    span_transverse: 580, span_longitudinal: 530,
    motor_transverse: 325, motor_longitudinal: 275, motor_diagonal: 428,
    propeller_radius: 126, height_without_propellers: 60, height_with_propellers: 70
  };
  const cabinetSource = 'reference_assets/README.md#кабинетный-эталон';
  const cabinetWidth45 = (cabinetDimensions.motor_transverse + cabinetDimensions.motor_longitudinal) / Math.SQRT2 +
    2 * cabinetDimensions.propeller_radius;

  function historicalCabinetPhoto({ view, label, number, crop, bounds, points, extent, segmentLabel, issue, horizontal = false }) {
    const [left, top, right, bottom] = crop;
    const divisor = 4;
    const toTrial = ([x, y]) => [(x - left) / divisor, (y - top) / divisor];
    const [from, to] = points.map(toTrial);
    // The ¾ denominator is horizontal. Retain the actual blade-tip coordinates for inspection.
    if (horizontal) from[1] = to[1] = (from[1] + to[1]) / 2;
    const base = 'reference_assets/cabinet/IMG_' + number;
    return {
      id: 'cabinet_' + view, view, label: 'Архив · ' + label,
      file: base + '_trial.jpg', source: base + '.jpg', width: (right - left) / divisor, height: (bottom - top) / divisor,
      bounds_px: [...toTrial(bounds.slice(0, 2)), ...toTrial(bounds.slice(2))],
      original_size_px: [4284, 5712], crop_px: crop, source_points_px: points,
      transparent: false, model_confirmed: true, object_complete: true, projection_confirmed: false, axis: null,
      review_segment: {
        from, to, label: segmentLabel, real_mm: extent, source: cabinetSource,
        status: horizontal ? 'preliminary' : 'measured'
      },
      issue
    };
  }

  const cabinetGeometryRevision = 'cabinet_motor_geometry_v2';

  function projectMotorSegment(physicalMm, direction, yawDeg, elevationDeg) {
    const [transverse, longitudinal] = direction;
    const yaw = yawDeg * Math.PI / 180;
    const elevation = elevationDeg * Math.PI / 180;
    const depthFraction = Math.cos(elevation) *
      (-transverse * Math.sin(yaw) + longitudinal * Math.cos(yaw)) / Math.hypot(transverse, longitudinal);
    return physicalMm * Math.sqrt(1 - depthFraction ** 2);
  }

  function modelledCabinetPhoto({ number, view, label, size, sha256, auditSha256 = sha256,
    crop, bounds, auditPoints, pair, yaw, elevation, diagonal }) {
    const [width, height] = size;
    const [left, top, right, bottom] = crop;
    const auditSize = [1536, 2048];
    const motorPoints = Object.fromEntries(auditPoints.map(([x, y], i) =>
      ['M' + (i + 1), [x * width / auditSize[0], y * height / auditSize[1]]]));
    const sourcePoints = pair.map(motor => motorPoints[motor]);
    const toCrop = ([x, y]) => [x - left, y - top];
    const [from, to] = sourcePoints.map(toCrop);
    const base = 'reference_assets/cabinet/IMG_' + number;
    const { motor_diagonal, motor_transverse, motor_longitudinal } = cabinetDimensions;
    const physicalMm = diagonal ? motor_diagonal : motor_transverse;
    const direction = [motor_transverse, diagonal ? motor_longitudinal : 0];
    // At 90° elevation the projection is independent of the unspecified yaw.
    const projectedMm = projectMotorSegment(physicalMm, direction, yaw ?? 0, elevation);
    return {
      id: 'cabinet_img_' + number + '_v2', view, label: label + ' · IMG_' + number,
      file: base + '_v2.png', source: base + '.jpg', width: right - left, height: bottom - top,
      bounds_px: [...toCrop(bounds.slice(0, 2)), ...toCrop(bounds.slice(2))],
      original_size_px: size, source_sha256: sha256, crop_px: crop, source_points_px: sourcePoints,
      source_motor_points_px: motorPoints,
      audit_image: { size_px: auditSize, sha256: auditSha256, motor_points_px: auditPoints },
      geometry_revision: cabinetGeometryRevision,
      operator_angles_deg: { yaw, elevation },
      transparent: false, model_confirmed: true, object_complete: true, projection_confirmed: false, axis: null,
      review_segment: {
        from, to, motor_pair: pair, label: 'Центры моторов ' + pair.join('–'),
        physical_mm: physicalMm, projected_mm: projectedMm, source: cabinetSource,
        status: 'modelled_approximate'
      },
      issue: 'Углы заданы по описанию оператора. Перспектива исходной съёмки не калибрована.' +
        (diagonal ? ' Измерена одна диагональ. Равенство второй принято по симметрии.' : '')
    };
  }

  profiles.unshift({
    id: 'cabinet_reference', model: 'Эталонный БПЛА из кабинета',
    dimensions_mm: [cabinetDimensions.span_transverse, cabinetDimensions.span_longitudinal, cabinetDimensions.height_with_propellers],
    measurements_mm: cabinetDimensions, source: cabinetSource,
    dimension_note: 'Поперечный × продольный размах × высота с винтами. Высота без винтов: 60 мм. ' +
      'Моторная база: 325 мм поперёк, 275 мм вдоль; измеренная диагональ: 428 мм.',
    photos: [
      modelledCabinetPhoto({
        number: 2751, view: 'front', label: 'Спереди', size: [1536, 2048],
        sha256: '1198e322712b1c7412ffe37bda751ebaddca638ee8513c319f963409816ef12e',
        crop: [250, 915, 1180, 1090], bounds: [270, 933, 1161, 1066],
        auditPoints: [[470, 994], [957, 997], [926, 999], [528, 994]],
        pair: ['M1', 'M2'], yaw: 0, elevation: 0, diagonal: false
      }),
      modelledCabinetPhoto({
        number: 2704, view: 'top', label: 'Сверху', size: [4284, 5712],
        sha256: 'ddcb633b2d56fab3224df9fa0d8491340114c9fda2d421a4fd2552bd9820bb54',
        auditSha256: '64d9b20530e69b9ce53976d3c4789a226011665e33b44ca51e21cf5cf30f85ce',
        crop: [278, 432, 4017, 3905], bounds: [359, 527, 3939, 3805],
        auditPoints: [[358, 1108], [1115, 1110], [1125, 484], [350, 475]],
        pair: ['M4', 'M2'], yaw: null, elevation: 90, diagonal: true
      }),
      modelledCabinetPhoto({
        number: 2755, view: 'oblique', label: 'Под углом · elevation ≈15°', size: [1536, 2048],
        sha256: 'b645e3b8cfd6e4dfc7333db0a603f1dbaca39d799cfc286c964ccc3274bdc4fd',
        crop: [418, 646, 1278, 896], bounds: [440, 672, 1256, 870],
        auditPoints: [[538, 747], [789, 796], [1096, 757], [811, 720]],
        pair: ['M1', 'M3'], yaw: 45, elevation: 15, diagonal: true
      }),
      modelledCabinetPhoto({
        number: 2711, view: 'oblique', label: 'Под углом · elevation ≈45°', size: [4284, 5712],
        sha256: '297df9773f0a04967b1ea6500a419d9425730ceffca9400d64431a123afe080f',
        auditSha256: '0771cf58b9edfad23fccd61b2a6e5fda86c51682540f7d349b74992c5c53b0fc',
        crop: [415, 1536, 4123, 4123], bounds: [513, 1626, 4047, 4028],
        auditPoints: [[400, 826], [755, 1184], [1189, 942], [785, 658]],
        pair: ['M1', 'M3'], yaw: 45, elevation: 45, diagonal: true
      }),
      historicalCabinetPhoto({
        view: 'front', label: 'Спереди', number: 2707,
        crop: [160, 1760, 4200, 2720], bounds: [223, 1810, 4150, 2675], points: [[981, 2307], [3229, 2339]],
        extent: cabinetDimensions.motor_transverse, segmentLabel: 'Оси двух ближних моторов',
        issue: 'Измерена поперечная база. Привязка по двум ближним осям; остаточная перспектива и небольшой наклон камеры не калиброваны.'
      }),
      historicalCabinetPhoto({
        view: 'oblique_candidate', label: 'Под углом ¾', number: 2711, horizontal: true,
        crop: [480, 1600, 4100, 4080], bounds: [520, 1630, 4040, 4040], points: [[525, 2240], [4031, 2758]],
        extent: cabinetWidth45, segmentLabel: 'Горизонталь между крайними видимыми кончиками лопастей',
        issue: 'Модель 45° даёт полный размах области вращения винтов. На снимке видны неподвижные лопасти; их горизонтальный размах используется как приближение. Угол и перспектива снимка не проверены.'
      }),
      historicalCabinetPhoto({
        view: 'top', label: 'Сверху', number: 2704,
        crop: [320, 480, 4000, 3840], bounds: [365, 530, 3930, 3810], points: [[976, 1325], [3107, 3096]],
        extent: cabinetDimensions.motor_diagonal, segmentLabel: 'Центры противоположных моторов по диагонали',
        issue: 'Измеренная диагональ рамы. Привязка по центрам ступиц; остаточная перспектива снимка не калибрована.'
      })
    ]
  });
  // Archive-grid stimuli have their own IDs. Model and motor labels come from the v2 reference.
  const grayBackground = 'neutral_gray_808080_v1';
  const forestBackground = 'forest_40_let_pobedy_full_v1';
  const pairedBackgrounds = {
    neutral: { background_hex: '#FFFFFF' },
    [grayBackground]: { background_hex: '#808080' },
    sky: { background_hex: null, background_asset: 'reference_assets/sky.svg' },
    [forestBackground]: { background_hex: null, background_asset: 'reference_assets/forest_40_let_pobedy_full_v1.jpg' }
  };
  const cabinetPairs = [
    { number: 2751, crop: [250, 915, 1180, 1090], bounds: [270, 933, 1161, 1066],
      original: ['IMG_2751_v2.png', '45d7ac5ba7c5922361e0d2b879a582845f78ebdbbe9d08f32c8b81887fd47d44'],
      clean: ['IMG_2751_clean_v4_crop.png', '89b042865c29f67dea726845e6bd95ba89cbd20251d11ce30156558db268e624', 'v4_front_manual'] },
    { number: 2704, crop: [100, 155, 1440, 1400], bounds: [129, 189, 1412, 1364],
      original: ['IMG_2704_archive_crop.png', 'ce1a94a8e54b7aff08ce4bae3aa346717513766054f3a9ea257336f596da2350'],
      clean: ['IMG_2704_clean_v4_crop.png', '3a15824c09621596e407195c9f8f89781c64ab9f6db9774fa8e089093aeae1f2', 'v4_top_local_manual_1'] },
    { number: 2755, crop: [418, 646, 1278, 896], bounds: [440, 672, 1256, 870],
      original: ['IMG_2755_v2.png', '442abcd66752da457093003c2a5147e0d8e51dfa644861905a29c4d1c65b4c78'],
      clean: ['IMG_2755_clean_v4_crop.png', '62c6c851c76be943cc5f811f21eb8e5b8868fb8e177e14ffb95468ebf737394d', 'v4_oblique_15_local_2'] },
    { number: 2711, crop: [149, 551, 1478, 1478], bounds: [184, 583, 1451, 1444],
      original: ['IMG_2711_archive_crop.png', '8d5a7a44f2b5632f073258adc0a8a777851771eabe0cb39e24e3350c6e5dece5'],
      clean: ['IMG_2711_clean_v4_crop.png', '88900142da4cef430194b1182c4ac5ab4b2c909df3b186c8fbe346f1fadd8749', 'v4_oblique_45_local_2'] }
  ];
  const cabinetPhotos = profiles[0].photos;
  for (const { number, crop, bounds, original, clean, pending } of cabinetPairs) {
    const p = cabinetPhotos.find(photo => photo.id === 'cabinet_img_' + number + '_v2');
    const [left, top, right, bottom] = crop;
    const toCrop = ([x, y]) => [x - left, y - top];
    const sourcePoints = p.review_segment.motor_pair.map(label => p.audit_image.motor_points_px[Number(label[1]) - 1]);
    const assetRoot = 'reference_assets/cabinet/';
    const id = 'cabinet_img_' + number + '_archive_v4';
    const makeAsset = (variant, [name, sha256, maskRevision = null]) => ({
      id: id + '_' + variant, file: assetRoot + name, sha256, maskRevision,
    });
    const variants = { original: makeAsset('original', original) };
    if (clean) variants.clean = makeAsset('clean', clean);
    const photo = {
      ...p, id, label: 'Серия «Фон» · ' + p.label, source_photo_id: 'IMG_' + number,
      file: variants.original.file,
      source: p.source_sha256 === p.audit_image.sha256 ? p.source : assetRoot + 'IMG_' + number + '_archive.jpg',
      source_sha256: p.audit_image.sha256, original_size_px: p.audit_image.size_px,
      width: right - left, height: bottom - top, crop_px: crop,
      bounds_px: [...toCrop(bounds.slice(0, 2)), ...toCrop(bounds.slice(2))],
      source_points_px: sourcePoints,
      source_motor_points_px: Object.fromEntries(p.audit_image.motor_points_px.map((point, i) => ['M' + (i + 1), point])),
      review_segment: { ...p.review_segment, from: toCrop(sourcePoints[0]), to: toCrop(sourcePoints[1]) },
      asset_revision: 'cabinet_archive_crop_v4', variants, pending
    };
    cabinetPhotos.push(photo);
  }
  const trialSequence = [
    ['original', 'neutral'], ['clean', 'neutral'], ['clean', forestBackground]
  ].flatMap(([variant, background]) => cabinetPhotos.filter(p => p.variants?.[variant])
    .map(photo => ({ photo, variant, background })));
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

  /** Use a documented cabinet segment or a legacy silhouette estimate. */
  function estimate(profile, render, distanceCm, mmPerCssPx, geometry) {
    const p = render?.photo_id ? profile?.photos?.find(p => p.id === render.photo_id) : profile?.photos?.[0];
    const empty = { display_width_cm: null, display_axis_cm: null, equivalent_distance_m: null,
      assumed_extent_mm: null, assumption: null };
    if (!p?.file || !render?.visible || render.width !== p.width || render.height !== p.height) return empty;
    const widthMm = geometry.physicalWidth(p.bounds_px, p.width, p.height, render.scale, mmPerCssPx);
    if (!positive(widthMm)) return empty;
    const segment = p.review_segment;
    const projectedMm = segment?.status === 'modelled_approximate' ? segment.projected_mm : segment?.real_mm;
    if (positive(projectedMm) && p.object_complete !== false) {
      const segmentMm = reviewSegmentLength(p, render, mmPerCssPx);
      return { ...empty, display_width_cm: widthMm / 10, display_axis_cm: segmentMm == null ? null : segmentMm / 10,
        assumed_extent_mm: projectedMm, geometry_status: segment.status, assumption: p.issue,
        equivalent_distance_m: geometry.equivalentDistance(projectedMm / 10, distanceCm, segmentMm) };
    }
    const d = profile.estimate_dimensions_mm;
    let extent, assumption;
    if (p.view === 'front' || p.view === 'top' || p.view === 'near_top') {
      extent = d?.width;
      assumption = p.view === 'front' ? 'Спереди: поперечный габарит W.' : 'Сверху: горизонталь силуэта принята за поперечную паспортную ось W.';
    } else if (p.view === 'side') {
      extent = d?.length; assumption = 'Сбоку: продольный габарит L.';
    } else if (p.view === 'oblique' || p.view === 'oblique_candidate') {
      extent = positive(d?.width) && positive(d?.length) ? (d.width + d.length) / Math.SQRT2 : null;
      assumption = '¾: условный угол 45°, W·cos(45°) + L·sin(45°).';
    }
    if (!positive(extent)) return { ...empty, display_width_cm: widthMm / 10 };
    if (p.object_complete === false) return { ...empty, display_width_cm: widthMm / 10,
      assumption: 'Исходник обрезан. Видимая часть не приравнивается полному габариту: дальность недоступна без физически обоснованного отрезка.' };
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
    let loaded = false, loadState = 'missing', loadGeneration = 0, targetError = '';
    let trialPhase = 'idle', settleFrame = null, settleStarted = 0, stableSince = 0, lastLayout = '', exitRequested = false;
    let background = saved?.background === 'sky' ? 'sky' : 'neutral';
    let pairedBackground = Object.hasOwn(pairedBackgrounds, saved?.paired_background) ? saved.paired_background : grayBackground;
    let camera = saved?.camera === '1' ? '1' : '5';
    let variant = saved?.variant === 'clean' ? 'clean' : 'original';
    let latestTrial = null, panelTimer;
    let trialStartScale = scale, trialScaleSteps = 0;
    let trialTargetRange = null, trialPhotoRequest = null;
    const trialScaleStep = 0.1;
    const savedPosition = saved?.paired_position_css_px;
    let pairedPosition = Array.isArray(savedPosition) && savedPosition.length === 2 && savedPosition.every(Number.isFinite)
      ? savedPosition : [0, 0];
    let mode = saved?.range_mode === 'strict' ? 'strict' : 'approximate';
    element.innerHTML = `
      <h3>Эксперимент с эталонными БПЛА</h3>
      <label>Коптер <select id="referenceDrone"></select></label>
      <label>Фотография <select id="referencePhotoSelect"></select></label>
      <label id="referenceVariantLabel" class="hidden">Вариант <select id="referenceVariant"><option value="original">Оригинал</option><option value="clean">Чистый фон</option></select></label>
      <p id="referenceVariantNote" class="hidden"></p>
      <label id="referenceRangeModeLabel">Расчёт <select id="referenceRangeMode"><option value="approximate">Приближённая оценка</option><option value="strict">Строгий: подтверждённая ось</option></select></label>
      <p><span id="referenceDimensions"></span> · <span id="referenceSpecSource"></span></p>
      <p id="referenceView"></p>
      <div id="referenceViewport"><img id="referenceDisplay" alt=""><svg id="referenceSegmentOverlay" aria-hidden="true" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none"></svg><p id="referenceMissing" class="hidden">Фотография недоступна.</p>
        <div id="referenceTrialScalePanel" role="group" aria-label="Управление показом" hidden>
          <div class="reference-trial-actions">
            <button type="button" id="referenceTrialSmaller" aria-label="Уменьшить масштаб">−</button>
            <output id="referenceTrialDistance" aria-label="Модельная дальность"></output>
            <button type="button" id="referenceTrialLarger" aria-label="Увеличить масштаб">+</button>
            <button type="button" id="referenceTrialSave">Сохранить</button>
            <button type="button" id="referenceTrialDone">Готово</button>
          </div>
          <div class="reference-trial-actions reference-trial-navigation">
            <button type="button" id="referenceTrialPrevious">Назад</button>
            <span id="referenceTrialSequence" aria-live="polite"></span>
            <button type="button" id="referenceTrialNext">Вперёд</button>
          </div>
          <span id="referenceTrialScaleStatus" role="status"></span>
        </div>
      </div>
      <p><label>Масштаб <input id="referenceScale" type="range" min="0.1" max="1000" step="0.1"></label>
      <label><input id="referenceScaleNumber" type="number" min="0.01" max="1000" step="any" aria-label="Масштаб фотографии, %"> %</label>
      <button id="referenceHalf">Уменьшить вдвое</button><button id="referenceDouble">Увеличить вдвое</button></p>
      <p><label>Желаемая эквивалентная дальность, м <input id="referenceTarget" type="text" inputmode="decimal" placeholder="100,00"></label><button id="referenceApplyTarget">Рассчитать масштаб</button><span id="referenceTargetStatus" role="status"></span></p>
      <p><label>Камера Xiaomi 17 Pro <select id="referenceCamera"><option value="5">Физическая телекамера 5× — план опыта</option><option value="1">1× — сравнение</option></select></label></p>
      <p>1×/5× — обозначение условий опыта. Дальность не умножается на 5; камера меняет размер объекта в кадре YOLO. Использование физического телевика проверяется на телефоне.</p>
      <p><label>Фон <select id="referenceBackground"><option value="neutral">Белый</option><option value="neutral_gray_808080_v1" hidden>Серый</option><option value="sky">Небо</option><option value="${forestBackground}" hidden>Лес — ул. 40 лет Победы</option></select></label><button id="referenceTrial">Режим испытания</button></p>
      <p id="referencePositionControls" class="hidden">В полноэкранном режиме перемещайте коптер стрелками. Shift ускоряет перемещение, Home возвращает в центр.
        <button type="button" id="referenceCenter">Вернуть в центр</button>
      </p>
      <p id="referenceTrialScaleHelp" class="hidden">В полноэкранном показе + и − меняют масштаб на ${trialScaleStep.toLocaleString('ru-RU')} процентного пункта. Щелчок открывает управление. Нажмите «Сохранить», когда YOLO увидит коптер.</p>
      <p id="referenceBackgroundNote"></p>
      <p id="referenceForestCredit" class="hidden">Фото
        <a href="https://commons.wikimedia.org/wiki/File:40_лет_Победы.jpg" target="_blank" rel="noopener">Yan.gorev</a> ·
        <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC BY-SA 3.0</a> ·
        полный кадр, 4000 × 3000 px.
      </p>
      <p id="referencePilotRun" class="hidden"><a id="referencePilotLink" target="_blank" rel="noopener">Открыть пилот с сохранёнными условиями</a> <span id="referencePilotLabel"></span></p>
      <p id="referenceReadout" aria-live="polite"></p>
      <p id="referenceTrialSummary" role="status" hidden></p>
      <details id="referenceSavedTrials" hidden>
        <summary>Сохранённые замеры</summary>
        <ul></ul>
      </details>
      <details id="referenceSegmentReview" class="hidden"><summary id="referenceSegmentTitle">Разметка A–B</summary><label><input id="referenceSegmentToggle" type="checkbox"> Показать отрезок A–B</label><p id="referenceSegmentReadout"></p></details><p id="referenceAssumption" class="warn"></p><p id="referenceIssue" class="warn"></p>
      <p class="muted">Лабораторная эквивалентная дальность по угловому размеру. Не измерение дальности обнаружения в полёте.</p>
      <details id="referenceGeometryDetails"><summary>Дополнительно: источник фотографии и геометрия</summary>
        <p>100 % = один пиксель показываемого файла на один CSS px. Белые поля не входят в измерение объекта. Предпросмотр может обрезать изображение, не меняя расчёт. Полноэкранный режим отдельно проверяет, помещается ли объект на экране. Обрезанный силуэт не приравнивается полному габариту. Для него нужен отдельный достоверный отрезок.</p>
        <p id="referenceDimensionNote"></p><p id="referenceDiagnostics"></p><p id="referencePhotoSource"></p>
        <p>Разрешение авторов на использование и публикацию фотографий подтверждено пользователем 2026-11-06. Это не подтверждение проекции.</p>
      </details>`;
    const $ = id => element.querySelector('#' + id);
    const select = $('referenceDrone'), photoSelect = $('referencePhotoSelect'), viewport = $('referenceViewport');
    let image = $('referenceDisplay');
    const scalePanel = $('referenceTrialScalePanel');
    const scaleStatus = $('referenceTrialScaleStatus');
    const trialSummary = $('referenceTrialSummary');
    const savedTrials = $('referenceSavedTrials');
    const decodedImages = new Map();
    // Older saved cabinet settings without a photo ID selected IMG_2707.
    const savedPhotoId = saved?.photo_id ?? (saved?.model_id === 'cabinet_reference' ? 'cabinet_front' : null);
    let photo = selected.photos.find(p => p.id === savedPhotoId) || selected.photos[0];
    for (const p of profiles) select.add(new Option(p.model, p.id));
    function persist() { save('reference_tab', { model_id: selected.id, photo_id: photo.id, view: photo.view, scale_percent: scale, range_mode: mode, background, paired_background: pairedBackground, paired_position_css_px: pairedPosition, camera, ...(photo.variants ? { variant } : {}) }); }
    function link(node, url, label) { const a = document.createElement('a'); a.href = url; a.textContent = label; a.target = '_blank'; a.rel = 'noopener noreferrer'; node.replaceChildren(a); }
    const readable = n => n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
    const variantLabel = variant => variant === 'clean' ? 'Чистый фон' : 'Оригинал';
    const backgrounds = Array.from($('referenceBackground').options);
    const backgroundLabel = id => backgrounds.find(option => option.value === id)?.textContent ?? id;
    const trialsKey = 'reference_saved_trials';
    function getSavedTrials() {
      const records = load(trialsKey, []);
      return Array.isArray(records) ? records : [];
    }
    function pilotUrl(conditions) {
      const url = new URL('yolo-pilot/index.html', document.baseURI);
      url.hash = new URLSearchParams({ stimulus: JSON.stringify(conditions) }).toString();
      return url.href;
    }
    function renderSavedTrials(records) {
      savedTrials.hidden = !records.length;
      savedTrials.querySelector('summary').textContent = `Сохранённые замеры (${records.length})`;
      const entries = records.map(({ saved_at, conditions }) => {
        const time = new Date(saved_at).toLocaleString('ru-RU');
        const item = document.createElement('li');
        link(item, pilotUrl(conditions), `${time} · ${conditions.source_photo_id} · ${variantLabel(conditions.stimulus_variant)} · ${backgroundLabel(conditions.background)} · ≈ ${readable(conditions.equivalent_range_m)} м · A–B ${readable(conditions.review_segment_display_mm)} мм`);
        return item;
      });
      savedTrials.querySelector('ul').replaceChildren(...entries);
    }
    function describePhoto(p) {
      const propellers = selected.measurements_mm
        ? `радиус пропеллера ${selected.measurements_mm.propeller_radius} мм`
        : `пропеллеры ${selected.propeller_in}″`;
      $('referenceDimensions').textContent = `${selected.dimensions_mm.join(' × ')} мм; ${propellers}`;
      $('referenceDimensionNote').textContent = selected.dimension_note;
      link($('referenceSpecSource'), selected.source, 'Источник характеристик');
      link($('referencePhotoSource'), p.source, p.original_size_px ? 'Полный кадр' : 'Страница источника фотографии');
      $('referenceView').textContent = p.label;
    }
    function displayPhoto(next, p, url) {
      next.id = 'referenceDisplay';
      next.alt = selected.model + ' — ' + p.label;
      decodedImages.set(url, next);
      if (image !== next) image.replaceWith(next);
      image = next;
    }
    function choosePhoto() {
      photo = selected.photos.find(p => p.id === photoSelect.value) || selected.photos[0];
      const p = photo, generation = ++loadGeneration;
      if (!p.variants?.[variant]) variant = 'original';
      const file = p.variants?.[variant].file ?? p.file;
      loaded = false; loadState = file ? 'loading' : 'missing'; targetError = '';
      describePhoto(p);
      // Decode a separate request-owned image. Old events can never publish into the new selection.
      const expected = file && new URL(file, document.baseURI).href;
      const cached = decodedImages.get(expected);
      const next = cached || new Image();
      next.onload = () => {
        if (generation !== loadGeneration || next.currentSrc !== expected) return;
        loaded = next.naturalWidth === p.width && next.naturalHeight === p.height;
        loadState = loaded ? 'ready' : 'error';
        if (loaded) displayPhoto(next, p, expected);
        update();
      };
      next.onerror = () => { if (generation === loadGeneration) { loaded = false; loadState = 'error'; update(); } };
      if (cached) next.onload();
      else if (file) next.src = file;
      else {
        const empty = document.createElement('img'); empty.id = 'referenceDisplay'; empty.alt = '';
        image.replaceWith(empty); image = empty;
      }
      persist(); update();
    }
    function chooseModel(preferredPhoto = null) {
      selected = profiles.find(p => p.id === select.value) || profiles[0];
      photoSelect.replaceChildren();
      const paired = document.createElement('optgroup');
      paired.label = 'Сравнение фона';
      for (const p of selected.photos) {
        const option = new Option(p.label, p.id);
        if (p.variants) paired.append(option);
        else photoSelect.add(option);
      }
      if (paired.childElementCount) photoSelect.prepend(paired);
      photoSelect.value = selected.photos.some(p => p.id === preferredPhoto) ? preferredPhoto : selected.photos[0].id;
      choosePhoto();
    }
    function rangeMode() { return selected.measurements_mm ? 'approximate' : mode; }
    function placementBounds(p, imageScale, width, height) {
      const [left, top, right, bottom] = p.bounds_px;
      return {
        minX: (p.width / 2 - left) * imageScale - width / 2,
        minY: (p.height / 2 - top) * imageScale - height / 2,
        maxX: (p.width / 2 - right) * imageScale + width / 2,
        maxY: (p.height / 2 - bottom) * imageScale + height / 2,
      };
    }
    function fitsPlacement(p, imageScale, width, height, x, y) {
      if (!positive(imageScale) || !p.bounds_px) return false;
      const { minX, minY, maxX, maxY } = placementBounds(p, imageScale, width, height);
      return x >= minX - 0.1 && x <= maxX + 0.1 && y >= minY - 0.1 && y <= maxY + 0.1;
    }
    function update() {
      const p = photo, cal = getCalibration();
      const activeMode = rangeMode();
      $('referenceRangeModeLabel').classList.toggle('hidden', !!selected.measurements_mm);
      $('referenceRangeMode').value = activeMode;
      $('referenceTrial').disabled = trialPhase !== 'idle';
      const paired = !!p.variants;
      const trial = document.fullscreenElement === viewport;
      const [offsetX, offsetY] = paired ? pairedPosition : [0, 0];
      $('referencePositionControls').classList.toggle('hidden', !paired);
      $('referenceTrialScaleHelp').classList.toggle('hidden', !paired);
      trialSummary.hidden = trialPhase !== 'idle' || !latestTrial;
      $('referenceCenter').disabled = trialPhase !== 'idle' || (offsetX === 0 && offsetY === 0);
      const visibleAsset = loaded ? p.variants?.[variant] : null;
      $('referenceVariantLabel').classList.toggle('hidden', !paired);
      $('referenceVariant').value = variant;
      $('referenceVariant').options[1].disabled = !p.variants?.clean;
      $('referenceVariantNote').classList.toggle('hidden', !p.pending);
      $('referenceVariantNote').textContent = p.pending ? 'Чистый фон недоступен. ' + p.pending : '';
      const displayedBackground = paired ? pairedBackground : background;
      $('referenceBackground').querySelector(`option[value="${grayBackground}"]`).hidden = !paired;
      $('referenceBackground').querySelector(`option[value="${forestBackground}"]`).hidden = !paired;
      $('referenceBackground').value = displayedBackground;
      $('referenceBackground').disabled = paired && trialPhase !== 'idle';
      $('referenceCamera').value = camera;
      viewport.classList.toggle('reference-gray', displayedBackground === grayBackground);
      viewport.classList.toggle('reference-sky', displayedBackground === 'sky');
      viewport.classList.toggle('reference-forest', displayedBackground === forestBackground);
      $('referenceForestCredit').classList.toggle('hidden', displayedBackground !== forestBackground);
      $('referenceBackgroundNote').textContent = paired ? (variant === 'original'
        ? 'Оригинал сохраняет фон фотографии. Выбранная подложка видна только за её краями.'
        : 'Выбранная подложка видна в прозрачных областях и вокруг изображения.') : background === 'sky' && !p.transparent ? 'Локальный рисунок неба. Исходное фото непрозрачное: его собственный фон остаётся прямоугольником; корректное наложение дрона на небо не имитируется.' : background === 'sky' ? 'Локальный рисунок неба; используется прозрачный исходник.' : 'Нейтральный однотонный фон. Собственный фон фотографии сохраняется.';
      $('referenceScale').value = scale;
      if (document.activeElement !== $('referenceScaleNumber')) $('referenceScaleNumber').value = scale;
      image.style.width = p.width * scale / 100 + 'px';
      image.style.left = trial && offsetX ? `calc(50% + ${offsetX}px)` : '';
      image.style.top = trial && offsetY ? `calc(50% + ${offsetY}px)` : '';
      image.classList.toggle('hidden', !loaded);
      $('referenceMissing').classList.toggle('hidden', loaded);
      $('referenceMissing').textContent = loadState === 'loading' ? 'Загрузка выбранной фотографии…' : loadState === 'error' ? 'Ошибка загрузки или неверные размеры фотографии.' : 'Фотография недоступна.';
      const r = image.getBoundingClientRect(), v = viewport.getBoundingClientRect(), b = p.bounds_px;
      const panel = trial ? viewport : element.closest('.panel'), clip = panel.getBoundingClientRect();
      const left = Math.max(v.left, 0, clip.left + panel.clientLeft), top = Math.max(v.top, 0, clip.top + panel.clientTop);
      const right = Math.min(v.right, innerWidth, clip.left + panel.clientLeft + panel.clientWidth);
      const bottom = Math.min(v.bottom, innerHeight, clip.top + panel.clientTop + panel.clientHeight);
      const actualScale = loaded && p.width ? r.width / p.width : null;
      const previewVisible = loaded && !!b && r.left + b[0] * actualScale >= left - 0.1 && r.top + b[1] * actualScale >= top - 0.1 &&
        r.left + b[2] * actualScale <= right + 0.1 && r.top + b[3] * actualScale <= bottom + 0.1;
      const m = (activeMode === 'strict' ? measure : estimate)(selected, { photo_id: p.id, width: image.naturalWidth, height: image.naturalHeight, scale: actualScale, visible: loaded },
        getDistance(), cal?.mm_per_css_px, geometry);
      const capacityWidth = trial ? Math.min(v.width, innerWidth) : screen.width;
      const capacityHeight = trial ? Math.min(v.height, innerHeight) : screen.height;
      const fullscreenFits = loaded && fitsPlacement(p, actualScale, capacityWidth, capacityHeight, offsetX, offsetY);
      const fmt = n => n == null ? 'нет данных' : n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
      const candidate = p.review_segment, overlay = $('referenceSegmentOverlay');
      const segmentMm = reviewSegmentLength(p, { width: image.naturalWidth, height: image.naturalHeight, scale: actualScale, visible: loaded }, cal?.mm_per_css_px);
      $('referenceSegmentReview').classList.toggle('hidden', !candidate);
      overlay.replaceChildren();
      overlay.classList.toggle('hidden', !candidate || !loaded || !$('referenceSegmentToggle').checked);
      if (candidate) {
        $('referenceSegmentTitle').textContent = candidate.status === 'unconfirmed' ? 'Проверяемая моторная диагональ — не подтверждена' : 'Разметка расчётного отрезка A–B';
        overlay.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
        overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
        const svg = (tag, attrs) => {
          const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
          for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
          overlay.append(node); return node;
        };
        svg('line', { x1: candidate.from[0], y1: candidate.from[1], x2: candidate.to[0], y2: candidate.to[1],
          stroke: '#b00060', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' });
        const markerScale = p.original_size_px && positive(actualScale) ? 1 / actualScale : 1;
        for (const [i, point] of [candidate.from, candidate.to].entries()) {
          svg('circle', { cx: point[0], cy: point[1], r: 3 * markerScale, fill: '#fff', stroke: '#b00060', 'vector-effect': 'non-scaling-stroke' });
          svg('text', { x: point[0] + 6 * markerScale, y: point[1] - 6 * markerScale, fill: '#b00060', 'font-size': 14 * markerScale }).textContent = i ? 'B' : 'A';
        }
        const [a, b] = p.source_points_px || [candidate.from, candidate.to];
        const [sourceWidth, sourceHeight] = p.original_size_px || [p.width, p.height];
        const pointLabel = candidate.status === 'preliminary' ? 'Кончики лопастей' : 'Точки A и B';
        $('referenceSegmentReadout').textContent = `${candidate.label}. ${pointLabel}: (${a.join(', ')}) и (${b.join(', ')}) px исходного кадра ${sourceWidth}×${sourceHeight}. ` +
          `Длина A–B на экране: ${fmt(segmentMm == null ? null : segmentMm / 10)} см. ${candidate.issue || ''} ` +
          'Для ручной проверки включите A–B и измерьте линейкой расстояние между центрами меток. Программное значение не заменяет физический замер линейкой.';
      }

      if (trial && trialPhase === 'active' && (m.equivalent_distance_m == null || !fullscreenFits)) {
        stopTrial(m.equivalent_distance_m == null ? 'Испытание остановлено: нужна повторная калибровка или проверка исходных данных. Сохранённые измерения не удалены.' : 'Испытание остановлено: объект обрезан фактической полноэкранной областью. Уменьшите масштаб.');
      }
      const range = loadState === 'loading' ? 'Загрузка выбранной фотографии…' : m.equivalent_distance_m == null ? 'нет данных' :
        `${activeMode === 'approximate' ? '≈ ' : ''}${m.equivalent_distance_m.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} м`;
      $('referenceAssumption').textContent = candidate?.status === 'modelled_approximate' ?
        `Модельная оценка по ${candidate.label.toLowerCase()}. Физическая длина ${fmt(candidate.physical_mm)} мм, расчётная проекция ${fmt(candidate.projected_mm)} мм.` :
        candidate?.status === 'measured' ?
        `Измеренный отрезок: ${candidate.label}, ${fmt(candidate.real_mm)} мм. Дальность по проекции фотографии.` :
        candidate?.status === 'preliminary' ?
        `Предварительная оценка по модели вращения винтов при 45°: ${candidate.real_mm.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} мм.` :
        activeMode === 'approximate' ?
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
        trial_phase: trialPhase, load_state: loadState, preview_visible: previewVisible, fullscreen_fits: fullscreenFits,
        image_width_css_px: loaded ? r.width : null, image_height_css_px: loaded ? r.height : null, review_segment_display_mm: segmentMm,
        ...(p.geometry_revision ? { geometry_revision: p.geometry_revision, projection_confirmed: p.projection_confirmed,
          physical_segment_mm: candidate.physical_mm, projected_segment_mm: candidate.projected_mm } : {}),
        ...(paired ? { source_photo_id: p.source_photo_id, source_sha256: p.source_sha256,
          asset_revision: p.asset_revision, stimulus_variant: visibleAsset ? variant : null,
          asset_id: visibleAsset?.id ?? null, asset_sha256: visibleAsset?.sha256 ?? null,
          mask_revision: visibleAsset?.maskRevision ?? null, source_size_px: p.original_size_px, crop_ltrb_px: p.crop_px,
          segment_a_source_px: p.source_points_px[0], segment_b_source_px: p.source_points_px[1],
          css_px_per_asset_px: actualScale, mm_per_css_px: cal?.mm_per_css_px ?? null,
          position_offset_x_css_px: offsetX, position_offset_y_css_px: offsetY,
          ...pairedBackgrounds[displayedBackground] } : {}),
        camera_label: camera + '×', background: displayedBackground, range_mode: activeMode, geometry_status: m.geometry_status ?? null, assumed_extent_mm: m.assumed_extent_mm ?? null, assumption: m.assumption ?? null,
        display_width_cm: m.display_width_cm, display_axis_cm: m.display_axis_cm, equivalent_distance_m: m.equivalent_distance_m, calibration_id: cal?.id ?? null };
    }
    function setScale(value) {
      const n = Number(value);
      if (!positive(n) || n < 0.01 || n > 1000) { $('referenceScaleNumber').setCustomValidity('Введите масштаб от 0,01 до 1000 %.'); update(); return; }
      $('referenceScaleNumber').setCustomValidity(''); scale = n; persist(); return update();
    }
    $('referenceSegmentToggle').onchange = update;
    $('referenceRangeMode').onchange = e => { mode = e.target.value === 'strict' ? 'strict' : 'approximate'; persist(); update(); };
    select.onchange = () => chooseModel();
    photoSelect.onchange = choosePhoto;
    $('referenceVariant').onchange = e => {
      if (!photo.variants?.[e.target.value]) { update(); return; }
      variant = e.target.value;
      choosePhoto();
    };
    $('referenceScale').oninput = e => setScale(e.target.value);
    $('referenceScaleNumber').oninput = e => setScale(e.target.value);
    $('referenceHalf').onclick = () => setScale(Math.max(0.01, scale / 2));
    $('referenceDouble').onclick = () => setScale(Math.min(1000, scale * 2));
    // OS work area and window coordinates change in macOS fullscreen; they are not pixel-scale invariants.
    const physicalKeys = ['dpr', 'width', 'height', 'visual_scale'];
    function calibrationEnvironmentMatches(before, after, referenceActive = false) {
      const controlled = trialPhase !== 'idle' || document.fullscreenElement === viewport;
      if (!controlled && !referenceActive) return false;
      if (!before || !after || !physicalKeys.every(k => before[k] === after[k])) return false;
      return controlled || ['available_width', 'available_height', 'x', 'y'].every(k => before[k] === after[k]);
    }
    function layoutKey() {
      const r = viewport.getBoundingClientRect(), i = image.getBoundingClientRect();
      return JSON.stringify([document.fullscreenElement === viewport, innerWidth, innerHeight,
        r.x, r.y, r.width, r.height, i.width, i.height, window.screenX, window.screenY,
        screen.availWidth, screen.availHeight, devicePixelRatio, screen.width, screen.height, window.visualViewport?.scale ?? 1]);
    }
    function showScalePanel(visible) {
      clearTimeout(panelTimer);
      scalePanel.hidden = !visible;
      viewport.classList.toggle('reference-controls-open', visible);
      if (visible) panelTimer = setTimeout(() => showScalePanel(false), 2000);
      else scaleStatus.textContent = '';
    }
    function beginSettling(phase) {
      trialPhotoRequest = null;
      showScalePanel(false);
      trialPhase = phase; settleStarted = stableSince = performance.now(); lastLayout = '';
      if (settleFrame != null) cancelAnimationFrame(settleFrame);
      settleFrame = requestAnimationFrame(settleTrial);
    }
    function capturePilotConditions(state) {
      if (!state.asset_id || !state.fullscreen_fits || !positive(state.equivalent_distance_m)) return;
      updateTrialNavigation();
      trialSummary.textContent = `Итог показа · ≈ ${readable(state.equivalent_distance_m)} м · масштаб ${readable(state.scale_percent)} % · A–B ${readable(state.review_segment_display_mm)} мм`;
      $('referenceTrialDistance').textContent = `≈ ${state.equivalent_distance_m.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м`;
      const { photo_id, source_photo_id, source_sha256, asset_id, asset_sha256, asset_revision, stimulus_variant,
        mask_revision, geometry_revision, geometry_status, projection_confirmed, source_size_px, crop_ltrb_px,
        segment_a_source_px, segment_b_source_px, physical_segment_mm, projected_segment_mm,
        review_segment_display_mm, scale_percent, css_px_per_asset_px, calibration_id, mm_per_css_px,
        position_offset_x_css_px, position_offset_y_css_px, background, background_hex, background_asset } = state;
      const conditions = { reference: source_photo_id, view: state.view, equivalent_range_m: state.equivalent_distance_m,
        monitor_distance_cm: state.screen_distance_cm, camera: state.camera_label, photo_id, source_photo_id,
        source_sha256, asset_id, asset_sha256, asset_revision, stimulus_variant, mask_revision, geometry_revision,
        geometry_status, projection_confirmed, source_size_px, crop_ltrb_px, segment_a_source_px, segment_b_source_px,
        physical_segment_mm, projected_segment_mm, review_segment_display_mm, scale_percent, css_px_per_asset_px,
        calibration_id, mm_per_css_px, position_offset_x_css_px, position_offset_y_css_px, background, background_hex, background_asset };
      latestTrial = conditions;
      $('referencePilotLink').href = pilotUrl(conditions);
      $('referencePilotLabel').textContent = `· ${source_photo_id} · ${variantLabel(stimulus_variant)}`;
      $('referencePilotRun').classList.remove('hidden');
      return conditions;
    }
    function settleTrial(now) {
      settleFrame = null;
      if (trialPhase === 'idle') return;
      const inTrial = document.fullscreenElement === viewport;
      const key = layoutKey();
      if (key !== lastLayout) { lastLayout = key; stableSince = now; }
      // Do not validate the old/zero/transitional viewport on fullscreenchange or the request promise.
      if (now - stableSince >= 200 && now - settleStarted >= (trialPhase === 'exiting' ? 750 : 400)) {
        if (trialPhase === 'entering' && inTrial) {
          trialPhase = 'active'; exitRequested = false;
          capturePilotConditions(update());
          return;
        }
        if (trialPhase === 'exiting' && !inTrial) {
          // Refresh the calibration's environment while the controlled-transition exemption still applies.
          update(); trialPhase = 'idle'; exitRequested = false; update(); return;
        }
      }
      if (now - settleStarted > 5000) {
        if (inTrial && trialPhase === 'exiting') requireManualExit();
        else if (inTrial) stopTrial('Не удалось завершить переход в полноэкранный режим. Сохранённые измерения не удалены.');
        else { update(); trialPhase = 'idle'; exitRequested = false; update(); }
        return;
      }
      settleFrame = requestAnimationFrame(settleTrial);
    }
    function requireManualExit() {
      targetError = 'Браузер не завершил полноэкранный режим. Выйдите через Esc или меню браузера; измерения сохранены.';
      if (settleFrame != null) cancelAnimationFrame(settleFrame);
      settleFrame = null; trialPhase = 'manual-exit'; exitRequested = false; update();
    }
    function stopTrial(message) {
      if (message) {
        targetError = message;
        latestTrial = null;
      }
      if (exitRequested) return;
      exitRequested = true; beginSettling('exiting');
      if (document.fullscreenElement === viewport) {
        Promise.resolve(document.exitFullscreen()).catch(() => {
          requireManualExit();
        });
      }
    }
    function environmentChanged() {
      if (document.fullscreenElement === viewport && trialPhase === 'active') beginSettling('entering');
      // During entry/exit the sampler itself detects changes until the layout is stable.
    }
    $('referenceCamera').onchange = e => { camera = e.target.value; persist(); update(); };
    $('referenceBackground').onchange = e => {
      const value = e.target.value;
      if (photo.variants) {
        if (trialPhase === 'idle' && Object.hasOwn(pairedBackgrounds, value)) pairedBackground = value;
      } else if (value === 'neutral' || value === 'sky') background = value;
      persist();
      update();
    };
    function scaleForDistance(p, target, mmPerCssPx) {
      // Probe at unit scale so both controls can use the existing model for the requested photo.
      const unit = (rangeMode() === 'strict' ? measure : estimate)(selected,
        { photo_id: p.id, width: p.width, height: p.height, scale: 1, visible: true },
        getDistance(), mmPerCssPx, geometry);
      return unit.equivalent_distance_m / target * 100;
    }
    $('referenceApplyTarget').onclick = () => {
      targetError = '';
      const target = Number($('referenceTarget').value.trim().replace(',', '.'));
      viewport.scrollIntoView({ block: 'center' });
      const cal = getCalibration();
      if (!positive(target)) targetError = 'Введите положительную дальность в метрах, например 100,00.';
      else if (!cal) targetError = 'Нужна актуальная калибровка экрана.';
      else if (!loaded || !positive(getDistance())) targetError = 'Нужны загруженное изображение и расстояние до монитора.';
      else {
        const needed = scaleForDistance(photo, target, cal.mm_per_css_px);
        if (!positive(needed)) targetError = 'У этого ракурса нет расчётного отрезка для выбранного режима.';
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
      if (trialPhase !== 'idle') return;
      targetError = '';
      viewport.scrollIntoView({ block: 'center' });
      const state = update();
      if (!positive(state.equivalent_distance_m)) { targetError = 'Сначала получите корректную геометрию изображения: проверьте калибровку, ракурс, расстояние и исходные данные.'; update(); return; }
      if (!state.fullscreen_fits) { targetError = 'Объект не помещается на экране в полноэкранном режиме. Уменьшите масштаб.'; update(); return; }
      if (!viewport.requestFullscreen) { targetError = 'Браузер не поддерживает полноэкранный режим. Измерения сохранены.'; update(); return; }
      latestTrial = null;
      trialTargetRange = null;
      trialStartScale = scale;
      trialScaleSteps = 0;
      // The exemption starts before requestFullscreen: resize may precede fullscreenchange/promise resolution.
      beginSettling('entering');
      try { await viewport.requestFullscreen(); }
      catch {
        if (trialPhase !== 'exiting') beginSettling('exiting');
        targetError = 'Браузер не разрешил полноэкранный режим. Проверьте разрешения и активность окна, затем повторите. Измерения сохранены.';
        update();
      }
    };
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === viewport) { beginSettling('entering'); update(); }
      else if (trialPhase !== 'idle') { beginSettling('exiting'); update(); }
    });
    viewport.addEventListener('fullscreenerror', () => {
      if (trialPhase === 'idle') return;
      targetError = 'Браузер не разрешил полноэкранный режим. Проверьте разрешения и активность окна, затем повторите. Измерения сохранены.';
      beginSettling('exiting'); update();
    });
    $('referenceCenter').onclick = () => {
      pairedPosition = [0, 0];
      persist();
      update();
    };
    function repositionTrial(x, y) {
      const state = update();
      if (!state.fullscreen_fits) return;
      const size = viewport.getBoundingClientRect();
      const { minX, minY, maxX, maxY } = placementBounds(photo, state.css_px_per_asset_px,
        Math.min(size.width, innerWidth), Math.min(size.height, innerHeight));
      const clampedX = Math.min(maxX, Math.max(minX, x));
      const clampedY = Math.min(maxY, Math.max(minY, y));
      if (clampedX === pairedPosition[0] && clampedY === pairedPosition[1]) return;
      pairedPosition = [clampedX, clampedY];
      persist();
      // The new link describes this placement. Previously opened links retain their original conditions.
      capturePilotConditions(update());
    }
    function stepTrialScale(direction) {
      if (trialPhase !== 'active' || document.fullscreenElement !== viewport || !photo.variants) return;
      const nextStep = trialScaleSteps + direction;
      const requestedScale = trialStartScale + nextStep * trialScaleStep;
      const nextScale = Math.min(1000, Math.max(0.01, requestedScale));
      if (Math.abs(nextScale - requestedScale) > 1e-10) {
        scaleStatus.textContent = 'Достигнут предел масштаба.';
        showScalePanel(true);
        return;
      }
      if (!fitsTrialScale(photo, nextScale)) {
        scaleStatus.textContent = 'В этой позиции коптер не помещается. Масштаб сохранён.';
        showScalePanel(true);
        return;
      }
      scaleStatus.textContent = '';
      if (!scalePanel.hidden) showScalePanel(true);
      trialScaleSteps = nextStep;
      trialTargetRange = null;
      capturePilotConditions(setScale(nextScale));
    }
    function fitsTrialScale(p, nextScale) {
      // Probe the CSS width before publishing a new frame or triggering the clipping guard.
      const previousWidth = image.style.width;
      image.style.width = p.width * nextScale / 100 + 'px';
      const imageScale = image.getBoundingClientRect().width / p.width;
      image.style.width = previousWidth;
      const area = viewport.getBoundingClientRect();
      return fitsPlacement(p, imageScale, Math.min(area.width, innerWidth),
        Math.min(area.height, innerHeight), ...pairedPosition);
    }
    function trialSequenceIndex() {
      return trialSequence.findIndex(entry => entry.photo === photo &&
        entry.variant === variant && entry.background === pairedBackground);
    }
    function updateTrialNavigation() {
      const index = trialSequenceIndex();
      const waiting = !!trialPhotoRequest;
      $('referenceTrialPrevious').disabled = waiting || index <= 0;
      $('referenceTrialNext').disabled = waiting || index >= trialSequence.length - 1;
      for (const id of ['referenceTrialSmaller', 'referenceTrialLarger', 'referenceTrialSave']) $(id).disabled = waiting;
      $('referenceTrialSequence').textContent = index < 0 ? 'Начало серии по кнопке «Вперёд»'
        : `${index + 1}/${trialSequence.length} · ${photo.source_photo_id} · ${variantLabel(variant)} · ${backgroundLabel(pairedBackground)}`;
    }
    async function decodeTrialImage(url, p) {
      const cached = decodedImages.get(url);
      if (cached) return cached;
      const next = new Image();
      next.src = url;
      await next.decode();
      if (p && (next.naturalWidth !== p.width || next.naturalHeight !== p.height)) throw new Error('Unexpected image dimensions');
      decodedImages.set(url, next);
      return next;
    }
    async function stepTrialPhoto(direction) {
      if (trialPhase !== 'active' || document.fullscreenElement !== viewport || !photo.variants || trialPhotoRequest) return;
      const entry = trialSequence[trialSequenceIndex() + direction];
      if (!entry) return;
      const request = {};
      trialPhotoRequest = request;
      updateTrialNavigation();
      scaleStatus.textContent = 'Загрузка фотографии…';
      showScalePanel(true);
      const p = entry.photo;
      const url = new URL(p.variants[entry.variant].file, document.baseURI).href;
      let next;
      let error = '';
      try {
        [next] = await Promise.all([decodeTrialImage(url, p), entry.background === forestBackground
          ? decodeTrialImage(new URL(pairedBackgrounds[forestBackground].background_asset, document.baseURI).href) : null]);
      } catch {
        error = 'Не удалось загрузить фотографию или фон.';
      }
      if (trialPhotoRequest !== request || document.fullscreenElement !== viewport) return;
      trialPhotoRequest = null;
      const state = update();
      if (trialPhase !== 'active') return;
      const target = trialTargetRange ?? state.equivalent_distance_m;
      const nextScale = scaleForDistance(p, target, state.mm_per_css_px);
      if (!error && (!positive(nextScale) || nextScale < 0.01 || nextScale > 1000)) error = 'Дальность недоступна для этого ракурса.';
      if (!error && !fitsTrialScale(p, nextScale)) error = 'Кадр не помещается при текущей дальности и позиции.';
      if (error) {
        updateTrialNavigation();
        scaleStatus.textContent = error;
        showScalePanel(true);
        return;
      }
      trialTargetRange = target;
      trialStartScale = nextScale;
      trialScaleSteps = 0;
      ++loadGeneration;
      photo = p;
      photoSelect.value = p.id;
      variant = entry.variant;
      pairedBackground = entry.background;
      displayPhoto(next, p, url);
      describePhoto(p);
      scaleStatus.textContent = '';
      if (!scalePanel.hidden) showScalePanel(true);
      capturePilotConditions(setScale(nextScale));
    }
    viewport.addEventListener('click', e => {
      if (trialPhase === 'active' && document.fullscreenElement === viewport && photo.variants && !scalePanel.contains(e.target)) {
        showScalePanel(scalePanel.hidden);
      }
    });
    $('referenceTrialSmaller').onclick = () => stepTrialScale(-1);
    $('referenceTrialLarger').onclick = () => stepTrialScale(1);
    $('referenceTrialPrevious').onclick = () => stepTrialPhoto(-1);
    $('referenceTrialNext').onclick = () => stepTrialPhoto(1);
    $('referenceTrialSave').onclick = () => {
      if (trialPhase !== 'active' || document.fullscreenElement !== viewport) return;
      const conditions = capturePilotConditions(update());
      if (!conditions) return;
      const records = [{ saved_at: new Date().toISOString(), conditions }, ...getSavedTrials()];
      const stored = save(trialsKey, records);
      if (stored) renderSavedTrials(records);
      scaleStatus.textContent = stored ? 'Сохранено' : 'Не удалось сохранить замер в браузере.';
      showScalePanel(true);
    };
    $('referenceTrialDone').onclick = () => stopTrial();
    const trialDirections = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    // No legacy gallery shortcuts; explicit Esc also works when a browser doesn't consume it natively.
    document.addEventListener('keydown', e => {
      if (document.fullscreenElement === viewport) {
        e.stopImmediatePropagation();
        if (e.key === 'Escape') stopTrial();
        if (trialPhase === 'active' && photo.variants && !trialPhotoRequest) {
          const direction = trialDirections[e.key];
          if (direction) {
            e.preventDefault();
            const step = e.shiftKey ? 64 : 16;
            repositionTrial(pairedPosition[0] + direction[0] * step, pairedPosition[1] + direction[1] * step);
          } else if (!e.ctrlKey && !e.metaKey && !e.altKey && ['+', '=', '-', '−'].includes(e.key)) {
            e.preventDefault();
            stepTrialScale(e.key === '+' || e.key === '=' ? 1 : -1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            repositionTrial(0, 0);
          }
        }
      }
    }, true);
    renderSavedTrials(getSavedTrials());
    select.value = selected.id; chooseModel(photo.id);
    return { update, snapshot: update, calibrationEnvironmentMatches, environmentChanged };
  }
  root.DroneReferences = { profiles, measure, estimate, reviewSegmentLength, mount };
})(typeof window === 'undefined' ? globalThis : window);

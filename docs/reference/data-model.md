# Данные в памяти и экспорт

Справочник для разработчика и потребителя диагностических файлов. Применяется к Android `0.5.1` на основе `acb3e9e` и отдельно к галерее 6.6. Реляционной БД, таблиц, ключей, индексов, транзакций и миграций нет; ER-диаграмма — `N/A`.

## Обнаружения и изображения

| Тип | Поля и ограничения | Время жизни |
|---|---|---|
| [ArgbImage](../../app/src/main/java/ru/university/dronecv/detection/yolo/ArgbImage.kt) | `width,height: Int>0`, `pixels: IntArray(width*height)`, ARGB построчно; массив не копируется | У вызывающего; из RGBA converter заимствован до следующего convert |
| [NormalizedBox](../../app/src/main/java/ru/university/dronecv/detection/ObjectDetector.kt) | `left,top,right,bottom: Float` в `[0,1]`, left<=right/top<=bottom; constructor проверяет, нулевая площадь допустима | В составе Detection |
| `Detection` | `label: String`, `confidence: Float` в `[0,1]`, `box: NormalizedBox`, `classId: Int=0`; classId/label constructor отдельно не валидирует | В результате кадра/фото; не ID отслеживаемой цели |
| [PixelBox / YoloDetection](../../app/src/main/java/ru/university/dronecv/detection/yolo/YoloPostprocessor.kt) | PixelBox: четыре Float в upright px; constructor не проверяет порядок. YoloDetection: classId, label, confidence, box | Промежуточный результат postprocessing |
| [Letterbox / YoloModelSpec](../../app/src/main/java/ru/university/dronecv/detection/yolo/Letterbox.kt) | Геометрия src/input, scale, resizedWidth/Height, padLeft/Top; spec хранит имена тензоров, inputSize, anchors и labels | У движка/результата; [тензорный контракт](../../ml/MODEL.md#3-тензоры) |
| [YoloResult](../../app/src/main/java/ru/university/dronecv/detection/onnx/YoloOnnxEngine.kt) | `imageWidth,imageHeight: Int`, `detections: List<YoloDetection>`, `letterbox`, `preprocessMs,inferenceMs,postprocessMs: Double` | Один infer; размеры после поворота |

## Состояния UI и владение

| Тип | Состав | Особенности |
|---|---|---|
| `PhotoInference` | `detections: List<Detection>`, `inferenceMs: Double` | Время ORT с копированием тензоров |
| [PhotoState<Image>](../../app/src/main/java/ru/university/dronecv/photo/PhotoController.kt) | `phase: PhotoPhase=IDLE`, `image: Image?=null`, `result: PhotoInference?=null`, `error: PhotoError?=null` | `canRecognize=image!=null && phase!=RUNNING`; инварианты переходов обеспечивает controller, а не constructor data class |
| [LiveInference](../../app/src/main/java/ru/university/dronecv/camera/LiveController.kt) | `detections`, `width,height: Int`, `inferenceMs: Double`, optional `conversionMs,preprocessMs,postprocessMs: Double?` | Размеры upright crop; для записи диагностики нужны все стадии |
| `LiveState` | `phase=STOPPED`, `result?`, `pipelineMs?,fps?: Double?`, `completedFrames: Long=0`, `error: String?`, `revision: Long=0` | Ревизия монотонная; сброс текущей активации обнуляет счётчик; expiry снимает result/FPS/pipeline |
| `ThreadConfiguration` | `threads: Int=2`, `switching: Boolean=false`, `error: String?` | UI отражает принятую конфигурацию, не обещание успешности запроса |
| [DiagnosticUi](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticViewModel.kt) | recording, report?, exportStatus?, pipeline?/ort? summaries, elapsedSeconds | Отчёт в Activity ViewModel до нового start/уничтожения процесса |

`PhotoPhase` и `LivePhase` с переходами описаны в [жизненном цикле](../internals/detection-lifecycle.md). Persistent history отсутствует. `rememberSaveable` сохраняет отдельные UI-настройки через механизм Android state; bitmap и отчёт так на диск не сериализуются.

## JSON производительности: schema_version 1

Каноническая реализация — [DiagnosticReport.toJson](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticReport.kt), статистика/счётчики — [DiagnosticStatistics](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticStatistics.kt). Все перечисленные ключи serializer записывает; `null` означает недоступное/неприменимое значение. Формальной JSON Schema в репозитории нет. Новые поля конфигурации добавлены без смены schema_version; анализатор поддерживает исторические файлы без них, но не использует их для `--compare-threads`.

| Поле | JSON-тип / единица | Смысл |
|---|---|---|
| `schema_version` | integer = 1 | Версия диагностического формата |
| `started_epoch_ms` | integer, ms Unix epoch | Внешнее время начала; для интервалов не используется |
| `device`, `android_release`, `app_version`, `build_type` | string | Производитель+модель устройства, Android, версия APK и build type |
| `android_sdk` | integer | API level |
| `warmup.method`, `warmup.completed_frames_before_session` | string `manual`, integer>=0 | Завершённые кадры текущей активации до ручного старта записи |
| `model` | object | Конфигурация из таблицы ниже |
| `duration_ms` | number, ms | Длительность сессии по монотонным часам |
| `interrupted`, `reason` | boolean, string/null | Прерванная сессия и причина; штатный Stop записи может иметь null reason |
| `analyzer_callbacks_accepted` | integer | Принятые для работы callbacks во время записи |
| `completed_frames`, `unstored_frames` | integer | Актуальные успешные результаты; из них не сохранённые из-за capacity |
| `accepted_callbacks_not_completed` | integer | accepted минус completed, не полное число потерянных камерой кадров |
| `processed_fps_session` | number/null, кадр/с | completed / duration, при нулевой длительности null |
| `camera_frames_dropped`, `frame_to_display_latency_ms` | null | Не измеряются |
| `timing_summary_ms` | object | conversion, preprocessing, ort_including_tensor_copy, postprocessing_nms, analyzer_pipeline |
| `notes` | array<string> | Ограничения измерения/интерпретации |
| `pss_first_to_last_sample_delta_kb` | integer/null, kB | Разность последней/первой доступной PSS-пробы; null, если проб меньше двух |
| `frames`, `resources` | array<object> | Временные ряды по таблицам ниже |

`model` содержит `name="YOLO11s"`, `asset`, `sha256`, `input_width/input_height=640`, текстовый `backend`, `intra_op_threads` (1/2/4), `inter_op_threads=1`, `execution_mode="SEQUENTIAL"`, `execution_provider="CPU"`, `confidence` и `nms_iou=0.7`. Эти сведения отражают фиксированную Android-модель; при изменении формата/движка serializer тоже требует проверки.

Каждая сводка в `timing_summary_ms` — object либо null для пустого списка. Поля: `count: integer`, `mean,median,min,max: number` в мс, `p95_nearest_rank: number/null` в мс. Медиана чётного списка — среднее двух центральных; p95 — элемент `ceil(0.95*n)` в сортированном списке (нумерация с 1), только при n>=20. Сводки относятся к сохранённым кадрам, а не к усечённой части.

| Объект ряда | Поля и типы | Условия |
|---|---|---|
| `frames[]` | `offset_ms,conversion_ms,preprocess_ms,ort_ms,postprocess_ms,pipeline_ms: number` | offset — от начала по времени завершения; длительности finite и >=0; сохраняется максимум 100000 кадров |
| `resources[]` | `offset_ms: number`, `pss_kb,thermal_status,battery_percent,battery_status: integer/null`, `battery_temperature_c: number/null` | Опрос примерно каждые 5 с, не на каждый кадр; thermal API с 29; температура батареи не температура CPU |

В памяти `FrameMeasurement`/`ResourceSample` содержат `offsetNanos`, а `DiagnosticFrameSnapshot` — `durationNanos`, все типа `Long` в наносекундах; JSON преобразует эти поля в мс. Длительности стадий (`conversionMs` и другие) уже хранятся как `Double` в миллисекундах. Лимит установлен для кадрового ряда; отдельного capacity для списка resource samples нет. Подробные границы длительностей и разные определения FPS — [потоки данных](../architecture/data-flow.md#границы-измерений).

## Сигнал текущего кадра: payload v2 в 0.5.1

Внешний формат диагностики остаётся `schema_version=1`; версия вложенного сигнала — `target_signal_schema_version=2`. Поля прежней диагностики сохранены. `frames[].target_signal` — object/null, в памяти это `FrameMeasurement.targetSignal` и `LiveState.target`. Сигналы усекаются вместе с кадровым рядом.

`application_stale_frames_discarded: integer` считает пропуски приложения до ORT из-за подтверждённого возраста больше 250 мс, отдельно от accepted callbacks и неизвестных drops CameraX. `timing_summary_ms` дополнен сводками `capture_to_signal`, `capture_to_analyzer`, `analyzer_to_signal`; каждая включает только ненулевые метрики сохранённых сигналов. Во всех сводках `p50` — явный псевдоним `median`; прежние `median` и `p95_nearest_rank` сохранены.

| Поля `target_signal` | Типы и смысл |
|---|---|
| `schema_version`, `frame_id`, `source_id` | integer; версия payload 2, положительный номер сигнала в контроллере и номер активации analyzer; не ID объекта |
| `capture_ns`, `analyzer_entry_ns`, `signal_dispatch_ns` | integer в нс; capture_ns может быть null; базы нельзя смешивать |
| `timestamp_source`, `timing_issue` | `elapsed_realtime`/`unknown`; причина неизвестной задержки — string/null |
| `capture_to_signal_ms`, `capture_to_analyzer_ms`, `analyzer_to_signal_ms` | number/null, в мс |
| `status`, `width`, `height`, `coordinate_space` | `detected`/`no_target`, положительные integer размеров upright crop, `upright_crop_pixels` |
| `center`, `pixel`, `confidence` | object с числовыми x/y центра самого уверенного обнаружения текущего кадра, object с целочисленными индексами x/y, number `[0,1]`; при no_target все три null |

`capture_timing_availability` относится только к сохранённым кадрам: `scope="stored_frames"`, `stored_frames` — размер frames, `signals_recorded` — число ненулевых сигналов, `available_frames` — число сигналов с корректной capture-to-signal, `unavailable_frames=stored_frames-available_frames`. Доля `available_fraction=available_frames/stored_frames` либо null для пустой записи. Устаревшие входы и усечённые кадры не входят в знаменатель; наличие raw timestamp при UNKNOWN не считается доступным измерением.

Метрики Camera2 корректны только с сопоставимой временной базой; причины null, граница внутренней публикации и ручная проверка описаны в [инструкции задержки](../guides/latency-and-prediction.md). Экспорт не содержит изображения или все рамки. Анализатор пересчитывает задержки по исходным ns и проверяет сводки. В потребителях сохраняйте точность Long-меток; JavaScript Number может терять младшие разряды больших ns.

### Совместимость прежних отчётов

Отчёты без target_signal_schema_version читаются как прежде. Анализатор также читает payload v1 из 0.5.0: `observed` и `observed_pixel` соответствуют новым `center` и `pixel`, статус `observed` означает обнаружение, `lost`/`no_target` — отсутствие. Старые дополнительные поля допускаются на входе, но их расчёты не выполняются и в новом экспорте их нет. Потребитель v1 должен проверить marker 2 и перейти на новые названия/статусы; молча интерпретировать v2 как v1 нельзя. Старые файлы не переписываются. Сводки без поля p50 допустимы.

## JSON инвентаря камер: schema_version 1

Источник — [CameraInventory.collect](../../app/src/main/java/ru/university/dronecv/camera/CameraInventory.kt), текущий выбор добавляет [exportCameraInventory](../../app/src/main/java/ru/university/dronecv/camera/CameraInventoryPanel.kt) в момент сохранения. Характеристики снимаются при обновлении списка, текущие параметры — позже при экспорте; единой атомарной пробы всего устройства нет.

| Группа | Поля |
|---|---|
| Корень | schema_version, manufacturer/model/android_release (string), android_sdk (integer), camera2_ids (array<string>), cameras (array), camerax (object), note (string) |
| `camerax` | `ids: array<string>` либо `error: string` при неудаче получения CameraX provider/IDs |
| `cameras[]` | `id`, lens_facing (`back/front/external/unknown`), physical_ids, physical_cameras, logical_multi_camera (boolean), focal_lengths_mm (array<number>), zoom_min/zoom_max, zoom_range_source, preview_sizes/yuv_sizes/jpeg_sizes (array объектов width/height integer) |
| `physical_cameras[]` | id, focal_lengths_mm и при доступности sensor_width_mm/sensor_height_mm; при ошибке — error |
| `current_camera` | logical_id/requested_physical_id/active_physical_id (string/null), physical_ids, requested_zoom_ratio (number), current_zoom_ratio (number/null), switching (boolean), warning (string/null) |

При ошибке отдельного Camera2 ID элемент может содержать только `id`/`error`. Отсутствующие метаданные не обещаны одинаково оформленными: часть значений null, часть полей не добавляется, списки могут быть пустыми. Fallback zoom_min=1 явно помечен как предположение источника range. Инвентарь не доказывает поддержку комбинации потоков и фактическую оптику.

## Лабораторная галерея

Галерея хранит выборку, settings, runs, trial и results в браузерном `localStorage` с префиксом `dronecv66v2.`. Это отдельное хранилище, не связанное с Android ViewModel. Экспорт JSON имеет `format="dronecv66-session-2"`; [results_template.csv](../../lab/monitor_test/results_template.csv) задаёт 36 столбцов CSV. Назначение полей, единицы, null и правила TP/FN/FP/TN канонически описаны в [протоколе](../../lab/monitor_test/PROTOCOL.md#5-размеры-и-экспорт).

Выборка содержит фиксированные image IDs; повторный прогон сохраняет порядок. Результат показа заменяется по паре `(run_id, step)` в массиве JavaScript; это программное правило, не SQL-ключ. Перед очисткой браузера экспортируйте JSON. Импорт восстанавливает подходящую sample и trial, сливает отсутствующие runs/results (результаты после подтверждения), не перезаписывает существующие ключи и не применяет корневые settings. Изображения/manifest не переносятся; перед новым прогоном настройки проверяются вручную. В quick-режиме `app_conf_threshold_pct` в записи равен null даже при наличии значения в скрытом поле настроек.

## Проверка файлов и ограничения

Сохранённый JSON можно синтаксически проверить `python3 -m json.tool /absolute/path/to/report.json` (рабочий каталог не важен). Анализатор Android дополнительно проверяет счётчики, агрегаты и сопоставимость, см. [тестирование](../development/testing.md). Unit/instrumented JSON tests проверяют serializer; они не подтверждают точность системных датчиков, отсутствие кадровых потерь или полевое качество детекции.

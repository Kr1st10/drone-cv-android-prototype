# Данные в памяти и экспорт

Справочник для разработчика и потребителя диагностических файлов. Применяется к Android `0.5.2` на основе `acb3e9e` и отдельно к галерее 6.6. Реляционной БД, таблиц, ключей, индексов, транзакций и миграций нет; ER-диаграмма — `N/A`.

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
| `LiveState` | `phase=STOPPED`, `result?`, `pipelineMs?,fps?: Double?`, `completedFrames: Long=0`, `error: String?`, `revision: Long=0`, `tracking: TrackingSignal?`, `trackingFps: Double?`, историческое `target: TargetSignal?` | Ревизия монотонная; сброс обнуляет счётчик. Expiry убирает наблюдение и частоту LK, сохраняя сводку YOLO. В ветви без LK очищает result/FPS/pipeline |
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
| `analyzer_callbacks_accepted` | integer | Отобранные для ML-работы снимки во время записи; не все входные callback |
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

## Вход камеры в 0.5.2

Корневая schema 1 и payload сигнала v2 сохраняются. Добавлен camera_input; старые отчёты без него анализируются как прежде.

| Поле camera_input | Тип / смысл |
|---|---|
| received_frames | integer, принятые callback текущего входа во время записи; старый/inactive source не считается |
| copied_frames | integer, подготовленные и переданные в offer снимки |
| superseded_frames | integer, pending-снимки, заменённые более свежим |
| no_buffer_frames | integer, пропуски из-за слота/бюджета пула |
| stale_frames | integer, слишком старые входы или ожидание перед ORT |
| invalidated_frames | integer, собственные снимки, освобождённые при invalidation/неактуальном token |
| copy_errors | integer, ошибки подготовки или закрытия исходного кадра |
| copy_mean_ms, copy_max_ms | number/null, время подготовки по всем copied_frames, null без копий |
| fps_session | number/null, received_frames / длительность записи; null при нулевой длительности |

Счётчики отражают события в пределах diagnostic token, не полный баланс незавершённой работы после Stop. analyzer_callbacks_accepted и completed_frames относятся к отобранной ML-работе; они не равны received_frames. Pipeline — подготовка плюс ML, очередь между workers в него не входит, но входит в analyzer_to_signal. UI input.fps использует окно до 30 входов, экспорт fps_session — всю длительность сессии. Подробнее — [владение кадрами](../guides/camera-frame-ingress.md).

## Наблюдения LK

Корневой отчёт сохраняет `schema_version=1`. В режиме сопровождения `frames[]` хранит завершения YOLO, длительности и `detection_count` — число рамок модели. `target_signal` в этих строках равен null: позиция камеры публикуется отдельно в `LiveState.tracking`. Сводки v2 не подменяются задержкой LK. Для анализа используйте раздел `tracking`, если в сессии были публикации.

| Поля `tracking` версии 1 | Смысл |
|---|---|
| `observed_frames`, `track_updates` | Публикации по новым кадрам; второе число включает только кадры с координатами. |
| `corrections`, `loss_events` | Успешные коррекции и переходы от рамки к `lost` в том же поколении и источнике. Stop/expiry без кадра не считаются потерей. |
| `updates_fps_session` | `track_updates` на секунду длительности всей записи; null при нулевой длительности. |
| `samples`, `unstored_samples` | Первые 10 000 публикаций и число не сохранённых. Счётчики относятся ко всей записи. |
| `stored_updates`, `updates_with_capture_timing` | Знаменатель и числитель для доступности задержки от экспозиции среди сохранённых кадров с координатами. |
| `timing_summary_ms` | `update_work`, `update_capture_to_signal`, `update_capture_to_analyzer`, `update_analyzer_to_signal` по сохранённым кадрам с координатами; `correction_work` отдельно. p50 равен median, p95 доступен от 20 значений. |

`samples[]`: `kind` равен `frame` или `correction`. Коррекция может повторить ключ (`generation`, `source_id`, `sequence`) кадра и относится к записи, активной при входе этого кадра. `status` — `searching`, `tracking` или `lost`. При `tracking` есть локальный `track_id`, `box`, `center`, `pixel` и `quality`; иначе эти поля null. `width/height` и координаты относятся к полному upright crop. `tracking_width/height` и `median_fb_error_px` относятся к сетке LK.

`classification`, `last_yolo_confidence`, `last_yolo_frame` и `confirmation_age_ms` описывают последнее подтверждение отдельно от `quality`. Метки наблюдения находятся в `frame`, конец интервала — `signal_dispatch_ns`. `work_ms` измеряет grayscale и LK для кадра; для коррекции — работу replay и commit. Оно не включает копирование ImageProxy или ожидание между исполнителями. При несовместимых часах метрики от экспозиции null, с `timing_issue`. [Границы интервалов](../guides/latency-and-prediction.md).

## Сигнал текущего кадра: payload v2 в 0.5.1

Внешний формат диагностики остаётся `schema_version=1`; версия вложенного сигнала — `target_signal_schema_version=2`. Поля прежней диагностики сохранены. `frames[].target_signal` — object/null, в памяти это `FrameMeasurement.targetSignal` и `LiveState.target`. Сигналы усекаются вместе с кадровым рядом.

`application_stale_frames_discarded: integer` считает пропуски приложения до ORT из-за подтверждённого возраста или ожидания в очереди больше 250 мс, отдельно от accepted callbacks и неизвестных drops CameraX. `timing_summary_ms` дополнен сводками `capture_to_signal`, `capture_to_analyzer`, `analyzer_to_signal`; каждая включает только ненулевые метрики сохранённых сигналов. Во всех сводках `p50` — явный псевдоним `median`; прежние `median` и `p95_nearest_rank` сохранены.

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

Полноэкранный режим движения выгружает отдельные JSON эталона. Схемы `dronecv-motion-run-1`, `dronecv-motion-series-1`, журнал Android `dronecv-motion-android-1`, отчёт `dronecv-motion-report-3`, экранная метка и методика IoU описаны в [протоколе движения](../../lab/monitor_test/PROTOCOL.md#7-движущаяся-цель).

Галерея хранит выборку, settings, runs, trial и results в браузерном `localStorage` с префиксом `dronecv66v2.`. Это отдельное хранилище, не связанное с Android ViewModel. Экспорт JSON имеет `format="dronecv66-session-2"`; [results_template.csv](../../lab/monitor_test/results_template.csv) задаёт 36 столбцов CSV. Назначение полей, единицы, null и правила TP/FN/FP/TN канонически описаны в [протоколе](../../lab/monitor_test/PROTOCOL.md#5-размеры-и-экспорт).

Выборка содержит фиксированные image IDs; повторный прогон сохраняет порядок. Результат показа заменяется по паре `(run_id, step)` в массиве JavaScript; это программное правило, не SQL-ключ. Перед очисткой браузера экспортируйте JSON. Импорт восстанавливает подходящую sample и trial, сливает отсутствующие runs/results (результаты после подтверждения), не перезаписывает существующие ключи и не применяет корневые settings. Изображения/manifest не переносятся; перед новым прогоном настройки проверяются вручную. В quick-режиме `app_conf_threshold_pct` в записи равен null даже при наличии значения в скрытом поле настроек.

## Проверка файлов и ограничения

Сохранённый JSON можно синтаксически проверить `python3 -m json.tool /absolute/path/to/report.json` (рабочий каталог не важен). Анализатор Android дополнительно проверяет счётчики, агрегаты и сопоставимость, см. [тестирование](../development/testing.md). Unit/instrumented JSON tests проверяют serializer; они не подтверждают точность системных датчиков, отсутствие кадровых потерь или полевое качество детекции.

## Поток диагностической сессии `dronecv-session-timeline-1`

Итоговый отчёт `dronecv-coordinate-continuity-1`, JSON/CSV и определения метрик описаны в [анализе непрерывности](../guides/timeline-continuity.md). Формат входного журнала этим анализом не меняется.

Экспорт — UTF-8 NDJSON: один JSON-объект на строку с `schema`, `session_id`, `event_id`, `event_ns`, `type`, `data`. Все 64-битные идентификаторы и времена — десятичные строки; недоступные значения — `null`. `event_id` задаёт порядок приёма внутри сессии. `event_ns` является временем события в наносекундах `elapsedRealtime` и может идти не по порядку при асинхронной доставке. Его нельзя смешивать с календарным временем или неизвестными часами камеры. Заголовок `header` содержит `start_ns`, режим и базу часов; `session_end` содержит `stop_ns`, `recording_complete`, `experiment_status`, причину, число принятых и пропущенных записей и известные границы пропуска. Отсутствие корректного конца означает неполный файл.

`state` фиксирует публикуемое приложением состояние: `publication_ns`, причину, поколение и источник камеры, идентификаторы кадра, нормализованный `box` или `null`, источник результата, время изображения, базу часов, время входа, причину непригодности времени, идентификаторы и время изображения принятого подтверждения YOLO, время его принятия и кадр детектора. Начальный снимок относится к моменту начала записи, а его изображение может быть старше записи. Повторная публикация сохраняет исходное время изображения. Таймерная очистка может не иметь кадра. Запись состояния — наблюдение за состоянием внутри приложения; подтверждение идентичности физической цели требует независимого эталона.

`frame` и `detection` содержат данные стенда; `publication` поддерживает его прежний расчёт и может дублировать `state`. `metadata` содержит доступные метаданные и калибровочный кадр, если он получен. Время публикации регистрируется при изменении внутреннего состояния контроллера, не является временем отображения на экране. Полнота записи, завершение опыта и пригодность метрики различны: `recording_complete` не означает успешного сопровождения, `experiment_status=interrupted` допускает полный записанный префикс; `not_observed` означает, что приложение не определяет завершение внешнего опыта, а задержка экспозиции требует совместимой базы времени. Пропуски или отсутствие конца исключают подтверждение полного прогона.

Python-анализатор принимает старый корневой `schema_version=1` и этот поток как отдельные входы; смешивать их в одном сравнении потоков нельзя. Он выдаёт интервалы `state` до конца записи и явные ошибки целостности. До первого снимка состояние неизвестно. При пропусках переходы могут находиться в неизвестных местах: анализатор консервативно помечает все интервалы как неизвестные и отдельно сохраняет наблюдённые координаты. Строка `recording_failure` после завершающей строки также делает запись неполной. Стенд продолжает принимать `dronecv-motion-android-1` и дополнительно читает этот поток, выполняя вычитание времён в `BigInt` до преобразования разностей; исходные идентификаторы сохраняются строками. Критерий `motion-retention-v3` не изменён.

Стенд восстанавливает переходы из `state`, включая `initial_snapshot` и результаты работы, начатой до записи. Совпадающие по `publication_ns` и координатам `publication` учитываются один раз. Начальный снимок не создаёт детекцию или захват. До первого состояния координаты неизвестны; явный `box=null` означает известное отсутствие рамки. В `state.frame_id` находится идентификатор контроллера, а `motion_frame_id` ссылается на `frame.frame_id` журнала. Для начального снимка ссылка на кадр текущей записи отсутствует; другие ссылки вне записи сохраняются с `frame_reference=outside_recording`, без подстановки идентификатора контроллера.

До вычисления относительного `capture_ns` импортёр проверяет `timebase=elapsed_realtime`, положительность метки и её положение не позже `analyzer_entry_ns`. Затем вычитает `start_ns` через `BigInt`. Непригодная экспозиция даёт `null`; исходная строка остаётся в `raw_capture_ns`. Вход в анализатор не заменяет экспозицию при сопоставлении часов.

`resource` содержит `offset_ns` (строка, наносекунды относительно начала измерений), `pss_kb` (KiB), `thermal_status` (код Android), `battery_percent` (проценты), `battery_status` (код Android BatteryManager) и `battery_temperature_c` (градусы Цельсия батареи, не CPU). Недоступные измерения представлены `null`.

Аварийный экспорт добавляет `recording_failure` с причиной после последней строки, в том числе после `session_end`; разделитель строки добавляется только при необходимости. Python читает все исходные байты для SHA-256, сохраняет ошибки пустых, повреждённых и обрезанных строк и продолжает чтение доступных полных строк. Восстановление читаемой части не восстанавливает полноту: при повреждении, разрыве идентификаторов или отказе записи интервалы консервативно неизвестны. Наблюдённая рамка сохраняется отдельно как `observed_box`.

Предупреждение о целостности в Android хранится отдельно от результата экспорта. Потери очереди и ошибки writer сохраняют предупреждение после Stop и повторных сохранений; сообщение «Отчёт сохранён» означает только успешную запись файла назначения. Атомарные обновления UI проверяют идентификатор сессии и не берут блокировки владельца из callback writer. Новая сессия сбрасывает предупреждение предыдущей.

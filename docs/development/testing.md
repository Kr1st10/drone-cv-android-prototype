# Проверки приложения и инструментов

Инструкция для разработчика и тестировщика Android `0.5.2`. Команды выполняются из корня репозитория с JDK 17, SDK 35 и установленной моделью по [быстрому старту](../getting-started.md). Результаты текущего изменения находятся в PROJECT_STATE; [аудит](../documentation-audit.md) содержит исторические проверки подготовки документации. Этот раздел описывает воспроизводимые проверки.

## Локальная Android-сборка и JVM

Парный браузерный стенд: `node lab/monitor_test/tests/motion_ab_test.mjs` проверяет арифметику, сопоставимость, дедупликацию, профили и JSON/CSV. `motion_ab_smoke.mjs` использует Chrome/Playwright и настоящий IndexedDB для порядка AB/BA, отмены/повтора, новых RAF, импорта/калибровки, перезагрузки, квоты, устаревшей калибровки и воспроизведения анализа из исходников экспорта. Оба входят в `pytest lab/monitor_test/tests`. Запуск browser script требует `CHROMIUM` и рабочего каталога с `node_modules/playwright`, как у остальных smoke-тестов. [Контракт и границы A/B](../../lab/monitor_test/AB_COMPARISON.md). Синтетическое A/A не подтверждает аппаратную повторяемость.

```bash
./gradlew --no-daemon assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug
python3 ml/scripts/verify_apk_model.py app/build/outputs/apk/debug/app-debug.apk
```

Успех: `BUILD SUCCESSFUL`, отсутствие failed/errors в test XML, `APK model OK`. Lint предупреждения/информационные сообщения рассматриваются отдельно от ошибок. Форматтер, ktlint/detekt и Markdown lint task в проекте не настроены; `kotlin.code.style=official` само не запускает проверку форматирования.

| Проверка | Что подтверждает | Условия и пределы |
|---|---|---|
| [detection JVM tests](../../app/src/test/java/ru/university/dronecv/detection) | Геометрия/валидация, preprocessing/NMS, целостность, настоящий ORT и сравнение thread counts | ONNX в `ml/weights/` обязателен; однотонные входы не являются оценкой точности |
| Два Python parity tests в OnnxParityTest | Тензоры и рамки Kotlin/Python | `ml/data/android_parity/reference.tsv` и файлы из него; без них только эти сравнения skipped |
| [photo JVM tests](../../app/src/test/java/ru/university/dronecv/photo) | Состояния/очередь/устаревшие ошибки, close и Fit/decode размеры | Поддельный backend тестирует управление ресурсами, не подменяет реальные CV-результаты приложения |
| [camera JVM tests](../../app/src/test/java/ru/university/dronecv/camera) | Stride/crop/каналы, mapping, generation/source/expiry/FPS, смена потоков | Без физического сенсора; не доказывают реальное совмещение Preview/Analysis |
| [diagnostics JVM tests](../../app/src/test/java/ru/university/dronecv/diagnostics) | Статистика, token/capacity, export metadata и invalidation | Не измеряют OEM thermal/PSS и длительную стабильность |
| `DiagnosticExporterTest`, `LiveTrackingConcurrencyTest` | Поздний экспорт, порядок статусов, конкурентные Stop/start и смена контроллера с удержанием кадра | Управляемые записи и backend; без физических устройств |
| `assembleDebugAndroidTest` | Компиляция [device tests](../../app/src/androidTest/java/ru/university/dronecv) | Не выполняет ни одного теста на устройстве |
| `lintDebug` | Статический Android lint | Не заменяет запуск UI/инференса |

Отчёты: `app/build/test-results/testDebugUnitTest/TEST-*.xml`, `app/build/reports/tests/testDebugUnitTest/index.html`, `app/build/reports/lint-results-debug.xml` и `.html`. APK и AndroidTest APK — в `app/build/outputs/apk/`.

## Сухой прогон центрирования камеры

Запустите тесты из корня проекта на JDK 17. Для сборки нужны SDK и модель по [быстрому старту](../getting-started.md).

```bash
./gradlew --no-daemon :app:testDebugUnitTest \
  --tests 'ru.university.dronecv.centering.CameraCenteringTest'
```

Сценарий `dryRunShiftCenterLoss` подаёт синтетические `TrackingSignal` для кадра 640 × 480 с зоной покоя 40 × 40 px. Он печатает строки `dry_run` в вывод Gradle и `system-out` отчёта `app/build/test-results/testDebugUnitTest/TEST-ru.university.dronecv.centering.CameraCenteringTest.xml`. В примере рамка смещена вправо и вверх, обновление LK возвращает её в центр, затем рамка пропадает при ещё действующем подтверждении YOLO.

```jsonl
{"mode":"dry_run","time_ms":0.0,"generation":1,"source_id":2,"dx_px":null,"dy_px":null,"box_state":"MISSING","yolo_state":"NONE","confirmation_valid":false,"action":"STOP","horizontal":"NONE","vertical":"NONE","reason":"WAITING_FOR_BOX"}
{"mode":"dry_run","time_ms":0.0,"generation":1,"source_id":2,"dx_px":96.0,"dy_px":-56.0,"box_state":"PRESENT","yolo_state":"CONFIRMED","confirmation_valid":true,"action":"MOVE","horizontal":"RIGHT","vertical":"UP","reason":"TARGET_OFFSET"}
{"mode":"dry_run","time_ms":100.0,"generation":1,"source_id":2,"dx_px":0.0,"dy_px":0.0,"box_state":"PRESENT","yolo_state":"CONFIRMED","confirmation_valid":true,"action":"HOLD","horizontal":"NONE","vertical":"NONE","reason":"IN_DEAD_ZONE"}
{"mode":"dry_run","time_ms":180.0,"generation":1,"source_id":2,"dx_px":null,"dy_px":null,"box_state":"MISSING","yolo_state":"CONFIRMED","confirmation_valid":true,"action":"STOP","horizontal":"NONE","vertical":"NONE","reason":"BOX_LOST"}
```

Для проверки связки с файлом добавьте к Gradle-команде фильтры `--tests '*DryRunJournalTest'` и `--tests '*LiveTrackingIntegrationTest'`. `DryRunJournalTest` с подставными сигналами проверяет `MOVE`, `HOLD`, потерю и очистку рамки, повторный захват, таймер при молчащем потоке, отбрасывание результатов старого источника и запись с выключенным dry-run. Тест печатает фактический NDJSON из `TimelineWriter`. `LiveTrackingIntegrationTest` проверяет выдачу тех же сигналов живым контроллером с подставными кадрами и отсутствие вычисления на пути их публикации. [Контракт контроллера](../reference/api.md#сухой-прогон-центрирования-камеры).

На Xiaomi 17 Pro в отладочной сборке выберите **B: YOLO + LK** в «Настройках» камеры, запустите детекцию, отметьте **Сухой прогон центрирования** в разделе «Диагностика» и начните сессию. После завершения экспортируйте файл из раздела «Журналы» и найдите строки `type: "dry_run"`. Зона покоя записи составляет 40 × 40 px обработанного кадра. На телефоне предстоит сверить направления с живым кадром при поворотах и подтвердить причины остановки при паузе и смене источника. Проверка направлений по осям и фактической остановки DJI RS 5 относится к этапу подключения управления.

## Выполнение device tests

`BuildIdentityTest` проверяет адаптер существующих BuildConfig-полей, полный commit/dirty/null и изоляцию metadata между записями. `LiveControllerTest` проверяет конфигурацию разных сессий и измеренную геометрию, очищаемую при invalidation. `CameraInventoryInstrumentedTest` различает запросы и неизвестные результаты, `DiagnosticJsonInstrumentedTest` читает сохранённую metadata из JSON. `LiveCameraInstrumentedTest.cameraRunsRealModelAndStopClearsLateResults` проверяет идентификатор в показаниях, касания кнопки детекции и неизменность границ кнопки и превью после результата и прокрутки. Компиляция этих тестов не означает их выполнение.

Проверки импортов и конфликтов метаданных: `python -m pytest ml/tests/test_build_metadata.py ml/tests/test_timeline_analysis.py ml/tests/test_timeline_continuity.py ml/tests/test_analyze_android_sessions.py` и `pytest lab/monitor_test/tests/test_motion.py` (Node/Chrome/Playwright). Они используют тестовые данные и не измеряют качество CV.

Используйте своё тестовое устройство/эмулятор с задней камерой и подходящей ABI. Тесты меняют UI, ориентацию/foreground и работают с камерой; запускайте их, когда устройство доступно для испытаний. При нескольких подключениях проверьте целевое устройство в выводе Gradle; для однозначного запуска оставьте одну цель.

```bash
adb devices
./gradlew --no-daemon connectedDebugAndroidTest
```

Ожидайте успешный Gradle result и отчёт `app/build/reports/androidTests/connected/debug/index.html`; проверьте failures и skipped. [LiveCameraInstrumentedTest](../../app/src/androidTest/java/ru/university/dronecv/camera/LiveCameraInstrumentedTest.kt) проверяет реальный CameraX→ORT→UI, Stop/restart, потоки, zoom request, фон/ротацию/вкладки. CameraProbeRestorationTest проверяет сохранение запроса и очистку runtime через Compose StateRestorationTester. Для изолированного Compose-теста debug APK включает `ui-test-manifest`. В AndroidTest закреплён Espresso Core 3.7.0: на проверенном образе Android 16 прежний вызов `InputManager.getInstance` останавливал Compose-тесты до assertions ([примечания AndroidX](https://developer.android.com/jetpack/androidx/releases/test#espresso-3.7.0)). Также есть decoder/EXIF, ORT, JSON и inventory tests. Camera tests используют assumptions при отсутствии hardware; сам зелёный итог без просмотра skipped не доказывает их выполнение.

Повороты эмулятора не доказывают оптику, полевую точность, нагрев и длительную работу Xiaomi. Ручные протоколы: [PHOTO_QA](../PHOTO_QA.md), [LIVE_QA](../LIVE_QA.md), [CAMERA_QA](../CAMERA_QA.md), [PERFORMANCE_QA](../PERFORMANCE_QA.md), [потоки ORT](../ORT_THREAD_BENCHMARK.md).

## Python и галерея

Изолированные проверки новых target-сигналов не требуют ML-библиотек или pytest:

```bash
python3 -m unittest discover -s ml/tests -p test_target_signals.py -v
python3 -m unittest discover -s ml/tests -p test_timeline_analysis.py -v
python3 -m unittest discover -s ml/tests -p test_timeline_continuity.py -v
node lab/monitor_test/tests/timeline_import_test.mjs
```

`TimelineWriterTest.closeFailureInvalidatesExportedFooter` вызывает настоящий `copyTo()` после искусственной ошибки `close()` и передаёт его результат Python-анализатору через `python3` (stdlib, без дополнительных пакетов). Проверяются причина отказа, SHA-256 всего файла, неизвестные интервалы и ресурсные значения, включая `null`. Python должен быть доступен в PATH JVM-теста. `SessionUpdatesTest` управляет порядком чтения UI, Stop и callback через latch; `MotionJournalTest.overflowAndStopDoNotInvertJournalAndWriterLocks` одновременно удерживает путь переполнения и останавливает журнал при заблокированном диске, затем проверяет повторный экспорт. Случайные задержки `sleep` не используются.

Регрессии первого этапа оптимизации диагностики используют настоящие `LiveController`, `DiagnosticFrames` и `TimelineWriter` с управляемыми часами, очередями исполнителей и latch. `LiveTrackingIntegrationTest` проверяет четыре сочетания записей, поздний снимок LK с исходными временами и подтверждением YOLO, порядок событий и накопление ограниченной статистики без timeline. `LiveControllerTest` наблюдает вызов сериализации геометрии для текущего, отсутствующего и старого токена; заблокированный serializer не мешает публикации результата, Stop и rebind. `DiagnosticStatisticsTest` проверяет отказ старым токенам до сериализации и совпадение Long-полей со старым форматом. `TimelineWriterTest` проверяет очередь из двух событий при 100 отклонённых payload: сериализуются только принятые, в исходном порядке на writer. Наблюдатели на границе сериализации отличают отсутствие работы от простого отсутствия выходных событий. Эти тесты не измеряют FPS на устройстве.

В Android `TargetSignalTest` проверяет независимый выбор максимального confidence, пустой кадр, временные базы, invalidation и закрытие кадров. `TargetReportTest` и device JSON test `TargetSignalJsonInstrumentedTest` проверяют serializer, null и долю доступных меток. Синтетические рамки и часы проверяют контракт, но не являются аппаратными измерениями задержки. Python-тесты читают payload v1/v2 и отчёты без сигнала; ручные проверки — [задержка и координаты](../guides/latency-and-prediction.md).

В подготовленном Python-окружении с зависимостями [ML README](../../ml/README.md):

```bash
python -m pytest ml/tests -q
python -m pytest lab/monitor_test/tests -q
```

Это существующие тесты; они не запускают заново полный исследовательский экспорт/оценку качества. Просматривайте skipped и требования конкретных тестов. Gallery smoke требует Node, Chromium, Playwright в `PLAYWRIGHT_NODE_DIR` и 90 локальных изображений; отсутствие любого условия приводит к skip. Полные условия — [галерея](../../lab/monitor_test/README.md).

В этом же наборе `reference_test.mjs` проверяет расчёт эталонной оси (15 м, удвоение при уменьшении изображения), отказ при неизвестной геометрии и три профиля. `reference_smoke.mjs` проверяет вкладку, локальные фото, масштаб/расстояние, сохранение настроек, риски в окне 460 × 600 и сохранность прежних результатов/экспорта; синтетическая подтверждённая ось существует только внутри теста. Хеши шести исходных фото проверяются отдельно. Переключение девяти записей ракурсов, отсутствие устаревших метров после смены фотографии/калибровки и собственные размеры моделей проверяются браузером; прямоугольники с тестовыми осями не выдаются за реальные эталоны. Независимый Python-тест сравнивает JavaScript с фиксированными ответами и выводом через atan2/tan (равенство угловых размеров); промежуточные результаты не округляются. Эти проверки не подтверждают соответствие реального силуэта паспортному габариту или дальность детекции Xiaomi.

Ядро движения и неизменный sync-код проверяет `node lab/monitor_test/tests/motion_test.mjs`. Новые автономные проверки запускаются из корня репозитория:

```bash
node lab/monitor_test/tests/motion_scenario_test.mjs
node lab/monitor_test/tests/motion_timeline_test.mjs
node lab/monitor_test/tests/sync_check_test.mjs
node lab/monitor_test/tests/sync_check_end_test.mjs
node lab/monitor_test/tests/motion_calibration_test.mjs
node lab/monitor_test/tests/motion_report_v4_test.mjs
node lab/monitor_test/tests/capture_exposure_test.mjs
node lab/monitor_test/tests/motion_journal_status_test.mjs
node lab/monitor_test/tests/motion_report_test.mjs
node lab/monitor_test/tests/center_error_test.mjs
node lab/monitor_test/tests/timeline_import_test.mjs
```

Первый набор проверяет фазы, единое время, геометрию области и скрытое продолжение маршрута. Второй использует синтетические изображения с перспективой, разными размерами, пропуском и повтором ID. Третий проверяет новый `motion-scenario-v4`, включая временные доли, очистку, сохранённую рамку, повторный захват, цензурирование и неопределённость часов. В него входят пустое состояние, начавшееся до скрытия, избыточный `clear`, поздняя очистка и отсутствие фактически показанного возвращения. `motion_journal_status_test.mjs` проверяет читаемость без JPEG/эталона, временное сопоставление без пространственных точек и совпадение границ часов с прежним анализатором. Старые IoU, ошибка центра и импорт timeline проверяются отдельно, без изменения критерия `motion-retention-v3`.

Для браузерных сценариев нужны Chrome/Chromium и Playwright. Укажите каталог с `node_modules/playwright` в `PLAYWRIGHT_NODE_DIR`; запускайте Node из этого каталога, поскольку сценарии используют его для поиска пакета. Проверки с реальными фотографиями требуют локальный фотонабор. [Обязательный набор ручного стенда](#приёмка-ручного-стенда-этап-5) использует синтетические изображения.

`capture_exposure_test.mjs` проверяет консервативные границы capture/reacquisition при разрыве траектории, разделение возможного и доказанного события, свежесть и подтверждённое отсутствие координат. [Воспроизведение и ограничения](../../lab/monitor_test/tests/independent-sync-verification.md#исправление-границ-захвата-pr-51-2026-11-17).

`motion_timeline_test.mjs` проверяет независимость траектории от периода, удержание 100 мс, задержки без вымышленных показов, несколько экспозиций одного кода, текущую и устаревшую рамки, неизвестность времени и границы Stop. `motion_timeline_smoke.mjs` проверяет canvas, fullscreen, IndexedDB, отмену, завершение, обрыв/reload и отказ будущей версии. Отдельная часть использует обычный RAF Chrome без подмены часов. Эти времена относятся к браузерной модели, не физическому дисплею или телефону.

Пример с абсолютными путями:

```bash
cd /absolute/path/to/playwright-workdir
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_timeline_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_auto_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_controls_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_calibration_jpeg_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_calibration_real_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_store_review_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_repeat_recovery_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_start_cleanup_smoke.mjs /absolute/path/to/repository/lab/monitor_test
CHROMIUM=/absolute/path/to/chromium node /absolute/path/to/repository/lab/monitor_test/tests/motion_report_review_smoke.mjs /absolute/path/to/repository/lab/monitor_test
```

`motion_auto_smoke.mjs` проверяет простой сценарий, постоянное хранение, повтор и автоматический импорт/анализ; `motion_calibration_jpeg_smoke.mjs` выполняет синтетический canvas→JPEG→decode без камеры. `motion_store_review_smoke.mjs` использует настоящий Chrome IndexedDB с искусственными отказами транзакций: импорт после записи метаданных/шагов, откат, повторная попытка, дедупликация, конфликт, reload и устойчивый выбор последнего локального запуска при обратном порядке ID. `motion_report_review_smoke.mjs` проверяет раздельные sync/временные/пространственные статусы, автоматическую обработку нескольких JPEG, имена проблемных журналов, ручной режим, быстрые переключения и импорт во время декодирования. Искусственные отказы и синтетические журналы не являются испытанием камеры. `sync_check_test.mjs` проверяет фазовое сопоставление, все размеры и отсутствие пересечений; `sync_check_smoke.mjs` — запуск без фото, 10 секунд + пять шагов, отдельное сохранение, отмену/очистку, JSON/NDJSON с пропусками, JPEG/угловые метки и движение с ячейкой 18. Старые браузерные фикстуры движения явно используют прежние 6 px; это проверка сохранности прежней геометрии. Физическая процедура — [проверка чтения](../../lab/monitor_test/README.md#проверка-чтения-sync-кода).

Совместимость настоящего рендера проверяется неизменённым Android-декодером: `python3 lab/monitor_test/tests/motion_decoder_compat.py /absolute/path/to/frame.png 12345678 42`. Здесь `12345678` и `42` должны совпадать с кодом сохранённого PNG; `none` вместо ID ожидает отсутствие единственного валидного кода. Нужны JDK и кеш компилятора Kotlin 2.0.21 из обычной подготовки проекта; runner не редактирует Android и не заменяет device-тесты.

Регрессии ревью `664d52f`: `sync_check_smoke.mjs` проверяет повреждённый импорт → Стоп/естественное завершение → следующий запуск, ошибки анализа/обновления и сохранения с экспортом из памяти. Стандартный `civ01` с целью 40 px и sync 18 px завершается в Chrome на 1024×768, 1280×800, 1366×768 и 1920×1080; проверяются повтор сохранённых 40/18 после изменения полей, восстановление прежних 6 px и отказ невозможной геометрии без изменения настроек. `motion_scenario_test.mjs` проверяет те же разрешения при DPR 1/1.5/2, целое фото, размер/координаты объекта и отсутствие пересечений с углами, sync и Стоп. Свидетельства и ограничения: [проверка стенда](../../lab/monitor_test/tests/simple-motion-verification.md#исправления-ревью-664d52f).

Граница показа sync: `sync_check_end_test.mjs` загружает настоящие JS-модули в Node/VM с имитацией DOM/RAF и монотонных часов. Искусственные синхронные задержки хранения/анализа 500 мс проверяют порядок очистки, точный `end_ms`, совместимость журнала, строгий отказ кадру после снятия кода, Стоп/естественное завершение, раннюю отмену и восстановление обоих режимов после ошибок. Необязательный аргумент git ref позволяет повторить регрессию на старом коде: `node lab/monitor_test/tests/sync_check_end_test.mjs 6d41e8c` ожидаемо завершается с ошибкой. Это не браузерная проверка. Настоящий Chrome проверяется отдельно через `sync_check_smoke.mjs`, который также вводит синхронные задержки по 500 мс и использует общую имитированную шкалу для RAF и `performance.now`. Эти задержки не являются измерениями устройства. [Результаты](../../lab/monitor_test/tests/simple-motion-verification.md#граница-показа-sync-кода).

Полный `pytest lab/monitor_test/tests` включает прежние режимы галереи; отсутствие Node, браузера, Playwright или изображений приводит к пропуску браузерных проверок. Проверки импорта фактических Kotlin-файлов требуют заранее созданных JVM-фикстур, иначе соответствующие проверки пропускаются. Синтетические журналы и изображения проверяют вычисления и программную совместимость. Читаемость меток на 5×, JPEG телефона, реальные размеры в кадре и точность сопровождения принимают отдельно по [протоколу движения](../../lab/monitor_test/PROTOCOL.md#аппаратная-проверка-на-xiaomi).

Без ML-зависимостей можно проверить manifest стенда стандартной библиотекой Python:

```bash
python3 lab/monitor_test/build_manifest.py
```

Ожидается `manifest OK: 90 images`. Это валидация метаданных, не проверка наличия изображений или ручная приёмка. Для сохранённого диагностического потока (для прежнего JSON укажите путь к нему):

```bash
python3 ml/scripts/analyze_android_sessions.py /absolute/path/to/report.ndjson --output /tmp/drone-session-analysis.json
```

Анализатор проверяет целостность и пересчитывает производительность из `diagnostic_report` новых NDJSON либо прежнего корневого JSON, не выполняя infer. Для исторических и motion-NDJSON без полного отчёта сохраняется анализ интервалов. Пропуски и отсутствующий конец не позволяют считать запись полной; [контракт формата](../reference/data-model.md#поток-диагностической-сессии-dronecv-session-timeline-1). Ненулевой exit требует разбора errors/config_mismatches. Сопоставление потоков требует новых явных metadata, его условия — [ORT_THREAD_BENCHMARK](../ORT_THREAD_BENCHMARK.md).

`motion_calibration_real_smoke.mjs` проверяет настоящий JPEG Xiaomi и отдельно обозначенные синтетические варианты яркости и поворота, передачу найденных точек в гомографию через UI, пропуски, неоднозначность и ручную разметку. Для полного исходного журнала задайте `CORNER_NDJSON`; без него импортируется синтетический журнал с настоящим JPEG. [Происхождение, SHA-256 и ограничения](../../lab/monitor_test/tests/fixtures/xiaomi-corners.md). Node-набор калибровки дополнительно проверяет перспективу, размеры 16/20 px без наклона и 24/32/48/96 px с наклоном, равномерное и неравномерное затемнение, повреждения, обрезку, отдельные и вложенные дубликаты ID, повторные наблюдения, sync и случайные контрастные объекты. Минимум 16×16 не гарантирует устойчивость при повороте или перспективе.

`motion_repeat_recovery_smoke.mjs` использует настоящий Chrome и IndexedDB: завершённый A → начало B → сохранённая порция → принудительный обрыв renderer через CDP → новая вкладка того же профиля → повтор B. Отдельно проверяются обрыв первого запуска, отказ записи снимка в транзакции начала, Stop/Esc во время ожидающего начала и прежний несвязанный снимок. `motion_start_cleanup_smoke.mjs` внедряет отказ загрузки фото либо планирования и последующий отказ `exitFullscreen()`; проверяются обе причины, разблокировка Start/Repeat/sync и следующие запуски без reload. RAF-часы, ошибки и тестовые фотографии обозначены как синтетические; эти тесты не измеряют аппаратное поведение. `motion_report_v4_test.mjs` проверяет поздний захват также через настоящий `timelineImporter()`. [Воспроизведения и результаты](../../lab/monitor_test/tests/simple-motion-verification.md#три-замечания-к-3fef8c0-2026-11-16).

## Архив журналов

`DiagnosticArchiveTest` создаёт записи настоящими `DiagnosticFrames`/writer, запускает следующие сессии, пересоздаёт владельца архива, экспортирует прежние записи и вызывает Python-анализ с `--compare-threads` и JavaScript-импортёр. Проверяются ненулевые входные счётчики, копирование, прогрев/сборка, confidence, прерывание, квота и ошибка итогового отчёта. `TimelineWriterTest` проверяет обязательный итоговый отчёт при полной очереди. Оба теста требуют `python3` и `node` в PATH. Новые Kotlin-файлы для повторного чтения можно сохранить через `DRONECV_DIAGNOSTIC_FIXTURE_DIR=/tmp/dronecv-diagnostic-fixtures ./gradlew testDebugUnitTest --tests '*DiagnosticArchiveTest'`.

`gallery_import_race_test.mjs` проверяет порядок завершения чтения/SHA через управляемые Promise в настоящей странице, включая сохранение и экспорт выбранного наблюдения. Обёртка `test_gallery_import_races.py` требует Node/Chrome/Playwright, но использует собственный manifest и не требует скачанных фотографий.

Сравнение этапа 4 проверяется на синтетических данных. Из корня репозитория выполните `node --test lab/monitor_test/tests/stage4_comparison_test.mjs`. Для Chrome используйте `pytest lab/monitor_test/tests/test_gallery_import_races.py -k stage4_comparison_smoke` с заданными `CHROMIUM` и `PLAYWRIGHT_NODE_DIR`. Тесты охватывают A/A без журнала, A/B с объявленной сменой режима и несовместимой синхронизацией, неполную пару BA и сравнение двух прогонов «Пилот — 20 фото» с пропусками. Браузерная проверка использует временный манифест, открывает изменившийся снимок и проверяет сохранение отметки о лишней рамке рядом с правильной.

Регрессии этапа 4 проверяют SHA-256 APK при журнале с Git SHA, замену результата на «Рамок нет», обработку старой противоречивой отметки и сверку ответа с планом при пропуске снимка во втором прогоне.

### Приёмка ручного стенда (этап 5)

Запустите обе команды из корня репозитория.

```bash
node --test lab/monitor_test/tests/{motion_manual_test,motion_manual_transfer_test,motion_scenario_test,motion_ab_test,stage4_comparison_test}.mjs
CHROMIUM=/absolute/path/to/chromium PLAYWRIGHT_NODE_DIR=/absolute/path/to/playwright-parent \
  python3 lab/monitor_test/tests/test_gallery_import_races.py
```

`PLAYWRIGHT_NODE_DIR` должен содержать `node_modules/playwright`. Команда выводит числа по трём статусам «Прошло», «Упало» и «Не выполнялось». Код 0 означает, что все семь браузерных сценариев выполнены и прошли. Если Chromium не найден или указанный в `CHROMIUM` файл отсутствует, команда указывает причину, выводит семь невыполненных сценариев и возвращает код 1. Сценарии загружают локальную копию стенда с временным манифестом и синтетическими изображениями. Команды скачивания фотонабора и генерации рабочего `manifest.js` не требуются.

Node проверяет примеры из ручного протокола, отсутствие рамки только в плановой паузе, остановку до окна появления и сопоставимость при отсутствии журнала или различии условий. Chrome проверяет пустую форму после повтора, правку и восстановление после перезагрузки, экспорт из памяти при сбое IndexedDB, пересечение записи с анализом и импорт прежнего формата или конфликтующих ID. При правке расстояния в ручной форме проверяется сохранность исходных условий попытки и эталона. В набор также входят финализация, пределы истории, восстановление повтора после падения вкладки, очистка после ошибки запуска, отчёт A/A и A/B и сравнение пилота, включая обе регрессии масштаба. Проверки используют имитацию действий и журналов. Аппаратная приёмка выполняется отдельно. [Ручной протокол](../../lab/monitor_test/MANUAL_PROTOCOL.md#условные-примеры-заполнения).

`JournalArchiveTest` запускается общим `testDebugUnitTest`: оба типа, старые файлы, общий допуск, квоты числа/байтов, защита записи и финализации, выбор/копирование/закрытие экспорта, отмены, восстановление метаданных и аварийного `recording_failure`. Управляемые latch проверяют гонки без sleep. `managedMotionRefusesUnreservedOrCancelledStartsAndReleasesUnusedFiles` проверяет отказ старта без резервации и инвалидированную подготовку. [Ручные сценарии и ограничения архива](../guides/journal-archive.md#проверки); компиляция AndroidTest не заменяет проверку системного диалога на телефоне.

## GitHub Actions

Фактический [android-build.yml](../../.github/workflows/android-build.yml) запускается на push в `main` и на PR; concurrency отменяет прежний run той же ветки.

1. `assemble-debug`: Ubuntu, Temurin 17, Python 3.13; ONNX cache либо экспорт закреплённой модели, установка с проверкой SHA. Негативная проверка отвергает отсутствие/порчу model asset. Затем Gradle build/JVM/lint и проверка несжатой модели в APK.
2. `connected-tests`: после первого job скачивает те же app/test APK, запускает API 29 x86_64 Pixel 2 emulator с emulated back camera. [run-device-tests.sh](../../scripts/run-device-tests.sh) проверяет терминальное `OK (N tests)`, поскольку exit code одного `am instrument` недостаточен.

Артефакты: `app-debug`, `device-tests`, `verified-onnx-model`, `unit-test-results`, `connected-test-results`. Python tests, Markdown lint, ссылки и Mermaid в этом workflow не проверяются. Настройки branch protection/required checks не определены в файлах репозитория; наличие job не доказывает обязательность его успешности для merge. Требования PR — [CONTRIBUTING](../../CONTRIBUTING.md).

## Проверка документации

Для Markdown проверяйте UTF-8/LF, один H1, последовательность заголовков, языки fenced code, таблицы и существование локальных ссылок/якорей. По возможности проверяйте Mermaid настоящим parser и внешние URL; недоступный инструмент отражайте в отчёте. Не устанавливайте новые зависимости и не меняйте CI в рамках документационного задания без отдельного разрешения. Состав выполненной проверки и открытые замечания — [аудит](../documentation-audit.md).

## Независимый вход камеры

LiveFrameCaptureTest использует отдельный заблокированный backend: последующие входы завершают копирование/close, pending заменяется, инференсы остаются последовательными. Проверяются Stop/start до запуска pump и во время infer, порог во время copy, rejected worker, stale очередь и diagnostic tokens. CameraFramePoolTest проверяет лимит 3 массива/16 MiB, смену crop, повторный release и сохранность собственных пикселей. Это JVM-проверки управления ресурсами, не аппаратные показатели камеры.

Новый camera_input читается Python-анализатором вместе со старыми отчётами без этого поля. Для конкретного этапа допускается только локальная сборка/JVM/lint; assembleDebugAndroidTest не запускает Android-тесты. Поведение на телефоне и частота входа требуют отдельного последующего испытания по [контракту](../guides/camera-frame-ingress.md).

## Трекер камеры

GrayFrameTest и TrackingSessionTest проверяют владение пикселями, повороты, bounded историю, период YOLO, выбор той же цели, TTL и отклонение устаревшей коррекции. Fake VisualTracker в JVM проверяет управление, а не optical flow. OpenCvLkInstrumentedTest выполняет настоящий OpenCV LK на перемещаемом текстурном фрагменте и проверяет потерю при исчезновении/непригодной текстуре. Эти тесты входят в instrumentation CI. LiveOpenCvTrackingInstrumentedTest проверяет реальный LK через LiveController с задержанным тестовым ответом детектора и новыми изображениями. Камерный UI smoke проверяет настоящий YOLO, публикацию наблюдения и очистку после Stop; он не требует цели на сцене эмулятора и не доказывает сопровождение реального дрона. LiveTrackingIntegrationTest связывает оба исполнителя управляемыми очередями и проверяет публикацию, когда YOLO ещё не завершён, запоздавшую коррекцию, освобождение ресурсов и Stop/rebind. Python test_tracking_reports.py проверяет раздельные счётчики и интервалы. Приёмка на движущейся цели описана в [руководстве](../guides/visual-tracking-core.md).

### Время готовности и публикации

`LiveControllerTest` и `LiveTrackingIntegrationTest` используют настоящие контроллеры с управляемыми часами и очередями, тестовыми detector/tracker. Регрессии отделяют готовность, публикацию `signals` и `state`, задержку подготовки и отложенную сериализацию, поздний snapshot, reentrant Stop/start и вложенную смену источника. Произвольные sleep не используются. Новые optional timing fields и исторические журналы проверяются `test_timeline_analysis.py`, `test_target_signals.py`, `test_tracking_reports.py`, `timeline_import_test.mjs` и `yolo_pilot_timeline_test.mjs`. Границы описаны в [модели данных](../reference/data-model.md#границы-публикации-stateflow). Это проверки внутреннего состояния, без измерения отображения.

## Один автоматический поворот DJI

`./gradlew testDebugUnitTest --tests "*OneTurnControllerTest"` проверяет одноразовый контроллер без оборудования. Mac: `python3 -m unittest discover -s lab/one_turn_bridge -p "test_*.py" -v`; существующий CLI: `./gradlew -p lab/dji_rs_probe test`. Android-сборки и lint выполняются по обычному набору. [Физическая приёмка и границы](../guides/one-turn-yolo.md#проверки-и-граница-приёмки).


### Сквозной тест с симулятором DJI

```bash
./gradlew connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=ru.university.dronecv.camera.OneTurnDiagnosticInstrumentedTest
```

Тест отрисовывает штатную панель управления камеры на эмуляторе, выбирает A: YOLO, запускает диагностику и нажимает «Разрешить один поворот». Подставной детектор отдаёт заданные рамки, из которых живой контроллер строит `TargetSignal`. Подставной транспорт запоминает запросы в памяти и возвращает ответы с пометкой «Симулятор DJI». Тест сверяет видимый результат, `attempt_id` запроса и события завершённого NDJSON. Сценарии проверяют один запрос вправо, отбрасывание центра, отсутствия цели и кадра до нажатия, а также обработку ответов симулятора с ошибкой и тайм-аутом без повторной отправки.


Тот же класс запускает сценарий со штатным Android-бэкендом и моделью ONNX из APK. После прогрева одним чёрным кадром 640 × 480 тест нажимает кнопку и подаёт PNG, сохранённый из canvas браузерного стенда. В кадре 1280 × 800 справа показана фотография `civ20` Джоша Соренсона (CC0). Кадр сохранён на отметке 5650 мс по времени сценария с шириной цели 260 px. [Кадр стенда](../../app/src/androidTest/assets/one-turn/bench-right.png), [манифест фотографий](../../lab/monitor_test/manifest.json).

Тест использует порог 0,5 и штатные правила свежести. Время от передачи подготовленного кадра в `LiveController` до публикации `TargetSignal` измеряется по `elapsedRealtimeNanos`. Тест ставит метку кадру при подаче. В logcat с тегом `OneTurnOnnxTest` записываются время до публикации, центр и confidence результата модели. Если запрос отсутствует, тест сообщает причину из журнала или состояния контроллера. Ответ на отправленный запрос возвращает симулятор.


## Автоцентрирование в симуляторе DJI

В debug-сборке откройте «Камера», выберите **A: YOLO** в «Настройках», запустите детекцию и дождитесь обработанного кадра. В разделе «Диагностика» нажмите «Автоцентрирование» в блоке «Симуляция DJI». Сеанс создаёт отдельный NDJSON в архиве. Горизонтальное смещение вычисляется из центра текущей рамки YOLO как доля ширины обработанного кадра относительно его середины. Подтверждения команд выдаёт локальный симулятор. В тестовой сцене после подтверждения сдвигается фото, а модель заново вычисляет рамку.

Одновременно выполняется один шаг. Первый кадр должен быть снят после нажатия, последующие строго после завершения последнего шага. Возраст считается от метки экспозиции Camera2 REALTIME в момент обработки сигнала. Предел составляет 1 с. В предыдущем замере на Pixel Tablet время от экспозиции до публикации штатного YOLO составило 418 мс. Прежние 250 мс применялись к кадрам виртуальной мишени.

Сеанс завершается в зоне покоя ±10%, при отсутствии цели в свежем кадре, после 1,5 с ожидания свежего кадра или подтверждения шага, при смене источника или настроек, нажатии «Остановить симуляцию», закрытии «Диагностики» или паузе приложения. После пятого шага сеанс проверяет следующий свежий кадр и завершится по лимиту, если цель ещё вне зоны покоя. [Запись NDJSON](../reference/data-model.md#сеанс-автоцентрирования-в-симуляторе).

```bash
./gradlew connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=ru.university.dronecv.diagnostics.CenteringSimulationInstrumentedTest
```

Сквозной тест нажимает штатную кнопку на эмуляторе и подаёт снимок `civ20` со стенда через обычную очередь `LiveController`. После каждого подтверждения тест сдвигает снимок на 100 px и выполняет новый инференс той же ONNX-моделью из APK. Тест удерживает один результат до подтверждения шага и сверяет, что исходная метка кадра раньше подтверждения, а публикация позже. Такой кадр попадает в `frame_ignored` и не даёт команды. Прочие сценарии с подставными рамками проверяют старт у центра, лимит, тайм-ауты, смену источника, ручную остановку и потерю цели. Тесты сверяют UI и завершённый журнал из штатного архива.

## Чтение углов DJI через USB

```bash
./gradlew assembleDebug assembleDebugAndroidTest lintDebug
./gradlew connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=ru.university.dronecv.diagnostics.DjiAttitudePanelInstrumentedTest
./gradlew -p lab/dji_rs_probe test
```

Android-тесты нажимают ту же кнопку, что и в диагностике. Подставной порт проверяет порядок запроса версии и кадров CAN, углы, неверную CRC, отключение, отказ в USB-доступе и отсутствие адаптера. Тесты проверяют разные статусы и сохранение версии WeAct при отказе или тайм-ауте подтверждения CAN и при тайм-ауте ответа DJI. При отмене во время ожидания ответа проверяются одна команда закрытия CAN, однократное освобождение USB и отсутствие повтора запроса, в том числе при тайм-ауте закрытия. JVM-тесты утилиты Mac проверяют тот же протокол. [Проверка USB-разрешения и обмена с реальным подвесом на vivo](../guides/read-dji-attitude-vivo.md).

Кнопку «Один поворот DJI» тот же набор проверяет с подставным портом. Тесты сверяют кадры исходного чтения, единственной команды поворота и контрольного чтения, включая поворот через границу ±180° и замер 0,0°. После имитации отключения тест проверяет освобождение обоих портов, новый номер запроса углов и сохранение исходного yaw. При тайм-ауте ожидания адаптера или ответа через новый порт статус команды остаётся «Принята». [Порядок ручного поворота](../guides/read-dji-attitude-vivo.md#один-поворот-dji).

Тесты с двумя подставными WeAct проверяют возвращение исходного адаптера с новым `deviceName` и ожидание, когда остаётся подключён только второй. Во втором случае повторное чтение не начинается. Если серийных номеров нет и подключены одинаковые адаптеры, панель показывает «Не измерен» и причину. При быстром возврате одного WeAct без номера тест панели сверяет одну команду движения за нажатие. JVM-тесты `WeActUsbTest` проверяют выбор по номеру, отказ при дублировании номера, отказ после обнаружения второго WeAct и возврат одного адаптера без номера. При быстром возврате JVM-тест сверяет одно открытие нового порта и кадры контрольного чтения с новым номером.

При закрытии панели тест имитирует поздний ответ с исходным yaw. Он проверяет отсутствие команды движения, одну попытку закрытия CAN и однократное освобождение USB. При повторном открытии обе кнопки остаются недоступны до освобождения порта. Другие сценарии проверяют сохранение подтверждения при отмене и закрытие USB-порта, который открылся после отмены ожидания WeAct.

## Физическое автоцентрирование DJI

`PhysicalCenteringTest` проверяет последовательные шаги с подставным транспортом, экспозиции до и в момент завершения шага, свежесть результата, зону покоя, потерю цели и отсутствие повтора после тайм-аута. Сценарии физического режима в `DjiAttitudePanelInstrumentedTest` нажимают кнопку автоцентрирования и подключают подставной WeAct. Они проверяют разделение подтверждения DJI и стабилизации yaw, владение портом, тайм-аут подтверждения и переподключение только для контрольного чтения.

В трёх сценариях подставной WeAct удерживает ответ с исходным yaw, пока YOLO публикует более новые рамки. Тесты сверяют полный обмен CAN. Для центра ожидаются `centered` и ноль команд движения, для смены стороны одна команда в новом направлении, для рамки на прежней стороне одна команда в исходном направлении. JVM-тесты дополнительно проверяют границу экспозиции, потерю цели и сохранение номера шага при смене направления.

```bash
./gradlew assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug
adb devices -l
adb -s "$ANDROID_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s "$ANDROID_SERIAL" shell am instrument -w \
  -e class ru.university.dronecv.diagnostics.DjiAttitudePanelInstrumentedTest \
  ru.university.dronecv.test/androidx.test.runner.AndroidJUnitRunner
```

Подставной WeAct проверяет обмен и решения приложения. Фактический возраст результатов YOLO, углы и уменьшение смещения рамки измеряются отдельно на vivo, закреплённом на подвесе. [Порядок аппаратной приёмки](../guides/read-dji-attitude-vivo.md#автоцентрирование-dji-на-стенде-с-фотографией).

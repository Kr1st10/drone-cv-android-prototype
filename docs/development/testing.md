# Проверки приложения и инструментов

Инструкция для разработчика и тестировщика Android `0.5.2`. Команды выполняются из корня репозитория с JDK 17, SDK 35 и установленной моделью по [быстрому старту](../getting-started.md). Результаты текущего изменения находятся в PROJECT_STATE; [аудит](../documentation-audit.md) содержит исторические проверки подготовки документации. Этот раздел описывает воспроизводимые проверки.

## Локальная Android-сборка и JVM

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

## Выполнение device tests

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
node lab/monitor_test/tests/motion_journal_status_test.mjs
node lab/monitor_test/tests/motion_report_test.mjs
node lab/monitor_test/tests/center_error_test.mjs
node lab/monitor_test/tests/timeline_import_test.mjs
```

Первый набор проверяет фазы, единое время, геометрию области и скрытое продолжение маршрута. Второй использует синтетические изображения с перспективой, разными размерами, пропуском и повтором ID. Третий проверяет новый `motion-scenario-v4`, включая временные доли, очистку, сохранённую рамку, повторный захват, цензурирование и неопределённость часов. В него входят пустое состояние, начавшееся до скрытия, избыточный `clear`, поздняя очистка и отсутствие фактически показанного возвращения. `motion_journal_status_test.mjs` проверяет читаемость без JPEG/эталона, временное сопоставление без пространственных точек и совпадение границ часов с прежним анализатором. Старые IoU, ошибка центра и импорт timeline проверяются отдельно, без изменения критерия `motion-retention-v3`.

Для браузерных сценариев нужны локальные изображения, Chrome/Chromium и Playwright. Укажите каталог с `node_modules/playwright` в `PLAYWRIGHT_NODE_DIR`; запускайте Node из этого каталога, поскольку сценарии используют его для поиска пакета.

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

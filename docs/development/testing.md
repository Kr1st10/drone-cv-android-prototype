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
| `assembleDebugAndroidTest` | Компиляция [device tests](../../app/src/androidTest/java/ru/university/dronecv) | Не выполняет ни одного теста на устройстве |
| `lintDebug` | Статический Android lint | Не заменяет запуск UI/инференса |

Отчёты: `app/build/test-results/testDebugUnitTest/TEST-*.xml`, `app/build/reports/tests/testDebugUnitTest/index.html`, `app/build/reports/lint-results-debug.xml` и `.html`. APK и AndroidTest APK — в `app/build/outputs/apk/`.

## Выполнение device tests

Используйте своё тестовое устройство/эмулятор с задней камерой и подходящей ABI. Тесты меняют UI, ориентацию/foreground и работают с камерой; запускайте их, когда устройство доступно для испытаний. При нескольких подключениях проверьте целевое устройство в выводе Gradle; для однозначного запуска оставьте одну цель.

```bash
adb devices
./gradlew --no-daemon connectedDebugAndroidTest
```

Ожидайте успешный Gradle result и отчёт `app/build/reports/androidTests/connected/debug/index.html`; проверьте failures и skipped. [LiveCameraInstrumentedTest](../../app/src/androidTest/java/ru/university/dronecv/camera/LiveCameraInstrumentedTest.kt) проверяет реальный CameraX→ORT→UI, Stop/restart, потоки, zoom request, фон/ротацию/вкладки. Также есть decoder/EXIF, ORT, JSON и inventory tests. Camera tests используют assumptions при отсутствии hardware; сам зелёный итог без просмотра skipped не доказывает их выполнение.

Повороты эмулятора не доказывают оптику, полевую точность, нагрев и длительную работу Xiaomi. Ручные протоколы: [PHOTO_QA](../PHOTO_QA.md), [LIVE_QA](../LIVE_QA.md), [CAMERA_QA](../CAMERA_QA.md), [PERFORMANCE_QA](../PERFORMANCE_QA.md), [потоки ORT](../ORT_THREAD_BENCHMARK.md).

## Python и галерея

Изолированные проверки новых target-сигналов не требуют ML-библиотек или pytest:

```bash
python3 -m unittest discover -s ml/tests -p test_target_signals.py -v
```

В Android `TargetSignalTest` проверяет независимый выбор максимального confidence, пустой кадр, временные базы, invalidation и закрытие кадров. `TargetReportTest` и device JSON test `TargetSignalJsonInstrumentedTest` проверяют serializer, null и долю доступных меток. Синтетические рамки и часы проверяют контракт, но не являются аппаратными измерениями задержки. Python-тесты читают payload v1/v2 и отчёты без сигнала; ручные проверки — [задержка и координаты](../guides/latency-and-prediction.md).

В подготовленном Python-окружении с зависимостями [ML README](../../ml/README.md):

```bash
python -m pytest ml/tests -q
python -m pytest lab/monitor_test/tests -q
```

Это существующие тесты; они не запускают заново полный исследовательский экспорт/оценку качества. Просматривайте skipped и требования конкретных тестов. Gallery smoke требует Node, Chromium, Playwright в `PLAYWRIGHT_NODE_DIR` и 90 локальных изображений; отсутствие любого условия приводит к skip. Полные условия — [галерея](../../lab/monitor_test/README.md).

Без ML-зависимостей можно проверить manifest стенда стандартной библиотекой Python:

```bash
python3 lab/monitor_test/build_manifest.py
```

Ожидается `manifest OK: 90 images`. Это валидация метаданных, не проверка наличия изображений или ручная приёмка. Для сохранённых диагностических JSON (подставьте путь к своему отчёту):

```bash
python3 ml/scripts/analyze_android_sessions.py /absolute/path/to/report.json --output /tmp/drone-session-analysis.json
```

Анализатор пересчитывает агрегаты/проверяет целостность, не выполняя infer. Ненулевой exit требует разбора errors/config_mismatches. Сопоставление потоков требует новых явных metadata, его условия — [ORT_THREAD_BENCHMARK](../ORT_THREAD_BENCHMARK.md).

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

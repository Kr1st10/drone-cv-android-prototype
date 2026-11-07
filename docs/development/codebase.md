# Карта кода и точки изменений

Путеводитель для разработчика Android `0.5.2` на основе `acb3e9e`. Показывает место реализации функциональности и связанный тест. Подробные сигнатуры находятся в [справочнике контрактов](../reference/api.md).

## Android

Базовый пакет — `app/src/main/java/ru/university/dronecv/`. Gradle подключает только `:app`.

| Что изменить | Основные файлы | Что проверить |
|---|---|---|
| Вход, вкладки, сохранённые UI-настройки | [MainActivity](../../app/src/main/java/ru/university/dronecv/MainActivity.kt), [DroneApp](../../app/src/main/java/ru/university/dronecv/DroneApp.kt) | Стартовая вкладка Фото, ротация/смена режимов, сохранение порога/потоков |
| Фото: выбор, кнопки, отрисовка | [PhotoScreen](../../app/src/main/java/ru/university/dronecv/photo/PhotoScreen.kt), [PhotoGeometry](../../app/src/main/java/ru/university/dronecv/photo/PhotoGeometry.kt) | PhotoGeometryTest, PHOTO_QA |
| Фото: очереди/состояния/ресурсы | [PhotoController](../../app/src/main/java/ru/university/dronecv/photo/PhotoController.kt), [PhotoViewModel](../../app/src/main/java/ru/university/dronecv/photo/PhotoViewModel.kt), [AndroidPhotoBackend](../../app/src/main/java/ru/university/dronecv/photo/AndroidPhotoBackend.kt) | PhotoControllerTest, device decoder/EXIF tests |
| Камера: разрешение/ошибки | [CameraScreen](../../app/src/main/java/ru/university/dronecv/camera/CameraScreen.kt) | Отказ/настройки/отзыв при resume, LIVE_QA |
| Камера: binding/поворот/FOV | [CameraPreview](../../app/src/main/java/ru/university/dronecv/camera/CameraPreview.kt) | LiveCameraInstrumentedTest, CAMERA_QA на физическом сенсоре |
| Камера: analyzer и состояние | [LiveController](../../app/src/main/java/ru/university/dronecv/camera/LiveController.kt), [AndroidLiveBackend](../../app/src/main/java/ru/university/dronecv/camera/AndroidLiveBackend.kt) | LiveControllerTest, ThreadSwitchControllerTest, diagnostic token tests |
| Время экспозиции/пиксель текущего кадра | [TargetSignal](../../app/src/main/java/ru/university/dronecv/camera/TargetSignal.kt), CameraPreview, LiveController | TargetSignalTest, TargetReportTest, TargetSignalJsonInstrumentedTest; [ручная проверка](../guides/latency-and-prediction.md) |
| Конвертация/overlay | [RgbaFrameConverter](../../app/src/main/java/ru/university/dronecv/camera/RgbaFrameConverter.kt), [CameraGeometry](../../app/src/main/java/ru/university/dronecv/camera/CameraGeometry.kt), [LiveCameraContent](../../app/src/main/java/ru/university/dronecv/camera/LiveCameraContent.kt) | Crop/stride/rotation/channel/mapping tests и физическое совмещение |
| Независимый вход камеры | [LiveFrameCapture](../../app/src/main/java/ru/university/dronecv/camera/LiveFrameCapture.kt), [CameraFrameSnapshot](../../app/src/main/java/ru/university/dronecv/camera/CameraFrameSnapshot.kt), VisionWorker, AndroidFrameSnapshotter | LiveFrameCaptureTest, CameraFramePoolTest; [владение и границы этапа](../guides/camera-frame-ingress.md) |
| Экспериментальный трекер | [tracking](../../app/src/main/java/ru/university/dronecv/tracking) | GrayFrameTest, TrackingSessionTest, OpenCvLkInstrumentedTest; [ядро без подключения к камере](../guides/visual-tracking-core.md) |
| Камеры/зум/метаданные | [CameraCapabilities](../../app/src/main/java/ru/university/dronecv/camera/CameraCapabilities.kt), [CameraInventory](../../app/src/main/java/ru/university/dronecv/camera/CameraInventory.kt), [CameraInventoryPanel](../../app/src/main/java/ru/university/dronecv/camera/CameraInventoryPanel.kt) | CameraCapabilitiesTest, CameraInventoryInstrumentedTest, CAMERA_QA |
| Общая модель/сессия | [detection/onnx](../../app/src/main/java/ru/university/dronecv/detection/onnx), [DetectorWorker](../../app/src/main/java/ru/university/dronecv/detection/DetectorWorker.kt) | ModelSpecTest, OnnxParityTest, ThreadSessionManagerTest |
| Pre/postprocessing | [detection/yolo](../../app/src/main/java/ru/university/dronecv/detection/yolo) | LetterboxTest, PreprocessorTest, PostprocessorTest, Python parity |
| Диагностика/экспорт | [diagnostics](../../app/src/main/java/ru/university/dronecv/diagnostics) | DiagnosticStatisticsTest, DiagnosticControllerTest, DiagnosticJsonInstrumentedTest, Python analyzer tests |
| Тексты/тема/разрешения | [strings.xml](../../app/src/main/res/values/strings.xml), [Theme](../../app/src/main/java/ru/university/dronecv/ui/theme/Theme.kt), [manifest](../../app/src/main/AndroidManifest.xml) | Обе ориентации, большой шрифт, permission/export flow; фиксированная тёмная тема |

Конкурентный доступ/жизненный цикл описаны в [сценариях](../internals/detection-lifecycle.md), а пути тестов — в [тестировании](testing.md). При поиске реализации удобно начинать с `rg 'requestThreads|selectionEpoch' app/src`, подставив нужный символ.

## ML и лабораторные инструменты

Это отдельный Python/браузерный контур, не Gradle-модули Android. Существующие результаты остаются каноническими; ниже указаны точки входа вместо повторения чисел.

| Область | Код / описание |
|---|---|
| Текущая модель, экспорт, установка, проверка APK | [ML README](../../ml/README.md), [MODEL](../../ml/MODEL.md), [model_manifest](../../ml/model_manifest.json), `ml/scripts/fetch_and_export.py`, `install_android_model.py`, `verify_apk_model.py` |
| Python-эталон и контроль Kotlin parity | [drone_detector.py](../../ml/scripts/drone_detector.py), [make_android_reference.py](../../ml/scripts/make_android_reference.py), [OnnxParityTest](../../app/src/test/java/ru/university/dronecv/detection/OnnxParityTest.kt) |
| Анализ сохранённых Android JSON | [analyze_android_sessions.py](../../ml/scripts/analyze_android_sessions.py), [отчёт 5.2](../../ml/results/android/analysis52/REPORT.md); stdlib, без повторного инференса |
| Intake/provenance/review/group splits/frozen test | [ml/dataset45](../../ml/dataset45), [руководство](../../ml/results/dataset45/README.md), [протокол](../../ml/results/dataset45/PROTOCOL.md) |
| SAHI / разрешение / AOD | [SAHI](../../ml/results/sahi/REPORT.md), [разрешение](../../ml/results/resolution/REPORT.md), [independent](../../ml/results/independent/REPORT.md), [AOD audit](../../ml/results/aod_audit/REPORT.md); соответствующие `ml/scripts/*` |
| Подготовка обучения и эксперименты 6.2–6.5 | [training62](../../ml/results/training62/README.md), [DUT](../../ml/results/dut63/README.md), [real64](../../ml/results/real64/README.md), [data65](../../ml/results/data65/README.md) |
| Офлайн-стенд | [lab/monitor_test](../../lab/monitor_test/README.md): gallery.html, manifest.json, fetch_images.py, build_manifest.py, CSV и tests |

Изображения/веса находятся в исключённых каталогах. Не запускайте скачивание, экспорт, обучение и оценку всего датасета ради небольшого изменения документации. Кандидат обучения в каталоге результатов не означает смену Android-модели; источником её файла служит манифест.

## Конфигурация сборки и проверка карты

[settings.gradle.kts](../../settings.gradle.kts) задаёт repositories и `:app`; [Version Catalog](../../gradle/libs.versions.toml) — версии библиотек; [app/build.gradle.kts](../../app/build.gradle.kts) — SDK/ABI/BuildConfig/verifyDroneModel/unit-test classpath; [workflow](../../.github/workflows/android-build.yml) — проверки GitHub Actions. DI/codegen/OpenAPI/Room отсутствуют.

Перед изменением найдите места использования символа через `rg`, затем сверьте контракт и тесты. Наличие библиотеки в файле зависимостей само по себе не подтверждает готовую функцию. Порядок типовых правок — [руководство](../guides/common-tasks.md).

# Drone CV Android Prototype

Университетский проект компьютерного зрения: Android-приложение, которое в будущем будет
локально обнаруживать небольшие дроны нейросетью (YOLO) и выделять их рамками.
Целевое устройство — Xiaomi 17 Pro; на первом этапе тестируем на обычных Android-устройствах.

## Реализовано

- Kotlin + Jetpack Compose, один экран с полноэкранным видеопревью CameraX.
- Запрос разрешения `CAMERA`, экран объяснения, переход в настройки при «больше не спрашивать».
- Обработка ошибок: нет камеры, ошибка привязки, критические ошибки `CameraState`
  (с кнопкой «Повторить»), временные — «камера занята».
- Жизненный цикл: Preview привязан к `LifecycleOwner` (камера освобождается в фоне),
  разрешение перепроверяется при `onResume`.
- `OnnxDroneDetector` реализует `ObjectDetector`: YOLO11s, ONNX Runtime CPU, поворот/letterbox, NMS и нормализованные рамки.
- Детектор пока не подключён к экрану или CameraX. UI, галерея и live-инференс — следующий этап.

## Требования

- Android Studio Ladybug (2024.2) или новее, JDK 17
- Android SDK Platform 35; устройство/эмулятор Android 8.0+ (API 26) с камерой

Версии: AGP 8.7.3, Gradle 8.11.1, Kotlin 2.0.21, Compose BOM 2024.12.01, CameraX 1.4.1.

## Сборка

### Android Studio

1. `File → Open` → корень репозитория.
2. Дождаться Gradle Sync (Studio скачает Gradle 8.11.1 по `gradle/wrapper/gradle-wrapper.properties`).
3. Запустить конфигурацию `app` на устройстве.

### Командная строка

Wrapper Gradle 8.11.1 включён в репозиторий, дистрибутив проверяется по SHA-256.
Укажите `JAVA_HOME` (JDK 17), `ANDROID_HOME` или локальный `local.properties` с `sdk.dir=...`.
Установите SDK platform 35 и build-tools 35.0.0; примите лицензии SDK.

Модель сторонняя и не хранится в git. Получить **точный готовый ONNX** можно из artifact
`verified-onnx-model` успешного запуска workflow Android build этой ветки (GitHub → Actions).
Распакуйте файл в `ml/weights/yolo11s-drone-640.onnx`, затем:

```bash
python3 ml/scripts/install_android_model.py
./gradlew --no-daemon assembleDebug testDebugUnitTest
python3 ml/scripts/verify_apk_model.py app/build/outputs/apk/debug/app-debug.apk
```

Установщик принимает и внешний файл: `python3 ml/scripts/install_android_model.py --onnx /path/model.onnx`.
Для JVM-тестов положите тот же файл в `ml/weights/yolo11s-drone-640.onnx`.
Установка, Gradle и runtime проверяют SHA-256 из `ml/model_manifest.json`;
сборка без модели или с другим хешем завершается ошибкой. Проверка APK проверяет наличие,
хеш и отсутствие сжатия asset.

Если готового файла нет, воспроизведите существующий экспорт на **Linux x86_64, Python 3.13**
в отдельном venv (версии закреплены, см. `ml/README.md`):

```bash
python -m pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r ml/requirements.txt
python ml/scripts/fetch_and_export.py
python ml/scripts/install_android_model.py
```

CI использует этот путь только при отсутствии cache, затем всегда перепроверяет SHA-256,
негативные случаи отсутствующей/повреждённой модели, `assembleDebug`, `testDebugUnitTest` и модель в APK.
Отчёты unit-тестов, APK и проверенный ONNX сохраняются как artifacts.
Чистые Kotlin-тесты и smoke-тесты реального ORT-инференса обязательны;
два сравнения с Python требуют `ml/data/android_parity/` (см. `ml/scripts/make_android_reference.py`),
без этих локальных fixtures они явно пропускаются. Это не оценка точности и не проверка на телефоне.

APK: `app/build/outputs/apk/debug/app-debug.apk`. Отчёт: `app/build/reports/tests/testDebugUnitTest/index.html`.

## Структура

```
app/src/main/java/ru/university/dronecv/
├── MainActivity.kt            # точка входа, edge-to-edge, Compose
├── camera/CameraScreen.kt     # разрешение, состояния экрана, ошибки
├── camera/CameraPreview.kt    # PreviewView + ProcessCameraProvider + lifecycle
├── detection/ObjectDetector.kt# контракт детектора для этапа 2
└── ui/theme/Theme.kt
```

## Этап 2 (план)

- Добавить `ImageAnalysis` (STRATEGY_KEEP_ONLY_LATEST) и передавать кадры в `ObjectDetector`.
- Подключить существующий ONNX-детектор; ускорители — только после отдельных замеров.
- Отрисовка рамок поверх превью с учётом поворота и `FILL_CENTER`-масштабирования.
- Замер FPS/задержки на целевом устройстве.

# Drone CV Android Prototype

Университетский проект компьютерного зрения: Android-приложение, которое
локально обнаруживает дроны нейросетью YOLO11s на фотографиях и в видеопотоке CameraX.
Целевое устройство — Xiaomi 17 Pro; на первом этапе тестируем на обычных Android-устройствах.

## Реализовано

- Kotlin + Jetpack Compose, один экран с полноэкранным видеопревью CameraX.
- Запрос разрешения `CAMERA`, экран объяснения, переход в настройки при «больше не спрашивать».
- Обработка ошибок: нет камеры, ошибка привязки, критические ошибки `CameraState`
  (с кнопкой «Повторить»), временные — «камера занята».
- Жизненный цикл: Preview привязан к `LifecycleOwner` (камера освобождается в фоне),
  разрешение перепроверяется при `onResume`.
- `OnnxDroneDetector` реализует `ObjectDetector`: YOLO11s, ONNX Runtime CPU, поворот/letterbox, NMS и нормализованные рамки.
- Режим «Фото»: системный Photo Picker → фото с учётом EXIF → локальная YOLO11s → рамки, confidence и время инференса.
- Режим «Камера»: настоящий непрерывный локальный инференс, рамки/class/confidence, Start/Stop, confidence, FPS и тайминги.

## Распознавание фото (этап 2.3)

1. Откройте вкладку **Фото** → **Выбрать фото**. Разрешение на всю галерею не требуется.
2. После загрузки нажмите **Распознать**. Первый запуск включает загрузку модели и может быть дольше.
3. Рамки и confidence появятся на изображении; время внизу — только инференс ORT, без декодирования, загрузки модели и пред-/постобработки.
4. **Другое фото** доступно и во время обработки; запоздавший результат предыдущего снимка не появится. **Повторить** запускает новый инференс текущего фото.
5. Вкладка **Камера** отдельно запрашивает CAMERA и позволяет запустить живую детекцию.

Фото отображается целиком (Fit), без crop. Используется одна и та же геометрия для фото и рамок.
Для ограничения памяти декодируется копия с длинной стороной до 2048 px, без увеличения маленьких фото.
На API 26/27 используется subsampling степенью двойки, поэтому копия может быть меньше 2048 px.
EXIF-повороты/отражения применяются до инференса. Поворот экрана и смена вкладок сохраняют фото и результат;
после закрытия/перезапуска процесса снимок нужно выбрать заново. Анимированные изображения анализируются как один кадр.

[Чек-лист проверки на смартфоне](docs/PHOTO_QA.md).

## Живая детекция (0.4.0)

**Камера** → разрешить CAMERA → **Начать детекцию**. Порог confidence меняется слайдером;
**Остановить** очищает рамки и выключает analyzer, preview остаётся. При уходе в фон анализ
приостанавливается, модель освобождается на worker после native call. Возврат/поворот возобновляет
включённую детекцию. После смены вкладки камера запускается вручную.

Один ML-worker обслуживает фото и видео, без параллельного ORT. ImageAnalysis использует
KEEP_ONLY_LATEST и RGBA; crop читается прямо в переиспользуемый RGB-буфер без Bitmap.
Preview и анализ привязаны одним UseCaseGroup/ViewPort; поворот применяется в общей YOLO-предобработке.
Анализ предпочитает 640×480 (реальный размер согласует CameraX), модель остаётся 640×640 FP32.
ORT CPU: 2 intra-op потока, sequential, spinning отключён. Аппаратные ускорители не включены без замеров.

FPS считается по завершённым результатам, ORT и полный цикл показываются отдельно. Числа не задаются
заранее. Модель может ошибаться на птицах/самолётах и пропускать маленькие дроны; это детектор одного
класса, без трекинга. [Проверка на телефоне и значения метрик](docs/LIVE_QA.md).

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
Установите SDK platform 35 и build-tools 34.0.0; примите лицензии SDK.

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
Отчёты unit-тестов, APK и проверенный ONNX сохраняются как artifacts. Дополнительный job запускает
собранные APK на эмуляторе API 29 x86_64: decoder, настоящий ORT и CameraX UI/lifecycle tests.
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

## Следующие этапы

- Аппаратная приёмка по `docs/LIVE_QA.md`, замеры FPS/нагрева/памяти на целевом телефоне.
- Независимые реальные drone/negative сцены для оценки ошибок модели (см. RESEARCH.md).
- Сравнение CPU/XNNPACK/NNAPI и разрешения анализа после baseline-замеров.
- Трекинг/компенсация задержки и SAHI — отдельные исследования, если это оправдает реальная задача.

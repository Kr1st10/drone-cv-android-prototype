# Drone CV Android Prototype

Университетский проект компьютерного зрения: Android-приложение, которое в будущем будет
локально обнаруживать небольшие дроны нейросетью (YOLO) и выделять их рамками.
Целевое устройство — Xiaomi 17 Pro; на первом этапе тестируем на обычных Android-устройствах.

## Этап 1 (текущий)

- Kotlin + Jetpack Compose, один экран с полноэкранным видеопревью CameraX.
- Запрос разрешения `CAMERA`, экран объяснения, переход в настройки при «больше не спрашивать».
- Обработка ошибок: нет камеры, ошибка привязки, критические ошибки `CameraState`
  (с кнопкой «Повторить»), временные — «камера занята».
- Жизненный цикл: Preview привязан к `LifecycleOwner` (камера освобождается в фоне),
  разрешение перепроверяется при `onResume`.
- Интерфейс `ObjectDetector` (`detection/ObjectDetector.kt`) — только контракт, инференса нет.

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

`gradle-wrapper.jar` (бинарный файл) в репозиторий пока не добавлен. Один раз сгенерируйте wrapper
установленным Gradle (8.9+) и закоммитьте результат:

```bash
gradle wrapper --gradle-version 8.11.1
./gradlew assembleDebug
./gradlew installDebug   # установка на подключённое устройство
```

APK: `app/build/outputs/apk/debug/app-debug.apk`.

CI (GitHub Actions, `.github/workflows/android-build.yml`) собирает `assembleDebug` на каждый push/PR.

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
- Реализация YOLO (TFLite/LiteRT или ONNX Runtime) с GPU/NNAPI-делегатом.
- Отрисовка рамок поверх превью с учётом поворота и `FILL_CENTER`-масштабирования.
- Замер FPS/задержки на целевом устройстве.

# AGENTS.md — постоянные инструкции для агентов

## Проект
Университетский CV-проект: Android-приложение, которое в будущем будет **локально** (на устройстве)
обнаруживать небольшие дроны нейросетью (YOLO) и выделять их рамками на видеопревью.
Целевое устройство — Xiaomi 17 Pro; пока тестируем на обычных Android-устройствах.

## Архитектура и модули
Один модуль `:app`, один экран, без DI и сложных слоёв.
- `app/src/main/java/ru/university/dronecv/MainActivity.kt` — вход, edge-to-edge, Compose.
- `camera/CameraScreen.kt` — разрешение CAMERA, состояния экрана, ошибки.
- `camera/CameraPreview.kt` — `PreviewView` + `ProcessCameraProvider`, привязка к lifecycle.
- `detection/ObjectDetector.kt` — контракт детектора (`ObjectDetector`, `Detection`, `NormalizedBox`).
- `ui/theme/Theme.kt` — тема Material 3.
- Версии зависимостей — только в `gradle/libs.versions.toml`. CI — `.github/workflows/android-build.yml`.

## Технологии
Kotlin 2.0.21, Jetpack Compose (BOM 2024.12.01), CameraX 1.4.1, AGP 8.7.3, Gradle 8.11.1,
JDK 17 (Gradle 8.11 не запускается на JDK 25), compileSdk/targetSdk 35, minSdk 26.

## Команды
```bash
gradle wrapper --gradle-version 8.11.1   # один раз, пока gradle-wrapper.jar нет в репозитории
./gradlew assembleDebug                   # сборка APK -> app/build/outputs/apk/debug/
./gradlew installDebug                    # установка на устройство
./gradlew lint                            # статический анализ
```
Unit/инструментальных тестов пока нет. Нужен `local.properties` с `sdk.dir=...` (не коммитить).

## Правила изменений
1. **Перед работой читать `PROJECT_STATE.md`.** Сверять его с кодом и `git log` — ответы прошлых агентов не доказательство.
2. Делать только запрошенный этап. Не переписывать работающий код без необходимости; не создавать проект заново.
3. **Никаких фиктивных результатов CV**: не выдумывать обнаружения, рамки, метрики, FPS.
4. Не выдумывать результаты проверок. Разделять: локальная сборка / GitHub Actions / испытания на телефоне.
5. Не коммитить секреты (API-ключи, токены, `local.properties`, keystore).
6. Не добавлять лишние библиотеки; новые версии — через `libs.versions.toml`.
7. Работать в отдельной ветке, публиковать в GitHub небольшими логическими коммитами, вливать через PR в `main`.
8. **После каждого задания обновлять `PROJECT_STATE.md`** (что сделано, что проверено и как).

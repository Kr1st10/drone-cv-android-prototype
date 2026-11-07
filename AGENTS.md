# AGENTS.md — постоянные инструкции для агентов

## Проект
Университетский CV-проект: Android-приложение, которое **локально** (на устройстве)
обнаруживает дроны нейросетью (YOLO) и выделять их рамками на видеопревью.
Целевое устройство — Xiaomi 17 Pro; пока тестируем на обычных Android-устройствах.

## Архитектура и модули
Один модуль `:app`, режимы «Фото» и «Камера», без DI и сложных слоёв.
- `app/src/main/java/ru/university/dronecv/MainActivity.kt` — вход, edge-to-edge, Compose; `DroneApp.kt` — переключение режимов.
- `photo/` — Photo Picker, ограниченное декодирование/EXIF, Activity-scoped ViewModel и последовательный фоновый контроллер; общая геометрия Fit для фото и рамок.
- `camera/CameraScreen.kt` — разрешение CAMERA, состояния экрана, ошибки.
- `camera/CameraPreview.kt` — общий ViewPort Preview/ImageAnalysis, привязка к lifecycle и display rotation.
- `camera/LiveController.kt` — latest-only очередь собственных снимков, generation/source/pump tokens; `AndroidLiveBackend` читает CameraFrameSnapshot на общем ML-worker.
- `camera/TargetSignal.kt` — FrameStamp, выбор максимального confidence в текущем кадре и пиксельный центр; внутренний сигнал через StateFlow и диагностический JSON, без сопоставления объектов между кадрами.
- `tracking/` — экспериментальные LK/TrackingSession и bounded grayscale-история; пока не подключены к камере/сигналу. Контракт владения и дальнейшего подключения — `docs/guides/visual-tracking-core.md`.
- `detection/DetectorWorker.kt` — единственный process-wide ML-worker для фото и видео; ORT CPU sequential/2 потока без spinning.
- `detection/ObjectDetector.kt` — контракт детектора (`ObjectDetector`, `Detection`, `NormalizedBox`).
- `detection/onnx/` — Android-адаптер, проверка файла и общий JVM/Android ORT-движок; `detection/yolo/` — чистые Kotlin pre/postprocessing.
- `app/src/test/` — Kotlin/JVM-тесты; `app/src/androidTest/` — инструментальный smoke-тест.
- `ui/theme/Theme.kt` — тема Material 3.
- Версии зависимостей — только в `gradle/libs.versions.toml`. CI — `.github/workflows/android-build.yml`.

## Технологии
Kotlin 2.0.21, Jetpack Compose (BOM 2024.12.01), CameraX 1.4.1, AGP 8.7.3, Gradle 8.11.1,
JDK 17 (Gradle 8.11 не запускается на JDK 25), compileSdk/targetSdk 35, minSdk 26.

## Команды
```bash
python3 ml/scripts/install_android_model.py # после получения проверенного ONNX (README)
./gradlew assembleDebug testDebugUnitTest   # APK и JVM-тесты
./gradlew installDebug                    # установка на устройство
./gradlew lint                            # статический анализ
```
Для Android-специфичных изменений также `./gradlew assembleDebugAndroidTest lintDebug` (компиляция device-тестов не доказывает их выполнение).
JVM-тесты включают реальный ORT-инференс; модель обязательна. Python parity fixtures — отдельные локальные данные, их отсутствие видно как skipped. Инструментальные тесты требуют Android-устройства. Нужен `local.properties` с `sdk.dir=...` (не коммитить).

## Правила изменений
1. **Перед работой читать `PROJECT_STATE.md`.** Сверять его с кодом и `git log` — ответы прошлых агентов не доказательство.
2. Делать только запрошенный этап. Не переписывать работающий код без необходимости; не создавать проект заново.
3. **Никаких фиктивных результатов CV**: не выдумывать обнаружения, рамки, метрики, FPS.
4. Не выдумывать результаты проверок. Разделять: локальная сборка / GitHub Actions / испытания на телефоне.
5. Не коммитить секреты (API-ключи, токены, `local.properties`, keystore).
6. Не добавлять лишние библиотеки; новые версии — через `libs.versions.toml`.
7. Работать в отдельной ветке, публиковать в GitHub небольшими логическими коммитами, вливать через PR в `main`.
8. **После каждого задания обновлять `PROJECT_STATE.md`** (что сделано, что проверено и как).

## Контекст и эффективность
- `AGENTS.md` — постоянные правила, `PROJECT_STATE.md` — текущее проверенное состояние, `RESEARCH.md` — накопленные CV/ML-исследования.
- Читать только относящиеся к задаче файлы; не исследовать весь репозиторий без необходимости.
- Не повторять исследования, экспорт модели и оценку датасетов без конкретной технической причины.
- Перед реализацией проверить существующий код и выбрать минимальное связное изменение; сохранять архитектуру.
- Выполнять релевантные тесты и сборки; экономия контекста не оправдывает снижение корректности.
- Обновлять `AGENTS.md` только при изменении постоянных правил/архитектуры, `RESEARCH.md` — только при новых проверенных технических знаниях.
- Не дублировать большие отчёты и логи в контекстных документах.
- Делегировать независимое исследование или review только при реальной пользе от параллельной работы.
- Завершать задачу кратким отчётом: изменения, проверки, оставшиеся ограничения.

## Техническая документация

- Точка входа — `docs/index.md`. Перед изменениями читать только относящиеся к задаче разделы.
- При работе с документацией соблюдать применимые требования `docs/standards/std-doc-001.md` и `CONTRIBUTING.md`.
- Изменения поведения, архитектуры, контрактов, конфигурации и форматов данных сопровождать обновлением затронутых документов и диаграмм в том же PR.
- Сверять описания с итоговым кодом. Подробности хранить в одном каноническом разделе, из остальных давать ссылки.
- Проверять затронутые ссылки, примеры, команды и диаграммы доступными средствами; невыполненные проверки указывать в отчёте.
- Полный аудит документации выполнять отдельной задачей; небольшие изменения не должны вызывать переписывание всего комплекта.

## Владение ресурсами фото
- Фото и результаты живут в `PhotoViewModel` до уничтожения Activity; поворот и переключение режимов их сохраняют. `PhotoController.close()` инвалидирует запросы и закрывает детектор после завершения нативного вызова, не блокируя UI.
- Только один worker вызывает backend; одна ожидающая команда заменяется более новой. Проверять generation перед публикацией как результатов, так и ошибок.
- Не вызывать `Bitmap.recycle()` для изображения, уже переданного Compose/render thread. Такие Bitmap освобождаются GC после снятия ссылок; явно утилизировать можно только неопубликованные/временные Bitmap.
- В инференс передаётся тот же upright bitmap, который рисуется. Фото и рамки используют один `PhotoViewport`, без независимого округления размеров.

## Владение ресурсами живой камеры
- Preview и ImageAnalysis одной задней камеры привязываются одним UseCaseGroup с `PreviewView.viewPort`, FILL_CENTER. Рамки нормализованы относительно raw cropRect после `rotationDegrees`; повторно их не вращать. Изменение layout/display rotation требует нового ViewPort и invalidation.
- ImageAnalysis RGBA/KEEP_ONLY_LATEST копируется на VisionWorker. LiveFrameCapture закрывает ImageProxy в finally до передачи собственного snapshot в LiveController; ORT вызывается только на DetectorWorker. Один running и один заменяемый pending snapshot; CameraFramePool — максимум 3 ARGB-массива/16 MiB, без переиспользования до release. Заимствованный convert нельзя передавать асинхронно; copyInto пишет в leased-массив.
- До передачи LiveFrameCapture за ImageProxy отвечает CameraPreview: сбой метаданных/создания FrameStamp тоже должен закрыть кадр; после передачи повторно закрывать его нельзя.
- Stop/pause/error/rebind сначала инвалидируют результат; source token защищает и от callback старой активации. Старые ошибки тоже отбрасываются. Монотонная revision для UI expiry не совпадает с generation запросов.
- Снимать analyzer при остановке и очищать pending snapshot; инвалидировать epoch pump, чтобы старый pump не забрал новый кадр раньше release. Закрывать модель только на том же ML-worker после native call, ставить release до observable invalidation. Не ждать ORT и не применять shutdownNow на UI. Общие idle workers живут до завершения процесса; backend владеет ORT-сессией.

- Размер области превью не должен зависеть от появления/текста результата или статистики: иначе layout → ViewPort rebind → invalidate может сбрасывать каждый результат. Панель имеет фиксированный размер относительно доступного окна и прокручивается внутри.
- UI-коллекция StateFlow детектора явно использует Dispatchers.Main.immediate; unit controller остаётся Android-independent. Это также исключает перенос Compose test frame/layout на ML-worker через unconfined test continuation.
- Метки экспозиции вычитать только из `elapsedRealtimeNanos` и только при Camera2 timestamp source REALTIME; UNKNOWN даёт null с причиной, без подгонки смещения к `nanoTime`. FrameStamp и eventTime должны иметь согласованную базу; без eventTime сигналы отключены. При invalidation сбрасывать сигнал. Каждый кадр выбирает максимальный confidence независимо; отсутствие обнаружений публикует NO_TARGET с null-координатами и confidence.

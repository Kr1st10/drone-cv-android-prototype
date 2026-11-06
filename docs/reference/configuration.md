# Конфигурация и зависимости

Справочник для разработчика Android `0.5.2`. Приложение не читает `.env`, удалённую конфигурацию или пользовательский конфигурационный файл. Ниже разделены окружение сборки, настройки UI и параметры кода; изменение последних требует новой сборки.

## Версии и платформа

Канонические источники — [Version Catalog](../../gradle/libs.versions.toml), [app/build.gradle.kts](../../app/build.gradle.kts), [Wrapper](../../gradle/wrapper/gradle-wrapper.properties). Значения на дату проверки:

| Зависимость/параметр | Значение |
|---|---|
| Gradle / Android Gradle Plugin / Kotlin | 8.11.1 / 8.7.3 / 2.0.21 |
| Java source/target/JVM | 17 |
| minSdk / compileSdk / targetSdk | 26 / 35 / 35 |
| Compose BOM / Material 3 | 2024.12.01 / версия из BOM |
| CameraX / lifecycle / activity-compose | 1.4.1 / 2.8.7 / 1.9.3 |
| ONNX Runtime Android и JVM | 1.31.1 |
| Coroutines / ExifInterface / core-ktx | 1.8.1 / 1.3.7 / 1.15.0 |
| JUnit / AndroidX test ext / runner | 4.13.2 / 1.2.1 / 1.6.2 |
| applicationId / versionName / versionCode | `ru.university.dronecv` / `0.5.2` / `7` |
| ABI в APK | `arm64-v8a`, `x86_64` |

Для точного ML-экспорта версии закреплены отдельно в [ml/requirements.txt](../../ml/requirements.txt), включая Ultralytics, ONNX, ONNX Runtime, NumPy и OpenCV. PyTorch 2.6.0/torchvision 0.21.0 CPU устанавливаются отдельно согласно [ML README](../../ml/README.md). Наличие Python-библиотеки не означает её использование в Android.

## Окружение сборки и тестов

В таблицах «обяз.» означает условие использования, «по умолчанию» — значение проекта либо явно отсутствие заданного значения.

| Имя и назначение | Тип; обяз. | По умолчанию; допустимые значения | Пример | Влияние изменения |
|---|---|---|---|---|
| `JAVA_HOME`: Java для CLI | Путь; нужен доступный JDK 17 | В проекте не задан; каталог JDK с `bin/java` | `/opt/jdk-17` | Меняет JVM Gradle; версия также видна в `./gradlew --version` |
| `ANDROID_HOME`: SDK для CLI | Путь; если SDK не задан иначе | В проекте не задан; установленный Android SDK | `/opt/android-sdk` | Поиск SDK и инструментов |
| `local.properties` → `sdk.dir` | Путь; альтернатива определения SDK | Файл не коммитится; абсолютный путь SDK | `sdk.dir=/opt/android-sdk` | Локальная настройка Gradle; не передаётся в APK |
| `ANDROID_SERIAL`: выбор ADB-цели | Строка; при неоднозначном выборе | В проекте не задан; ID из `adb devices` | `emulator-5554` | Выбор устройства для команд ADB; при установке Gradle проверяйте целевой вывод задачи |
| `org.gradle.jvmargs`: память/кодировка Gradle | Строка; задана в проекте | `-Xmx2048m -Dfile.encoding=UTF-8` | То же значение | Ресурсы JVM сборки, не потоки ORT |
| `android.useAndroidX` | Boolean; задан | `true`; проект использует AndroidX | `true` | Переключение библиотечной инфраструктуры требует проверки сборки |
| `android.nonTransitiveRClass` | Boolean; задан | `true` | `true` | Генерация Android resource IDs |
| `kotlin.code.style` | Строка; задана | `official` | `official` | Соглашение стиля Kotlin; отдельного formatter task нет |

Три JVM-свойства unit-тестов устанавливает Gradle, это не настройки Android UI:

| Имя | Тип; обяз. | Значение проекта / допустимое значение | Пример | Влияние |
|---|---|---|---|---|
| `drone.model.path` | Путь; да для реального ORT | Абсолютный `ml/weights/yolo11s-drone-640.onnx`; проверенный ONNX | `/work/project/ml/weights/yolo11s-drone-640.onnx` | Файл JVM-инференса |
| `drone.model.sha256` | Строка; да | `android.onnx_sha256` из манифеста; 64 hex-символа | Значение из [манифеста](../../ml/model_manifest.json) | Проверка файла перед JVM-тестами |
| `drone.parity.dir` | Путь; для двух Python parity tests | Абсолютный `ml/data/android_parity` | `/work/project/ml/data/android_parity` | Без `reference.tsv` эти сравнения skipped |

Для галерейного smoke-теста `PLAYWRIGHT_NODE_DIR` — необязательный путь к каталогу с `node_modules/playwright` (по умолчанию текущий рабочий каталог). Пример: `/work/browser-tools`; влияет только на обнаружение Playwright тестом. Также нужны Node, Chromium и скачанные изображения; иначе тест пропускается.

## Модель и сборка APK

В [ml/model_manifest.json](../../ml/model_manifest.json) `android.asset_path` — обязательная строка пути asset, сейчас `models/yolo11s-drone-640.onnx`; `android.onnx_sha256` — обязательный SHA-256. Они генерируют `BuildConfig.DRONE_MODEL_ASSET` и `DRONE_MODEL_SHA256`. Значения не секретны. Для замены используйте [процедуру](../guides/common-tasks.md), а не локальную правку только BuildConfig.

`export.output_file` задаёт исходный ONNX для установщика (по умолчанию `ml/weights/yolo11s-drone-640.onnx`). Опция `--onnx` принимает другой существующий путь к файлу с тем же ожидаемым SHA. Точные source/export-параметры и контрольные суммы канонически описаны в [MODEL](../../ml/MODEL.md).

Сборка исключает 32-битные ABI и хранит `.onnx` без сжатия. Release в коде имеет `isMinifyEnabled=false`; signing config релиза не задана. Wrapper проверяет собственный дистрибутив по SHA-256, хранит cache в стандартном Gradle User Home и задаёт сетевой timeout 10000 мс. Эти параметры находятся в Wrapper properties, а не в runtime приложения.

## Настройки во время работы

| Параметр | Тип; обяз. | Начальное значение / диапазон | Пример | Влияние |
|---|---|---|---|---|
| Порог камеры | Float; UI всегда передаёт значение | `0.5`; UI `0.10..0.95`, контроллер принимает `0.01..1.0` | `0.5` = 50% | Новый порог инвалидирует старый результат, прерывает запись диагностики; значение сохраняется через `rememberSaveable` |
| Потоки камеры intra-op | Int; UI всегда задаёт | `2`; `1`, `2`, `4` | `1` | Пересоздаёт camera ORT-сессию при остановке; сохранение выбора после успешного применения |
| Зум | Float; запрос камеры | `1.0`; кнопки 1×/5× в пределах сообщённого zoom range | `5.0` | Rebind Preview+Analysis, прерывание диагностики; не гарантия оптики |
| Физическая камера | Nullable String | `null` (auto); только сообщённые устройством ID | ID из инвентаря | Rebind; при отказе попытка возврата к auto/1× |

В фото порог UI не настраивается: применяется `PostprocessConfig()` по умолчанию. Галерейное поле `appConf=25` — отдельная запись условий испытания и не меняет Android-приложение. В quick-режиме поле скрыто, в записи прогона порог равен null. Для сохранения реального порога включите advanced и заполните поле либо ведите условия отдельно.

## Параметры реализации

Эти значения не загружаются из окружения. При использовании программного интерфейса опции можно передать явно; изменение значений приложения требует правки кода и проверок.

| Имя / источник | Тип; значение по умолчанию | Допустимость / пример | Последствие |
|---|---|---|---|
| `YoloEngineOptions.intraOpThreads` | Int; `2` | `>0` задаёт число ORT threads; при `<=0` настройка не передаётся ORT; UI ограничен 1/2/4 | Меняет параллелизм внутри операторов |
| ORT inter-op / execution mode / spinning | `1` / `SEQUENTIAL` / `0` | Фиксированная настройка движка, provider CPU | Изменение — отдельный эксперимент |
| `PostprocessConfig.confidenceThreshold` | Float; `0.25` | `[0,1]`, например `0.5`; проверка `score > threshold` | Отбор кандидатов; фото и Python-эталон начинают с 25% |
| `iouThreshold` / `maxDetections` | Float `0.7` / Int `300` | `[0,1]` / `>0` | NMS подавляет при `IoU > threshold`, ограничивает число рамок |
| `PhotoDecodeSize.maxSide` | Int; `2048` px | `>0`, например 2048 | Ограничение декодирования, не размер входа YOLO |
| Анализ камеры | `640×480`, nearest lower then higher | Положительный размер, итог зависит от CameraX | Меняет доступные детали и стоимость конвертации |
| `DiagnosticFrames.capacity` | Int; `100000` | `>0` | Далее растёт `unstoredFrames`, сводки только по сохранённым кадрам |
| Период ресурсов / expiry UI | `5000` / `1500` мс | Фиксированные интервалы coroutine | Частота измерений / скрытие устаревших рамок |

Порог LiveController.maxAnalyzerAgeMs=250.0 (Double, finite, >=0) ограничивает подтверждённый возраст на входе, текущий возраст перед ORT и известное ожидание в очереди приложения. UNKNOWN не позволяет считать capture age, но ожидание очереди проверяется по nanoTime. CameraFramePool.maxBytes=16 MiB (Long, >0), максимум 3 ARGB-массива; нехватка слота/бюджета приводит к пропуску, без расширения лимита. Параметры заданы в коде и требуют сборки при изменении. [Контракт владения](../guides/camera-frame-ingress.md).

Результат изменений проверяйте [тестами](../development/testing.md) и аппаратными протоколами. Значения, влияющие на результат измерения, фиксируйте в отчёте; не сравнивайте несопоставимые сборки.

# Настройка и первый запуск

Инструкция для разработчика Android-приложения `0.5.1`. Команды рассчитаны на Bash/Zsh в macOS или Linux и выполняются из корня репозитория, если не указано иное. Исторические проверки подготовки документации перечислены в [аудите](documentation-audit.md); проверки текущего изменения — в PROJECT_STATE.

## Подготовить инструменты

Нужны Git, JDK 17, Android Studio либо готовый Android SDK, Python 3.11+ и Android Platform-Tools (`adb`). Тяжёлые ML-зависимости для сборки с готовым ONNX не требуются. Через SDK Manager установите Android SDK Platform 35, Build-Tools 34.0.0 и Platform-Tools, примите лицензии SDK. Не используйте JDK 25 с этим Gradle Wrapper.

В Android Studio откройте корень проекта и выберите JDK 17 для Gradle. Для CLI задайте реальные пути вместо примеров:

```bash
export JAVA_HOME="/absolute/path/to/jdk-17"
export ANDROID_HOME="/absolute/path/to/android-sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
java -version
python3 --version
adb version
./gradlew --version
```

`JAVA_HOME` указывает на каталог с `bin/java`; в macOS это может быть `.../Contents/Home`. Ожидаются Java 17, Python не ниже 3.11, Gradle 8.11.1. Wrapper и Gradle при необходимости загружают дистрибутив/зависимости.

Вместо `ANDROID_HOME` Gradle может использовать локальный `local.properties`. Если файл существует, сохраните остальные настройки. Пример содержимого:

```properties
sdk.dir=/absolute/path/to/android-sdk
```

Файл исключён из Git. Серверы, контейнеры, БД и `.env` для приложения не нужны. Точные версии и значения параметров находятся в [конфигурации](reference/configuration.md).

## Подготовить модель

Получите артефакт `verified-onnx-model` успешного запуска `Android build` в GitHub Actions этого репозитория. Распакуйте ONNX в `ml/weights/yolo11s-drone-640.onnx`. Одно название артефакта не подтверждает целостность; выполните:

```bash
python3 ml/scripts/install_android_model.py
```

Успех: `[install] OK`, размер 37 927 788 байт и совпадение SHA-256 с `android.onnx_sha256` в [манифесте](../ml/model_manifest.json). Скрипт копирует модель в исключённый из Git каталог assets. Внешний путь допустим через `--onnx /absolute/path/to/model.onnx`; для JVM-тестов файл всё равно требуется в `ml/weights/`.

Без готового артефакта используйте существующий экспорт в отдельном Linux x86_64 окружении с Python 3.13. Это запасной путь, в текущем документационном задании он не запускался:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r ml/requirements.txt
python ml/scripts/fetch_and_export.py
python ml/scripts/install_android_model.py
```

Перед созданием `.venv` убедитесь, что не перезаписываете своё окружение; не добавляйте его в Git. Происхождение и конфликт сведений о лицензии описаны в [ML README](../ml/README.md) и [карточке модели](../ml/MODEL.md). Различие SHA не исправляйте отключением проверки.

## Собрать и проверить APK

```bash
./gradlew --no-daemon assembleDebug testDebugUnitTest
python3 ml/scripts/verify_apk_model.py app/build/outputs/apk/debug/app-debug.apk
```

Ожидаются `BUILD SUCCESSFUL` и `APK model OK`. APK: `app/build/outputs/apk/debug/app-debug.apk`; отчёт JVM: `app/build/reports/tests/testDebugUnitTest/index.html`. Отсутствующая/повреждённая модель останавливает `preBuild`. Два сравнения с Python пропускаются без локальных parity fixtures; реальный ORT-инференс в остальных тестах обязателен.

Полный локальный набор команд приведён в [тестировании](development/testing.md). Сборка AndroidTest APK не означает выполнение тестов на устройстве.

## Установить и проверить интерфейс

Подключите своё тестовое устройство с USB-отладкой либо запустите эмулятор с задней камерой. Подтвердите отладку на телефоне. При нескольких устройствах выберите одно через `ANDROID_SERIAL` согласно [конфигурации](reference/configuration.md).

```bash
adb devices
./gradlew installDebug
adb shell am start -n ru.university.dronecv/.MainActivity
```

В `adb devices` выбранное устройство должно иметь состояние `device`; `unauthorized` требует подтверждения на телефоне. Пакет приложения — `ru.university.dronecv`.

1. На вкладке «Фото» выберите своё разрешённое к использованию изображение, нажмите «Распознать». Должен появиться результат либо сообщение об отсутствии обнаружений. Отмена Photo Picker сохраняет прежнее фото.
2. На вкладке «Камера» разрешите доступ, проверьте превью, нажмите «Начать детекцию» и дождитесь обработанного кадра. Первый вызов может включать загрузку модели.
3. Нажмите «Остановить»: рамки должны исчезнуть, превью остаётся. Рамка на произвольной сцене не обязательна и не подтверждает точность модели.

Это инструкция ручной проверки, а не заявление о её выполнении в текущей среде. Детальные [фото](PHOTO_QA.md) и [камера](LIVE_QA.md) протоколы охватывают поворот, фон и реальные сцены.

## Остановка и очистка

Остановите детекцию кнопкой приложения. Перед завершением процесса экспортируйте нужный диагностический отчёт. Для выбранного тестового устройства можно завершить процесс:

```bash
adb shell am force-stop ru.university.dronecv
```

Команда не удаляет пакет и файлы, но теряет фото/отчёт в памяти. Дополнительные серверы после запуска не остаются. Необязательная команда `./gradlew clean` удаляет результаты Android-сборки; сначала сохраните нужный APK и отчёты из `app/build/`. Очистка данных или удаление приложения для обычного старта не требуются.

## Если запуск не удался

Неверная Java, `SDK location not found`, `Model missing`, несовпадение SHA и отказ установки разобраны в [runbook](operations/runbook.md). Для разбора сохраните команду, Git SHA, версию Java/SDK и ошибку; перед публикацией журнала удалите чувствительные данные.

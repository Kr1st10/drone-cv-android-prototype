# Интеграции и границы доступа

Справочник для разработчика и сопровождающего. Разделяет взаимодействия Android-приложения и инструментов компьютера; относится к базе `acb3e9e`.

## Android во время работы

| Граница | Кто вызывает / контракт | Доступ и ошибки |
|---|---|---|
| Photo Picker → ContentResolver | [PhotoScreen](../../app/src/main/java/ru/university/dronecv/photo/PhotoScreen.kt), [AndroidPhotoBackend](../../app/src/main/java/ru/university/dronecv/photo/AndroidPhotoBackend.kt); URI выбранного изображения | Нет запроса доступа ко всей галерее; приложение читает выбранный URI, не сохраняет его persistent grant. Provider может отозвать доступ/не открыть поток; SecurityException отображается как ACCESS |
| CameraX lifecycle / Camera2 interop | [CameraPreview](../../app/src/main/java/ru/university/dronecv/camera/CameraPreview.kt); задняя камера, Preview+Analysis | Нужен CAMERA runtime permission; проверяется при resume. Critical/recoverable ошибки разделены; прямой physical ID/5× могут быть недоступны |
| ONNX Runtime JNI | [YoloOnnxEngine](../../app/src/main/java/ru/university/dronecv/detection/onnx/YoloOnnxEngine.kt) | Локальная CPU-сессия, без NNAPI/XNNPACK/QNN-конфигурации; не сетевой сервис. Неверные модель/тензоры/ORT ведут к ошибке |
| Assets → приватная файловая копия | [ModelFiles](../../app/src/main/java/ru/university/dronecv/detection/onnx/ModelFiles.kt) | Проверка SHA и атомарная установка; файл находится в `noBackupFilesDir`, повреждённая копия переустанавливается из assets |
| Debug / PowerManager / BatteryManager | [DiagnosticViewModel](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticViewModel.kt) | PSS процесса, thermal status с API 29 и battery broadcast; недоступные значения null, без root |
| CreateDocument → ContentResolver | [DiagnosticPanel](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticPanel.kt), [CameraInventoryPanel](../../app/src/main/java/ru/university/dronecv/camera/CameraInventoryPanel.kt) | Пользователь выбирает файл; запись JSON в фоне. Нет report/отмена выбора — нет экспорта; отказ провайдера выводится в UI |

Собственный сетевой клиент, учётная запись, аутентификация/авторизация, push-уведомления, брокер сообщений и серверный cache в приложении отсутствуют (`N/A`). В [манифесте](../../app/src/main/AndroidManifest.xml) нет INTERNET. Это не обещание отсутствия сети у системного Photo Picker или выбранного провайдера документов: они могут использовать облако независимо от приложения.

В экспорт производительности не включены изображения, URI, рамки и координаты цели. Он содержит модель телефона, Android, время, параметры модели и ресурсные пробы; перед публикацией просмотрите эти данные и свободный текст ошибок. Файлы, записанные провайдером, пользователь хранит и удаляет самостоятельно.

## Компьютер сборки и исследования

| Инструмент | Внешние ресурсы | Место результата и ограничения |
|---|---|---|
| Gradle Wrapper / dependency resolution | Gradle distribution, Google Maven, Maven Central, Plugin Portal из [settings](../../settings.gradle.kts) | Локальные Gradle caches; это сеть компьютера сборки, не inference на телефоне |
| `fetch_and_export.py` | Источник checkpoint с закреплённой ревизией и SHA в [манифесте](../../ml/model_manifest.json) | `ml/weights/`, export metadata; Python-экспорт не включён в APK. Происхождение/лицензия — [MODEL](../../ml/MODEL.md) |
| GitHub Actions | Cache ONNX, сборка, artifacts | [Workflow](../../.github/workflows/android-build.yml); файл модели повторно проверяется, cache не заменяет SHA |
| `ml/scripts/*`, `ml/dataset45/` | Исследовательские источники конкретных наборов | Локальные изображения/веса не публикуются автоматически; права/splits/метрики описаны в соответствующих [исследованиях](../development/codebase.md#ml-и-лабораторные-инструменты) |
| Галерея `fetch_images.py` | Wikimedia URLs и контрольные суммы из manifest | Скачивание с проверками, затем галерея работает офлайн. Обязанности атрибуции и ограничения рамок — [README стенда](../../lab/monitor_test/README.md) |

Зависимости Android закрепляются через Version Catalog; экспериментальные Python-зависимости — отдельно. Не переносите условия CPU Python или другого телефона на Xiaomi 17 Pro. У приложения нет реализованного подключения DJI/CAN, отправителя координат и runtime-трекера; `dut63_tracking.py` подготавливает исследовательскую выборку.

## Проверка и ограничения

Границы доступа сверяются по manifest, ActivityResult contracts и вызовам ContentResolver/CameraX. Тесты покрывают часть ошибок, файловую целостность и JSON, но не поведение каждого OEM/провайдера. Проверьте разрешения и экспорт на своём устройстве по [протоколам](../index.md#сохранённые-протоколы-и-исследования). Политика раскрытия и пробелы приватного канала — [SECURITY](../../SECURITY.md).

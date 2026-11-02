# PROJECT_STATE.md

_Обновлено: 2026-11-02. Живая детекция, ветка `feature/live-drone-detection`._

## База и версия

- Проверен GitHub PR #6: **MERGED**, 2026-11-02 11:01:54 UTC, merge `6bbec974f19d1217a70408fb1f953370b93287ed`.
  Свежая `origin/main` содержит фото-режим; рабочая ветка создана от неё, исходная фото-ветка сохранена.
- Версия 0.4.0 / code 4. Существующий YOLO11s ONNX FP32 640×640 и SHA-256 сохранены, нового экспорта/
  обучения/оценки датасетов нет. Геометрия и postprocessing фото не менялись.

## Реализовано

- Настоящий CameraX ImageAnalysis → RGBA crop → прежний YOLO11s ORT → нормализованные upright рамки,
  `drone`/confidence поверх PreviewView. Никаких фиктивных обнаружений/статистики.
- Preview/ImageAnalysis объединены общим FILL_CENTER ViewPort. При layout/display rotation меняется binding,
  старые результаты инвалидируются; поддерживаются оба landscape-направления, в том числе без recreation.
- Start/Stop, confidence 10–95% (по умолчанию 50%), FPS завершённых результатов, ORT и полный цикл,
  число кадров и фактический размер crop. Порог сохраняется при повороте/смене вкладки. Портрет: панель снизу, альбом: сбоку; панель прокручивается.
- Один process-wide ML-worker для фото/видео, KEEP_ONLY_LATEST, синхронный analyzer без второй очереди.
  ImageProxy закрывается в finally на всех путях. RGBA читается построчно в переиспользуемые буферы
  без Bitmap; поворот совмещён с прежним letterbox. Анализ предпочитает 640×480 с fallback CameraX.
- CPU ORT: 2 intra-op/1 inter-op, sequential, spinning выключен; это ограниченная baseline-конфигурация,
  оптимальная скорость на целевом телефоне ещё не подтверждена. Ускорители не включались без замеров.
- Stop/pause/смена вкладки/ошибки/resize очищают старые ответы и ошибки. Generation/source tokens учитывают
  callback старого binding/активации; монотонная UI revision защищает expiry. При Stop снимается analyzer,
  preview остаётся; при паузе ORT закрывается на worker после native call, без ожидания на UI.
- Возврат/поворот восстанавливают включённую детекцию; после смены вкладки запуск камеры ручной.
  Если камера перестала поставлять результаты, рамки и текущие тайминги скрываются через 1.5 с.
- Фото сохраняется в прежнем Activity ViewModel, включая результат при повороте/смене режима;
  общая очередь исключает параллельный ORT и при быстром переключении вкладок.
- CI дополнен API 29 x86_64 emulator job: запускает уже собранные app/test APK, включая настоящий UI-путь
  камеры, Stop/restart, фон/возврат, recreation, оба landscape-направления и прежние decoder/EXIF/ORT тесты.

## Подтверждённые проверки

- Локальные JVM-тесты: **98 tests, 96 passed, 2 skipped**, 0 errors/failures. Только два отсутствующих
  Python parity fixtures пропущены; настоящий JVM ORT-инференс выполнен. 31 новый тест камеры:
  crop/stride/channels/rotation, mapping, stale results/errors, source/threshold, close ownership, FPS/expiry.
- `./gradlew --no-daemon assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug` — BUILD SUCCESSFUL
  на macOS arm64, JDK 17, SDK 35. Дополнительный empty-result regression test также passed. Lint: 0 ошибок,
  37 предупреждений о версиях зависимостей/target SDK/существующем backup manifest, 0 information.
  Локальная компиляция AndroidTest отделена от фактического CI emulator run ниже.
- [CI run 41439862685](https://github.com/Kr1st10/drone-cv-android-prototype/actions/runs/41439862685), код `478f2b7`:
  **assemble-debug + connected-tests passed**. На API 29 x86_64 Pixel 2 emulator: **9/9 Android tests passed,
  0 skipped**, `OK (9 tests)`, 112.011 с. Включены настоящий CameraX→ORT→UI (≥3 последовательных результатов),
  confidence/сохранение порога, Stop/restart/смена вкладки, фон/возврат, recreation и обе landscape-ориентации;
  также 3 ORT smoke tests и 4 photo decoder/EXIF/ORT tests. Модель взята из существующего проверенного cache.
- Первый emulator run обнаружил layout/thread regression. UI collection закреплена на Main, размер панели
  стабилен относительно окна, добавлен непрерывный regression. Повторный run выше passed без layout crash;
  bind-log показывает ожидаемые переходы `1080×734/rotation 0` → `1164×753/rotation 1/3`.
- PR: [#7](https://github.com/Kr1st10/drone-cv-android-prototype/pull/7), не объединён. Последующие изменения
  после `478f2b7` относятся к фиксации результатов в документации; актуальный статус head — в checks PR.
- `verify_apk_model.py`: модель несжатая, 37 927 788 байт, SHA-256
  `b4867481a3b3277f7b17e69b7b45077567d6929157e72dd5d48542dd34f19eb7`.
- `adb devices -l` пуст, локально нет emulator/system image. Физический телефон не запускался.

## Ограничения и следующий шаг

- Нужна аппаратная приёмка по [docs/LIVE_QA.md](docs/LIVE_QA.md): совмещение рамок, camera permission/errors,
  OEM фон/блокировка/возврат, multi-window/шрифт, 10–15 минут памяти/нагрева и FPS на конкретном телефоне.
  Реальные FPS/задержки телефона пока не заявляются. Эмулятор не доказывает эти свойства.
- Рамки относятся к последнему обработанному кадру, при движении возможен lag; трекинга/компенсации нет.
  Уменьшение camera input до ~VGA может ухудшать малые объекты; влияние требует независимых реальных сцен.
- Ложные срабатывания на птицах/самолётах, слабый recall малых дронов и лицензия весов прежние: RESEARCH.md.
  SAHI, обучение, DJI/CAN/угловые координаты вне этого этапа.
- На следующем шаге review отдельного PR и ручная QA, затем baseline и сравнение CPU/XNNPACK/NNAPI.
  PR самостоятельно не объединять.

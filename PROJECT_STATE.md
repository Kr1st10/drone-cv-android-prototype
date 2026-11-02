# PROJECT_STATE.md

_Обновлено: 2026-11-02. Исследование SAHI (этап 4.1), ветка `research/sahi-4.1` от `main` @ `95e907e`._

## Этап 4.1 — исследование SAHI (2026-11-02, Draft PR #8)

- Только Python: `ml/scripts/sahi_experiment.py`, `sahi_examples.py`, тесты `ml/tests/test_sahi_merge.py`,
  результаты `ml/results/sahi/` (REPORT.md, REPORT_TABLES.md, summary.json, examples.json, subset.json, pip_freeze.txt).
  Android, CameraX, модель и экспорт не менялись; `sahi==0.14.0` добавлен только в `ml/requirements.txt`.
- Проверено в Linux sandbox (Xeon 2 vCPU, Python 3.13.15, ORT 1.31.1 CPU): повторный экспорт дал прежний ONNX SHA-256
  `b4867481…`; `python -m pytest ml/tests -q` — **16 passed**; полный прогон 560 изображений × 5 режимов × 2 порога.
- Итог: слайс 416 + full-frame — R 0.755 → 0.812 при P 0.934 (conf 0.5, 383 GT, не независимый набор), но
  негативы с ложной детекцией 37 → 60 (hard) и 17 → 37 (random) из 100, время ×4.9 на CPU. SAHI в Android не внедряется.
- Не выполнено: независимые снимки с телефона, замеры на телефоне, высокое разрешение, Android-реализация (вне этапа).
- PR #7 к этому моменту уже влит в `main` (merge-коммит `95e907e`); ниже — состояние живой детекции без изменений.

## Локальная интеграция и проверка на телефоне — 2026-11-02

- В локальную ветку `codex/live-video-detection` подключена существующая реализация PR #7, код `f7c9dfc`; версия 0.4.0 / code 4. Модель, экспорт и датасеты сохранены.
- На macOS arm64 с Temurin 17.0.21 и Android SDK 35 / Build-Tools 34.0.0 выполнены `assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug` — BUILD SUCCESSFUL. JVM: 98 tests, 96 passed, 2 skipped (отсутствуют только Python parity fixtures). Lint: 0 ошибок, 44 предупреждения версий зависимостей/target SDK и прежнего backup manifest.
- APK установлен на физический телефон `2602EPTC0G`, Android API 36, arm64-v8a. Все 9 Android-тестов passed, 0 skipped, `OK (9 tests)`, 18.317 с. Проверены настоящий CameraX → ORT → UI с несколькими последовательными кадрами, confidence, Stop/restart, смена вкладки, фон/возврат, recreation и обе альбомные ориентации, а также ORT и photo decoder/EXIF.
- `verify_apk_model.py` подтвердил ожидаемую несжатую модель в APK. APK: 124 822 782 байта, SHA-256 `b84bcf8060a68dd6c1ea9ae4887e00503af92fad287d632d382b86b95c729c81`. Временный APK тестов после проверки удалён; основное приложение оставлено установленным и запущенным.
- Это локальные проверки физического телефона; результаты прежнего CI указаны отдельно ниже. Полная ручная приёмка на реальных дронах, физическое совмещение рамок и длительные замеры FPS/нагрева ещё требуются по `docs/LIVE_QA.md`. PR #7 не объединён.

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
  после `478f2b7` меняют документацию и исключают двойной push/PR запуск CI (push только main, все PR проверяются).
  Код приложения/тестов не меняется; актуальный статус head — в checks PR.
- `verify_apk_model.py`: модель несжатая, 37 927 788 байт, SHA-256
  `b4867481a3b3277f7b17e69b7b45077567d6929157e72dd5d48542dd34f19eb7`.

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

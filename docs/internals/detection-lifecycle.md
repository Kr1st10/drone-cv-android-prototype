# Детекция и жизненный цикл

Описание для разработчика, меняющего обработку фото, камеры или диагностики. Применяется к текущим контроллерам; координаты и границы измерений вынесены в [потоки данных](../architecture/data-flow.md).

## Содержание

- [Выбор и распознавание фото](#выбор-и-распознавание-фото)
- [Кадры живой камеры](#кадры-живой-камеры)
- [Потоки ORT и камеры](#потоки-ort-и-камеры)
- [Диагностическая сессия](#диагностическая-сессия)
- [Ошибки и инварианты](#ошибки-и-инварианты)

## Выбор и распознавание фото

Сценарий запускается из [PhotoScreen](../../app/src/main/java/ru/university/dronecv/photo/PhotoScreen.kt). Photo Picker возвращает URI только выбранного изображения; отмена не вызывает `select()` и сохраняет состояние. Точка входа — `PhotoViewModel.select(String)`, после загрузки пользователь вызывает `recognize()`.

```mermaid
sequenceDiagram
    actor U as Пользователь
    participant UI as PhotoScreen / ViewModel
    participant C as PhotoController
    participant W as DetectorWorker
    participant B as AndroidPhotoBackend
    participant E as OnnxDroneDetector
    U->>UI: Выбрать фото (URI)
    UI->>C: select(uri)
    C-->>UI: LOADING, новая generation
    C->>W: Команда Load (conflated channel)
    W->>B: load(uri)
    B-->>C: Upright Bitmap
    alt Запрос актуален
        C-->>UI: READY с изображением
    else Выбрано другое фото / close
        C->>B: discard(неопубликованный bitmap)
    end
    U->>UI: Распознать
    UI->>C: recognize()
    C-->>UI: RUNNING
    C->>W: Команда Infer
    W->>B: infer(тот же bitmap)
    B->>E: create при необходимости; detectDetailed(bitmap, 0)
    E-->>B: YoloResult
    B-->>C: PhotoInference
    C-->>UI: DETECTIONS / EMPTY, если generation актуальна
```

Рисунок 3. Обработка фото. Стрелки к worker обозначают исполнение команд; контроллер не прерывает начавшийся нативный вызов. Ошибки публикуются только для текущей generation.

[PhotoController](../../app/src/main/java/ru/university/dronecv/photo/PhotoController.kt) имеет одну выполняемую и одну ожидающую команду (`Channel.CONFLATED`). Новая ожидающая команда заменяет прежнюю. `select()` увеличивает generation, снимает старое фото/результат из состояния и ставит загрузку. `recognize()` доступен при наличии изображения и отсутствии текущего `RUNNING`; результат/ошибка прошлого запроса не могут заменить новое фото.

[AndroidPhotoBackend](../../app/src/main/java/ru/university/dronecv/photo/AndroidPhotoBackend.kt) читает URI через `ContentResolver`. На API 28+ использует software `ImageDecoder`, на API 26/27 — bounds pass, subsampling и матрицу всех восьми EXIF-ориентаций. Кадр ограничен по размеру, приведён к sRGB/ARGB; прозрачность наложена на чёрный фон. В инференс передаётся тот же upright bitmap, который рисует UI.

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> LOADING: select
    LOADING --> LOADING: новый select
    LOADING --> READY: load принят
    LOADING --> ERROR: актуальная ошибка загрузки
    READY --> RUNNING: recognize
    RUNNING --> DETECTIONS: непустой результат
    RUNNING --> EMPTY: пустой результат
    RUNNING --> ERROR: актуальная ошибка infer
    RUNNING --> LOADING: select
    DETECTIONS --> RUNNING: recognize
    EMPTY --> RUNNING: recognize
    ERROR --> RUNNING: recognize, если есть image
    READY --> LOADING: select
    DETECTIONS --> LOADING: select
    EMPTY --> LOADING: select
    ERROR --> LOADING: select
```

Рисунок 4. `PhotoPhase`. `close()` из любой фазы очищает состояние до IDLE и закрывает контроллер для новых запросов; отдельной фазы CLOSED в enum нет. Ошибка загрузки оставляет состояние без изображения, ошибка infer сохраняет его для повтора.

Activity-scoped [PhotoViewModel](../../app/src/main/java/ru/university/dronecv/photo/PhotoViewModel.kt) удерживает фото и результат при ротации/переключении вкладок. `onCleared()` вызывает неблокирующий `close()`: generation инвалидируется, канал/scope отменяются, `backend.close()` выполняется в `finally` worker после окончания нативного вызова. Опубликованный Compose bitmap не recycle-ится вручную; его освобождает GC после снятия ссылок. Явный `discard()` допустим только для изображения, которое не публиковалось.

## Кадры живой камеры

Сценарий начинается после выдачи разрешения в [CameraScreen](../../app/src/main/java/ru/university/dronecv/camera/CameraScreen.kt), успешной привязки, `RESUMED`, потока превью и пользовательского запуска. [CameraPreview](../../app/src/main/java/ru/university/dronecv/camera/CameraPreview.kt) создаёт Preview/ImageAnalysis в одном `UseCaseGroup` с ViewPort от PreviewView. Анализ предпочитает 640×480 с fallback; реальный размер выбирает CameraX.

```mermaid
sequenceDiagram
    participant C as CameraX
    participant V as VisionWorker
    participant M as DetectorWorker
    participant U as Compose
    C->>V: ImageProxy, source, FrameStamp
    V->>V: Token, копирование, ImageProxy.close
    V->>V: Grayscale, обновление LK
    V-->>U: Наблюдение при актуальном token
    opt Пора проверить YOLO, свободен слот камеры
        V->>M: Один собственный snapshot
        M->>M: ORT и snapshot.close
        M-->>V: Результат исходного кадра
        V->>M: План коррекции по истории
        M-->>V: Replay отдельным трекером
        V-->>U: Коррекция, если ещё актуальна
    end
```

Рисунок 5. VisionWorker закрывает ImageProxy до LK и передачи собственного снимка. Все вызовы ORT идут последовательно. Результаты и ошибки проверяются по generation/source; [контракт входа](../guides/camera-frame-ingress.md) и [коррекция](../guides/visual-tracking-core.md).

Защита результатов имеет разные назначения:

| Механизм | Что предотвращает |
|---|---|
| `generation` | Публикацию результата/ошибки до Stop, смены порога или другой invalidation |
| `pumpEpoch` | Получение новым кадром места старой ML-задачи перед release прежней активации |
| `source` | Приём callback старой активации analyzer, даже на прежнем binding |
| `activationEpoch` в Preview | Повторное использование analyzer после pause/resume, слитых до recomposition |
| `revision` | Удаление нового результата старым таймером UI expiry |
| `selectionEpoch` камеры | Применение старых callback bind/zoom/metadata к новому выбору камеры |

```mermaid
stateDiagram-v2
    [*] --> STOPPED
    STOPPED --> STARTING: configure(true)
    STARTING --> RUNNING: успешный YOLO актуального поколения
    STARTING --> ERROR: актуальная ошибка
    RUNNING --> RUNNING: следующий кадр / expire
    RUNNING --> STARTING: новый threshold при active
    RUNNING --> ERROR: актуальная ошибка
    STARTING --> STOPPED: Stop / pause / rebind
    RUNNING --> STOPPED: Stop / pause / rebind
    ERROR --> STOPPED: Stop / pause
    ERROR --> STARTING: новый threshold при active
    STOPPED --> STOPPED: close
```

Рисунок 6. `LivePhase`. `ERROR` блокирует новые infer до повторной активации. Смена порога при активной детекции также переводит контроллер в STARTING. `expire(revision)` очищает наблюдение LK без смены RUNNING; UI вызывает его по ближайшему сроку: 250 мс без публикации или TTL подтверждения YOLO. Таймер захватывает ревизию при запуске. Сводка последних вызовов YOLO остаётся видимой. `close()` из любой фазы публикует STOPPED, запрещает дальнейшую работу и ставит освобождение backend в очередь.

Stop снимает analyzer и сохраняет превью. Pause/пропажа streaming/resize/display rotation инвалидируют результат сразу; новая активация получает новый source. Возврат из фона/ротация восстанавливают включённый режим, а после смены вкладки запуск ручной. Панель управления имеет размер относительно окна, прокручивается внутри и не меняет ViewPort при появлении статистики. UI результата собирает StateFlow на `Dispatchers.Main.immediate`.

## Потоки ORT и камеры

`LiveController.requestThreads(1|2|4)` принимает смену только при остановленной детекции, без кадра в работе, активной диагностики и предыдущего переключения. Возвращаемое `true` означает принятие запроса, а не успешное создание сессии; итог находится в `threadConfiguration`.

[ThreadSessionManager](../../app/src/main/java/ru/university/dronecv/detection/onnx/ThreadSessionManager.kt) закрывает старую сессию до открытия новой. Если создание не удалось, пытается восстановить прежнюю; ошибка восстановления добавляется как suppressed. Если закрытие не удалось, новая сессия не открывается. Фото сохраняет собственный детектор с параметрами по умолчанию.

Выбор 1×/5× или физического ID меняет `selectionEpoch`, прерывает диагностику и перепривязывает обе camera use cases. 5× проверяется по доступному zoom range. При отказе нестандартного выбора выполняется попытка возврата к 1×/auto; ошибка исходной конфигурации выводится на экран. ID и zoomRatio отражают доступные API сведения, без гарантии оптического объектива; проверка — [CAMERA_QA](../CAMERA_QA.md).

Запрошенные zoom и physical ID сохраняются вместе с настройкой запуска текущего экрана при recreation и при восстановлении Android сохранённого состояния. Сохраняется только запрос. Фактический zoom/активный ID, loading, source, контроллер и координаты создаются или подтверждаются заново. При уходе в фон текущий запрос сохраняется, а анализ возобновляется, если был включён. При уходе на «Фото» экземпляр экрана камеры удаляется: следующий вход начинает с 1×/auto и ручного запуска. Восстановленный недоступный запрос проходит тот же fallback, что и выбор в UI.

## Диагностическая сессия

Назначение — собрать измерения реального analyzer без записи изображений. Точка входа — `DiagnosticPanel` → `DiagnosticViewModel.start(confidence, threads, warmupFrames)`, доступная после кадра RUNNING. Число прогревочных кадров передаётся в отчёт; автоматического прогрева/таймера окончания нет.

```mermaid
sequenceDiagram
    actor U as Оператор
    participant VM as DiagnosticViewModel
    participant F as DiagnosticFrames
    participant C as LiveController
    participant W as TimelineWriter
    participant A as JournalArchive
    participant J as JournalArchiveViewModel
    participant OS as Ресурсы / ContentResolver
    U->>VM: start(confidence, threads, warmupFrames)
    VM->>A: reserve() на IO-worker
    VM->>F: start(nanoTime), новый token
    VM->>W: openWriter(), header
    VM->>OS: Опрос PSS / thermal / battery, примерно каждые 5 с
    C->>F: currentToken(), received(token)
    C->>F: completed(token запроса, времена YOLO)
    C->>F: tracking(token кадра публикации, наблюдение LK)
    U->>VM: stop() / событие прерывания
    VM->>F: stop(token), снимок
    VM->>VM: Сохранить последний report, посчитать сводки в фоне
    VM->>W: finishDiagnostic(report, stopNs)
    W->>W: Сохранить diagnostic_report и session_end в фоне
    W->>A: Финализация после закрытия потока
    U->>J: Выбрать прежнюю запись, экспорт
    J->>A: selectExport(id), защита файла
    J->>OS: CreateDocument, копирование выбранного NDJSON
    J->>A: Освободить защиту после close
```

Рисунок 7. Запись и экспорт диагностики. Сессионный token исключает завершение старого кадра в новом отчёте. Опрос ресурсов выполняется независимой coroutine и не подразумевает пробу на каждый кадр.

Фон, выключение экрана, смена вкладки/порога/камеры, rebind, Stop или ошибка прерывают сессию с причиной. После возврата запись автоматически не продолжается. Итоговый снимок передаётся writer для сохранения внутри NDJSON перед завершающей строкой. Сериализация выполняется вне UI/lock владельца. Прежний файл доступен после новой сессии и перезапуска приложения; владение, ошибки и защита выбранного экспорта описаны в [архиве](../guides/journal-archive.md). [Маршрут и карточка прогона](../guides/android-session-acceptance.md), [данные](../reference/data-model.md).

## Ошибки и инварианты

VisionWorker публикует `LiveState.tracking` при актуальном generation/source. Stop, порог, фон и rebind очищают результат, а queued reset закрывает трекер. Запоздавший replay освобождает свой экземпляр, если коррекция устарела. UI expiry убирает наблюдение при остановке поступления кадров. Правила выбора и потери цели — [трекинг камеры](../guides/visual-tracking-core.md).

`PhotoError` различает доступ, изображение, память, отсутствие/целостность модели и прочую ошибку infer. Пустые детекции — успешный результат EMPTY. В камере recoverable `CameraState` показывает занятость/переподключение, critical ведёт к recovery/error; после ошибки модели рекомендуется Stop/start. Экспорт показывает статус ошибки без фиктивного успешного сохранения. Логи и восстановление описаны в [runbook](../operations/runbook.md).

Не ждите закрытия ORT на UI и не вызывайте shutdownNow общих workers. ImageProxy не передаётся другому исполнителю: только собственный snapshot с generation/source/diagnostic token. Заимствованные массивы и опубликованные Bitmap нельзя освобождать до завершения читателя. Infer, смена потоков и close остаются на общем ML-worker; [тестирование](../development/testing.md).

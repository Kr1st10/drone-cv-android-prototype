# Изображения, координаты и измерения

Справка для разработчика CV/Android: путь от фото или RGBA-кадра к рамкам. Камера сопровождает цель с периодической проверкой YOLO и публикует внутренний сигнал; внешнего получателя координат нет.

## Общий поток

```mermaid
flowchart TD
    P[URI выбранного фото] --> D[Ограниченное декодирование / EXIF / sRGB / alpha на чёрном]
    D --> B[Upright Bitmap для UI и инференса]
    B --> A[ARGB пиксели]
    C[ImageProxy RGBA и raw cropRect] --> R[Чтение crop с rowStride/pixelStride]
    R --> A2[Собственный raw crop ARGB / пул]
    A --> Pre[Поворот и letterbox / RGB float32 NCHW]
    A2 --> Queue[Один снимок YOLO / DetectorWorker]
    A2 --> Gray[Upright grayscale / история]
    Gray --> Track[LK на свежих кадрах]
    Queue --> Pre
    Pre --> ORT[ORT CPU: сырой выход YOLO]
    ORT --> Post[Порог / NMS / обратный letterbox / clip]
    Post --> Norm[Нормализованные рамки upright изображения]
    Norm --> Photo[PhotoViewport Fit]
    Norm --> Correct[Выбор цели на кадре YOLO и перенос по истории]
    Gray --> Correct
    Correct --> Track
    Track --> Camera[Пиксели upright crop в общий FILL_CENTER ViewPort]
    Track --> Signal[LiveState.tracking]
    Norm --> Baseline[Выбор рамки в режиме YOLO]
    Baseline --> Camera
    A2 -.-> Marker[Чтение метки при записи стенда]
    Marker --> MotionLog[Журнал движения]
    Track -.-> MotionLog
    Baseline -.-> MotionLog
    Signal -.-> Timeline[Ограниченная очередь записи]
    Baseline -.-> Timeline
    MotionLog -.-> Timeline
    Timeline --> Writer[Фоновая запись NDJSON]
    Archive[JournalArchive: допуск и резервация файла] --> Writer
    Writer --> Stored[Приватный NDJSON и метаданные]
    Stored --> Export[Выбранный экспорт под защитой архива]
    Photo --> Draw[Рисование рамок]
    Camera --> Draw
```

Рисунок 2. Диагностическая запись и журнал стенда используют отдельные сессии с ограниченной очередью и файловой записью вне пути камеры; формат и признаки неполноты приведены в [модели данных](../reference/data-model.md#поток-диагностической-сессии-dronecv-session-timeline-1). Входные ветви сходятся в одном Kotlin-движке. Для фото поворот равен 0: EXIF уже применён. Для камеры `ImageInfo.rotationDegrees` применяется к raw crop в preprocessing, без повторного поворота рамок.

Управление сохранёнными файлами и системным экспортом описано в [архиве журналов](../guides/journal-archive.md); оно не меняет координаты и временные базы.

## Пространства координат

| Этап | Единицы и система отсчёта | Реализация и преобразование |
|---|---|---|
| Фото до decode | Размеры файла и EXIF | [AndroidPhotoBackend](../../app/src/main/java/ru/university/dronecv/photo/AndroidPhotoBackend.kt): ориентация, большая сторона до 2048 px, alpha на чёрном |
| Кадр камеры | RGBA, `cropRect` в raw px | [RgbaFrameConverter](../../app/src/main/java/ru/university/dronecv/camera/RgbaFrameConverter.kt): crop, stride и позиция ByteBuffer → packed ARGB |
| Upright вход | Пиксели повёрнутого изображения | [YoloPreprocessor](../../app/src/main/java/ru/university/dronecv/detection/yolo/YoloPreprocessor.kt): поворот совмещён с выборкой при масштабировании |
| Вход YOLO | Пиксели квадрата модели | [Letterbox](../../app/src/main/java/ru/university/dronecv/detection/yolo/Letterbox.kt): сохранение пропорций и поля; тензоры — [MODEL](../../ml/MODEL.md#3-тензоры) |
| После postprocessing | Пиксели upright изображения | [YoloPostprocessor](../../app/src/main/java/ru/university/dronecv/detection/yolo/YoloPostprocessor.kt): вычесть поля, разделить на scale, обрезать по границам |
| `Detection.box` | Доли ширины/высоты `[0,1]`, начало слева сверху | [DetectionMapping](../../app/src/main/java/ru/university/dronecv/detection/yolo/DetectionMapping.kt) |
| Фото в UI | Экранные px с полями Fit | [PhotoViewport](../../app/src/main/java/ru/university/dronecv/photo/PhotoGeometry.kt): один прямоугольник для bitmap и рамок, без независимого округления |
| Камера в UI | Экранные px PreviewView | [LiveCameraContent](../../app/src/main/java/ru/university/dronecv/camera/LiveCameraContent.kt): доли upright crop умножаются на размеры view |

Не заменяйте camera mapping независимым `Fit`: PreviewView использует `FILL_CENTER`. Layout/display rotation требуют нового ViewPort и инвалидирования старых результатов. Камера задняя, без зеркального отображения.

Сырой численный постпроцесс сохраняет рамки после clipping, включая схлопнувшиеся в поле letterbox, для совпадения с Python-эталоном. Прикладной `visibleDetections()` допускает только строго положительные ширину и высоту. Этот отбор применяется перед публикацией результатов камеры и фото, выбором цели, отображением и диагностическими счётчиками. `ObjectDetector.detect()` также возвращает только видимые рамки; detailed API сохраняет сырой выход. Частично обрезанные и сколь угодно маленькие непустые рамки допускаются без дополнительного порога размера. YOLO-сигнал и оверлей выбирают максимальный confidence среди допустимых рамок; при пустом списке координаты и confidence цели отсутствуют.

## Границы измерений

В [YoloOnnxEngine](../../app/src/main/java/ru/university/dronecv/detection/onnx/YoloOnnxEngine.kt) `preprocessMs` охватывает preprocessing, `inferenceMs` — `runModel()`, включая запись/создание входного тензора и чтение выхода, `postprocessMs` — decode/NMS. Фото показывает `inferenceMs`, без декодирования и создания движка.

В [AndroidFrameSnapshotter](../../app/src/main/java/ru/university/dronecv/camera/AndroidFrameSnapshotter.kt) conversionMs измеряет подготовку собственного RGBA crop → ARGB на VisionWorker. AndroidLiveBackend выполняет только ML-часть на DetectorWorker. LiveController складывает подготовку snapshot и длительность backend в pipelineMs; ожидание между workers исключено. Задержка LK измеряется отдельно до публикации наблюдения; она включает работу до неё, а для коррекции также ожидание после последнего кадра. Владение и ограничение очереди — [вход камеры](../guides/camera-frame-ingress.md). Сумма стадий не обязана равняться pipeline из-за служебных расходов.

Интервалы стадий/pipeline вычисляются по `System.nanoTime()`. `started_epoch_ms` задаёт внешнюю дату начала, а не базу длительностей. Ожидание до analyzer, экспозиция и дисплей не входят в pipeline. Отдельная задержка от экспозиции до внутреннего сигнала измеряется по совместимым Camera2/elapsedRealtimeNanos; неизвестная база даёт null. [Определения и границы](../guides/latency-and-prediction.md). Задержка до дисплея/действия внешнего устройства и число пропущенных CameraX кадров не измеряются.

Текущий FPS YOLO вычисляется по завершениям в окне до 30 результатов, ограниченном примерно 3 с с сохранением минимум двух результатов; после первого кадра он неизвестен. `processed_fps_session` делит успешные кадры на всю длительность диагностической сессии, включая простои. Частота LK считается отдельно по кадрам с координатами, без повторного учёта коррекции. Ни одно значение не является FPS сенсора или дисплея. Поля экспорта — [модель данных](../reference/data-model.md).

В режиме стенда VisionWorker читает экранную метку из собственного снимка после закрытия `ImageProxy`. Журнал отдельно сохраняет исходную детекцию YOLO и изменения действующей рамки. Формат и расчёт IoU описаны в [протоколе движения](../../lab/monitor_test/PROTOCOL.md#7-движущаяся-цель).

## Проверка и ограничения

Повороты, crop/stride, каналы, letterbox и mapping покрывают JVM-тесты; [реальный ORT](../../app/src/test/java/ru/university/dronecv/detection/OnnxParityTest.kt) проверяется отдельно. Parity с Python требует fixtures. Совмещение рамок на физическом сенсоре проверяется по [CAMERA_QA](../CAMERA_QA.md) и [LIVE_QA](../LIVE_QA.md).

Рамка относится к прошлому обработанному кадру и может отставать при движении. Размеры объекта на мониторе, в кадре и на входе YOLO различаются; лабораторные преобразования заданы в [протоколе](../../lab/monitor_test/PROTOCOL.md#5-размеры-и-экспорт).

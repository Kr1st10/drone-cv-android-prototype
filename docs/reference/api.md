# Внутренние программные контракты

Справочник для разработчика приложения и тестов. Внешнего HTTP API, аутентификации, ролей, пагинации и отдельной версии API нет (`N/A`). Kotlin-декларации публичны для модулей/исходников, но стабильный SDK не выпускается. Совместимость контролируется сборкой приложения и тестами; изменения контракта требуют одновременного обновления потребителей.

## Детектор и движок

`tracking/VisualTracker` и `TrackingSession` обслуживают камеру. Их API, временные проверки и владение коррекцией описаны в руководстве: [ядро визуального трекинга](../guides/visual-tracking-core.md).

Источники: [ObjectDetector](../../app/src/main/java/ru/university/dronecv/detection/ObjectDetector.kt), [OnnxDroneDetector](../../app/src/main/java/ru/university/dronecv/detection/onnx/OnnxDroneDetector.kt), [YoloOnnxEngine](../../app/src/main/java/ru/university/dronecv/detection/onnx/YoloOnnxEngine.kt). Все параметры обязательны, кроме явно указанных значений по умолчанию. Типы результатов раскрыты в [модели данных](data-model.md), точные настройки — в [конфигурации](configuration.md).

| Операция | Вход | Результат, ошибки и побочные эффекты |
|---|---|---|
| `ObjectDetector.detect` | `frame: Bitmap`, `rotationDegrees: Int` по часовой стрелке | `List<Detection>` видимых непустых рамок относительно upright кадра; пустой список допустим. [Критерий отбора](../architecture/data-flow.md#пространства-координат). Android-реализация блокирующая, запрещает Main и вызов после close (`IllegalStateException`); неверный поворот/bitmap → `IllegalArgumentException`/`IllegalStateException`, ошибки модели → `DetectorException` |
| `ObjectDetector.close()` | Нет | `Unit`; освобождает сессию. Для ORT может ждать текущий infer; вызывайте через worker |
| `OnnxDroneDetector.create` | `context: Context`; `options=YoloEngineOptions()`; `assetPath`/`expectedSha256` из BuildConfig | Детектор. Копирует/проверяет ONNX в no-backup storage, создаёт ORT. Main запрещён; возможны ошибки файла/хеша/формата/ORT и I/O |
| `createAsync(context, options=...)` | Те же Context/options | Suspend-обёртка `create` на `Dispatchers.IO`; блокирующие исключения сохраняются |
| `detectDetailed(frame, rotationDegrees)` | Bitmap и поворот | `YoloResult`: сырой численный выход с пиксельными рамками и временами, включая пустые рамки после clipping; прикладной отбор выполняет потребитель. Требует фонового потока, не закрытого движка |
| `detectArgbDetailed(image, rotationDegrees, postprocess)` | `ArgbImage`, Int, `PostprocessConfig` | `YoloResult`; не создаёт Bitmap, читает заимствованные пиксели синхронно; Main запрещён |
| `ObjectDetector.detectAsync(frame, rotationDegrees)` | Bitmap и Int | Suspend `List<Detection>` на `Dispatchers.Default`; это обёртка, не общий worker контроллеров |
| `labels` | Нет | `List<String>` меток из спецификации модели |
| `YoloOnnxEngine.fromFile(file, options=...)` / `fromBytes(bytes, options=...)` | `File` / `ByteArray`, `YoloEngineOptions` | Движок; проверяет число/типы/формы тензоров. `fromFile` сам не проверяет SHA; для доверенной установки используйте `ModelFiles` |
| `engine.detect(image, rotationDegrees=0, postprocess=options.postprocess)` | ARGB и опции | `YoloResult`; detect/runRaw/close сериализуются lock, после close вызов detect запрещён |
| `engine.runRaw(input)` | `FloatArray` ровно `3*S*S` | Копия raw float-выхода модели; неверная длина → `IllegalArgumentException`; предназначен для parity |
| `engine.preprocessOnly(image, rotationDegrees=0)` | ARGB, поворот | `Pair<FloatArray, Letterbox>` без ORT; создаёт отдельный preprocessor и массив, не проверяет `isClosed` |
| `engine.isClosed` / `close()` | Нет | Boolean / `Unit`; close повторно безопасен после успеха; общий `OrtEnvironment` не закрывается; ошибка `session.close()` не скрывается движком |

Пример JVM-вызова с существующей моделью; он возвращает фактическое число рамок, без заранее заданного результата:

```kotlin
import java.io.File
import ru.university.dronecv.detection.onnx.YoloOnnxEngine
import ru.university.dronecv.detection.yolo.ArgbImage

fun inspectUniformInput(modelFile: File): Int =
    YoloOnnxEngine.fromFile(modelFile).use { engine ->
        val image = ArgbImage(640, 480, IntArray(640 * 480) { 0xff727272.toInt() })
        engine.detect(image).detections.size
    }
```

Однотонный вход проверяет исполнимость, не качество. Исполняемые аналоги — [OnnxParityTest](../../app/src/test/java/ru/university/dronecv/detection/OnnxParityTest.kt). Android-вызовы вне контроллера должны самостоятельно обеспечить порядок и владение bitmap; асинхронные обёртки не добавляют ограниченную очередь фото/камеры.

## Преобразования и файлы

| Интерфейс и источник | Вход → выход | Ограничения и эффекты |
|---|---|---|
| [ModelFiles](../../app/src/main/java/ru/university/dronecv/detection/onnx/ModelFiles.kt): `sha256(file: File)` / `sha256(input: InputStream)` | Источник → hex String | File-перегрузка закрывает свой поток; переданный InputStream перегрузка не закрывает. I/O исключения передаются вызывающему |
| `installVerified(source: () -> InputStream, target: File, expectedSha256: String)` | Источник/цель/64 hex → `File` | Проверяет имеющийся target, иначе создаёт `.part`, проверяет и атомарно заменяет. Неверный digest → `IllegalArgumentException`, несовпадение → `ModelIntegrityException`; прежний target сохраняется при ошибке чтения/хеша, временный файл удаляется |
| [ArgbImage](../../app/src/main/java/ru/university/dronecv/detection/yolo/ArgbImage.kt): constructor, `get(x,y)`, `rotated(degrees)` | Положительные width/height, `IntArray(width*height)` → изображение/пиксель/поворот | Массив не копируется; bounds доступа обеспечивает массив. Поворот кратен 90, нормализуется по 360; 0 возвращает тот же объект, остальные создают копию |
| [YoloPreprocessor](../../app/src/main/java/ru/university/dronecv/detection/yolo/YoloPreprocessor.kt): `preprocess(image, rotationDegrees, out)` | ARGB, Int, `FloatArray(tensorSize)` → `Letterbox` | `inputSize>0`, padValue в `0..255`, длина out точная; неверные значения → `IllegalArgumentException`; out перезаписывается, экземпляр не потокобезопасен |
| [Letterbox](../../app/src/main/java/ru/university/dronecv/detection/yolo/Letterbox.kt): `compute(srcWidth, srcHeight, inputSize)`, `toSourceX/Y(Float)` | Положительные Int размеры → геометрия; Float → Float | Неверный размер → `IllegalArgumentException`; inverse без clip, масштаб/поля сохранены в объекте |
| [YoloModelSpec](../../app/src/main/java/ru/university/dronecv/detection/yolo/YoloModelSpec.kt): `validate(inputName, inputShape, outputName, outputShape, namesMetadata)` | String/LongArray/String/LongArray/String? → spec | Статический квадрат `[1,3,S,S]`, S кратен 32, выход `[1,4+nc,N]` с ожидаемым N; несовместимость → `ModelFormatException`; нет меток → `class_0...` |
| `YoloModelSpec.parseNames(metadata: String)` | Python-словарь имён в строке → `Map<Int,String>` | Регулярное выражение, не общий Python/JSON parser; непрочитанные элементы не гарантируют отдельную ошибку |
| [YoloPostprocessor](../../app/src/main/java/ru/university/dronecv/detection/yolo/YoloPostprocessor.kt): `decode(output, shape, letterbox, config=...)` | FloatArray/LongArray/Letterbox/PostprocessConfig → `List<YoloDetection>` | Размеры/число классов проверяются, некорректные кандидаты отбрасываются; порог строгий, NMS по классу, clip к upright изображению |
| `PixelBox.iou(other: PixelBox)` | Две pixel-рамки → Float | Пересечение/объединение с малым epsilon; без пересечения 0; constructor PixelBox сам порядок координат не проверяет |
| [YoloDetection.toDetection(width,height)](../../app/src/main/java/ru/university/dronecv/detection/yolo/DetectionMapping.kt) | Пиксельное обнаружение и положительные размеры → `Detection` | Нормализация и clip; положительные размеры — обязанность вызывающего, отдельного require в функции нет |
| `NormalizedBox.toPixels(width,height)` | Int размеры → `FloatArray(left,top,right,bottom)` | Умножение на размеры без дополнительной проверки; вызывающий задаёт корректное пространство |
| [PhotoViewport.fit](../../app/src/main/java/ru/university/dronecv/photo/PhotoGeometry.kt), `.map(box)` | Положительные image Int/view Float → viewport; `NormalizedBox` → `PhotoScreenBox` | View размеры finite; ошибки → `IllegalArgumentException`; одна Fit-геометрия изображения/рамок |
| `PhotoDecodeSize.fit(width,height,maxSide=2048)` / `.sampleSize(...)` | Положительные Int → ограниченные размеры / Int sampling | `IllegalArgumentException` для неверного размера/переполнения sampling; не увеличивает небольшое фото |
| [RgbaFrameConverter.convert](../../app/src/main/java/ru/university/dronecv/camera/RgbaFrameConverter.kt) | ByteBuffer, Int width/height/rowStride/pixelStride/left/top/right/bottom → `ArgbImage` | Только pixelStride 4, непустой crop внутри кадра, полные строки/буфер; неверное → `IllegalArgumentException`; возвращает массив до следующего convert; `clear()` освобождает ссылки |
| [CameraGeometry.map](../../app/src/main/java/ru/university/dronecv/camera/CameraGeometry.kt) | `NormalizedBox`, Float viewWidth/viewHeight → `FloatArray` | View размеры >0, иначе `IllegalArgumentException`; требует общего ViewPort и задней камеры без mirror |

## Фото: управление и backend

Источник: [PhotoController.kt](../../app/src/main/java/ru/university/dronecv/photo/PhotoController.kt). `PhotoController<Image : Any>(backend, dispatcher)` получает `PhotoBackend<Image>` и `CoroutineDispatcher`; в приложении используется общий DetectorWorker.

| Операция | Вход → результат | Условия, ошибки, эффекты |
|---|---|---|
| `select(uri: String)` | URI → `Unit` | Ставит загрузку и меняет state/generation; после close ничего не делает. Не обещает синхронную валидацию URI |
| `recognize()` | Нет → `Unit` | Работает только при `canRecognize`; ставит infer. Backend ошибки публикуются как `PhotoError`, не выбрасываются в UI |
| `state` | Нет → `StateFlow<PhotoState<Image>>` | Только чтение; содержит фазу, image/result/error |
| `close()` | Нет → `Unit` | Снимает ссылки, отменяет ожидающие команды, закрывает backend после нативного вызова без ожидания UI |
| `PhotoBackend.load(uri)` | String → Image | Блокирующий decode на worker; может бросить SecurityException/I/O/ошибку изображения/OOM |
| `PhotoBackend.infer(image)` | Image → `PhotoInference` | Блокирующая обработка того же image; ошибки модели/инференса/OOM |
| `PhotoBackend.discard(image)` / `close()` | Image / нет → `Unit` | discard только для никогда не опубликованного image; close освобождает backend на том же worker |

`AndroidPhotoBackend(context: Context)` реализует контракт для Bitmap, лениво создаёт детектор; ошибки release логирует. `PhotoViewModel(Application)` проксирует `select`, `recognize`, `state`, вызывает close при `onCleared`. Обработка устаревших ответов и памяти — [сценарий фото](../internals/detection-lifecycle.md#выбор-и-распознавание-фото).

## Камера: управление и backend

Источник: [LiveController.kt](../../app/src/main/java/ru/university/dronecv/camera/LiveController.kt). Constructor получает `LiveBackend<Frame>`, `Executor`, optional `DiagnosticFrames?=null`, `initialThreads=2`, `eventTime: (() -> Long)?=null`, `maxAnalyzerAgeMs=250.0`, `tracking: LiveTracking<Frame>?=null`, `nanoTime=System::nanoTime`; `Frame : AutoCloseable`. Android использует CameraFrameSnapshot. LiveFrameCapture вызывается на VisionWorker, копирует и закрывает ImageProxy до offerFrame. Все backend-операции сериализованы DetectorWorker. CameraScreen передаёт LiveTracking и elapsedRealtimeNanos; для этой ветви eventTime обязателен. [Владение и очередь](../guides/camera-frame-ingress.md).

| Операция | Вход → результат | Условия, ошибки, эффекты |
|---|---|---|
| `configure(enabled: Boolean, threshold: Float)` | Настройки → `Unit` | Threshold `0.01..1.0`, иначе `IllegalArgumentException`; инвалидирует результат, при выключении ставит backend.close на worker; после close игнорируется |
| `updateThreshold(threshold)` | Float → `Unit` | То же при текущем active |
| `newSource()` | Нет → Long token | Выключает текущую активацию и увеличивает source; затем вызывающий активирует analyzer |
| `beginFrame(sourceId, stamp)` | Метаданные → LiveFrameToken? | Принимает только активную generation/source; до копирования проверяет возраст, token фиксирует диагностическую сессию |
| `offerFrame(frame, token, stamp, preparationMs)` | Собственный snapshot → Unit | Принимает владение даже при отказе; в режиме LK наблюдает кадр и при необходимости резервирует снимок для ORT; без LiveTracking заменяет pending; preparationMs finite, >=0 |
| `input` | Нет → `StateFlow<CameraInputStats>` | Окно входных FPS, счётчики копий/пропусков; не FPS сенсора и не новые координаты |
| `analyze(frame, sourceId: Long?=null, stamp: FrameStamp?=null)` | Frame/token/метки времени → `Unit` | Синхронный ML-worker entry для собственных кадров; CameraX использует LiveFrameCapture/offerFrame. Принимает только актуальный источник; известный возраст >maxAnalyzerAgeMs отбрасывается до ORT. `finally` всегда закрывает frame. Ошибки infer/OOM превращаются в ERROR при актуальной generation; ошибка самого frame.close может выйти наружу |
| `requestThreads(threads: Int)` | 1/2/4 → Boolean | Неверный Int → `IllegalArgumentException`; false при запрещённой смене/закрытии; true — запрос принят. Результат и ошибка асинхронно в StateFlow |
| `expire(revision: Long)` | Ревизия → `Unit` | Очищает tracking и trackingFps только при совпадении ревизии; в ветви без LK очищает result/FPS/pipeline |
| `close()` | Нет → `Unit` | Идемпотентно инвалидирует generation/source, сбрасывает state и ставит release в очередь |
| `state` / `threadConfiguration` | Нет → StateFlow | `LiveState` / `ThreadConfiguration`; не публикуют старый infer/error |
| `state.value.tracking` | `TrackingSignal?` | Последняя публикация LK по кадру, либо null после invalidation/expiry. Содержит состояние, времена, координаты при сопровождении и `displayUntilNs`: локальный дедлайн видимости по elapsedRealtimeNanos, без поля в JSON. |
| `signals` | `StateFlow<TargetSignal?>` | Исторический сигнал v2 в ветви без LiveTracking. В рабочей камере координаты читаются из state. |
| `LiveBackend.infer(frame, confidence)` | Frame/Float → `LiveInference` | Блокирующий, не должен удерживать frame после возврата; его закрывает контроллер |
| `LiveBackend.changeThreads(threads)` / `close()` | Int / нет → Unit | На том же worker; default changeThreads бросает `UnsupportedOperationException` |

`AndroidLiveBackend(Context, initialThreads=2)` получает CameraFrameSnapshot, не читает ImageProxy и использует ThreadSessionManager. DetectorWorker.executor/dispatcher доступны всему процессу, VisionWorker.executor обслуживает вход; экран не закрывает эти исполнители. Закрытый внешний Executor не является поддерживаемым способом отмены native-работы.

## Диагностика и UI

| Интерфейс и источник | Параметры/результат | Условия и эффекты |
|---|---|---|
| [durationSummary](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticStatistics.kt) | `List<Double>` → `DurationSummary?` | Пустой → null; все значения finite и >=0, иначе `IllegalArgumentException`; p95 только с 20 значений |
| `DiagnosticFrames(capacity=100000).start(nowNanos: Long)` | Монотонное начало → Long token | Во время записи → `IllegalStateException`; новая сессия очищает кадры/счётчики |
| `.currentToken()` / `.received(token)` | Нет / Long → Long? / Unit | Token null при остановке; старые received игнорируются |
| `.completed(token,endNanos,conversionMs,preprocessMs,inferenceMs,postprocessMs,pipelineMs)` | Long, Long, пять Double → Unit | Старый token игнорируется; время >= начала, длительности finite и >=0; превышение capacity считается как unstored |
| `.stop(token,nowNanos,interrupted,reason)` | Long/Long/Boolean/String? → `DiagnosticFrameSnapshot?` | Неактивный token → null; неверное время → `IllegalArgumentException`; копирует накопленное и завершает запись |
| [DiagnosticReport.toJson](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticReport.kt) | Report → String | Синхронный serializer без I/O; вызывает статистику, поэтому вне Main. Не добавляет изображения/детекции; контракт полей — [данные](data-model.md) |
| [DiagnosticViewModel(Application)](../../app/src/main/java/ru/university/dronecv/diagnostics/DiagnosticViewModel.kt) | `.start(confidence, threads=2, warmupCompletedFrames=0, activate={it()})`, `.stop(interrupted=false, reason=null)` → Unit | start сначала резервирует архив на IO, затем activate синхронно запускает запись и начальный снимок на Main; Stop инвалидирует отложенный старт. Отказ по квоте не запускает сессию. Экспорт выполняется через общий архив |

Compose-функции возвращают Unit и участвуют в Android lifecycle: `DroneApp()` создаёт вкладки/Activity ViewModel; `PhotoScreen(PhotoViewModel)` запускает Picker; `CameraScreen(confidence: Float, initialThreads: Int, onThreadsChanged: (Int)->Unit, onOpenJournals: ()->Unit={}, onConfidenceChange: (Float)->Unit)` управляет разрешением и камерой; `DiagnosticPanel(model, liveReady: Boolean, confidence: Float, threads: Int, warmupFrames: Long)` запускает и останавливает диагностику; `JournalArchiveScreen(JournalArchiveViewModel)` выбирает сохранённый журнал для экспорта/удаления. `DroneCvTheme(content: @Composable ()->Unit)` задаёт фиксированную тёмную Material 3 тему. Это UI-композиция, а не чистые функции без побочных эффектов.

`CameraUnavailableException` означает отсутствие доступной задней камеры; `CameraStateException(code: Int)` несёт CameraX error code. Внутренние инвентаризация и экспорт камер не являются публичным SDK: [CameraInventory](../../app/src/main/java/ru/university/dronecv/camera/CameraInventory.kt), [CameraInventoryPanel](../../app/src/main/java/ru/university/dronecv/camera/CameraInventoryPanel.kt).

## Архив файлов

`JournalArchive(root, policy=JournalPolicy())` предоставляет блокирующие `inventory()`, `reserve(kind)`, `selectExport(id)`, `delete(id, allowUnexported)`: только на IO. Ошибочные ID дают `IllegalArgumentException`, занятость/отсутствие подтверждения удаления и квота дают `IllegalStateException` (для квоты `JournalQuotaException`); ошибки файловой системы сохраняются. `Recording.openWriter()` передаёт резервацию writer без дисковых операций на вызывающем потоке; неиспользованный `Recording.close()` вызывается на IO. `Export.close()` освобождает ожидание выбора в памяти; `Export.copy(openOutput, checkCancelled={})` блокирует до копирования и close назначения, фиксирует успех и всегда освобождает защиту. [Полный контракт, статусы и политика](../guides/journal-archive.md).

## Python-эталон и CLI

[ml/scripts/drone_detector.py](../../ml/scripts/drone_detector.py) используется инструментами/тестами на компьютере, не Android-приложением. Отдельной версии Python API, auth или гарантии стабильного SDK нет. Вход изображения — NumPy RGB uint8 `[H,W,3]` с положительными размерами; `load_rgb` делегирует декодирование OpenCV, общего DetectorWorker здесь нет.

| Операция | Параметры / результат | Ошибки и эффекты |
|---|---|---|
| `DroneDetector(model_path=DEFAULT_MODEL, threads=0)` | str/Path к ONNX, Int → экземпляр с CPU ORT session | threads=0 оставляет ORT выбор, ненулевое значение передаётся в intra-op; ошибки ORT не переводятся в Android DetectorException; SHA в constructor не проверяется |
| `.raw(x: np.ndarray)` | Подготовленный float32 NCHW → raw NumPy output | Прямой session.run; несовместимость типа/формы сообщает ORT |
| `.detect(img_rgb, conf=0.25, iou=0.7)` | RGB-массив и Float пороги → `list[Detection]` | Preprocess → raw → postprocess; координаты исходного изображения в px, пустой список штатен |
| `letterbox(img_rgb, size=640)` / `preprocess(img_rgb, size=640)` | Массив и Int → `(RGB padded array, LetterboxInfo)` / `(float32 tensor, LetterboxInfo)` | Вызывают OpenCV/NumPy; выполняются синхронно, ошибки неправильного входа не унифицированы |
| `nms(boxes,scores,iou_thr)` | xyxy `[N,4]`, scores `[N]`, Float → `np.ndarray` индексов int64 | Жадная сортировка/подавление; для пустого boxes пустой массив |
| `postprocess(output,info,conf=0.25,iou=0.7,max_det=300)` | Raw `[1,4+nc,N]`, геометрия, пороги/лимит → `list[Detection]` | Неверная основная форма → ValueError, строгий score threshold, NMS предполагает текущую одноклассовую модель |
| `load_rgb(path: str/Path)` / `draw(img_rgb,dets)` | Путь → RGB array / RGB+детекции → BGR array с рамками | load_rgb: FileNotFoundError, если OpenCV не прочитал; draw создаёт изображение, сам файл не пишет |

Python `Detection` содержит `x1,y1,x2,y2,score: float`, `class_id: int=0`, `label: str="drone"`. `LetterboxInfo`: `scale,pad_x,pad_y: float`, `orig_w,orig_h: int`. Эти dataclass не вводят валидацию Android NormalizedBox.

В подготовленном ML-окружении из корня репозитория, подставив своё изображение:

```bash
python ml/scripts/drone_detector.py /absolute/path/to/photo.jpg --conf 0.25 --iou 0.7
```

CLI принимает обязательные `images` (один/несколько путей), `--model` (путь, default `ml/weights/yolo11s-drone-640.onnx`), `--conf`/`--iou` (float, defaults выше) и необязательный `--save-dir` (путь, default None). Печатает по JSON-объекту на изображение: image, width, height, detections с полями dataclass; при save-dir пишет размеченные изображения. Парсер принимает float без отдельной проверки диапазона, поэтому используйте пороги `[0,1]`; не переносите сюда гарантию require из Kotlin.

Операционные CLI: `install_android_model.py [--onnx PATH]` описан в [запуске](../getting-started.md#подготовить-модель); `verify_apk_model.py APK` проверяет ZIP asset и завершается ошибкой при отсутствии/неверном SHA/сжатии; `analyze_android_sessions.py INPUT [INPUT ...] --output PATH [--compare-threads]` описан в [тестировании](../development/testing.md#python-и-галерея). Gallery CLI и JSON-контракт — [README](../../lab/monitor_test/README.md) и [протокол](../../lab/monitor_test/PROTOCOL.md#формат-json-и-совместимость). Исследовательские CLI отдельных этапов имеют собственные инструкции из [карты кода](../development/codebase.md#ml-и-лабораторные-инструменты); единого стабильного API они не образуют.

## Категории ошибок и пробелы KDoc

[DetectorExceptions](../../app/src/main/java/ru/university/dronecv/detection/yolo/DetectorExceptions.kt) определяет `DetectorException(message, cause?)` и подклассы: `ModelNotFoundException`, `ModelIntegrityException`, `ModelFormatException`, `InferenceException`. Контракт не гарантирует, что любая I/O/OOM/ошибка неправильного использования обёрнута в DetectorException. Отображение в UI и логи — [runbook](../operations/runbook.md).

У `PhotoBackend`, методов контроллеров, части ORT/helper API и диагностики KDoc не описывает полностью параметры, возвращаемые значения, исключения и побочные эффекты. Сведения собраны здесь; исходники и комментарии по границам задания не менялись. Это невыполненное требование §7.1 STD-DOC-001, а не замена KDoc внешней страницей. Проверка контракта опирается на исходники и [тесты](../development/testing.md).

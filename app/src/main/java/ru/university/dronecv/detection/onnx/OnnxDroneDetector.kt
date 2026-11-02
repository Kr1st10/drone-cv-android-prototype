package ru.university.dronecv.detection.onnx

import android.content.Context
import android.graphics.Bitmap
import android.os.Looper
import java.io.File
import java.io.FileNotFoundException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.university.dronecv.BuildConfig
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.ObjectDetector
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.ModelNotFoundException
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.toDetection

/**
 * Детектор дронов YOLO11s (ONNX Runtime, CPU), работающий полностью на устройстве, без сети.
 *
 * Модель лежит в assets (`BuildConfig.DRONE_MODEL_ASSET`, ставится `ml/scripts/install_android_model.py`),
 * при первом запуске копируется в `noBackupFilesDir` с проверкой SHA-256 (`BuildConfig.DRONE_MODEL_SHA256`),
 * затем открывается ONNX Runtime из файла.
 *
 * Создание ([create]) и [detect] — блокирующие операции: вызывать с фонового потока
 * (или через [createAsync] / [detectAsync]).
 */
class OnnxDroneDetector private constructor(private val engine: YoloOnnxEngine) : ObjectDetector {

    /** Метки классов модели (для текущей модели — `["drone"]`). */
    val labels: List<String> get() = engine.spec.labels

    override fun detect(frame: Bitmap, rotationDegrees: Int): List<Detection> {
        val result = detectDetailed(frame, rotationDegrees)
        return result.detections.map { it.toDetection(result.imageWidth, result.imageHeight) }
    }

    /** То же, что [detect], но с рамками в пикселях повёрнутого кадра и замерами времени. */
    fun detectDetailed(frame: Bitmap, rotationDegrees: Int): YoloResult {
        checkNotMainThread("detect")
        check(!engine.isClosed) { "OnnxDroneDetector is closed" }
        return engine.detect(frame.toArgbImage(), rotationDegrees)
    }

    /** Borrowed camera pixels; no Bitmap or second full-frame copy. Same engine as Photo. */
    fun detectArgbDetailed(image: ArgbImage, rotationDegrees: Int, postprocess: PostprocessConfig): YoloResult {
        checkNotMainThread("detectArgbDetailed")
        return engine.detect(image, rotationDegrees, postprocess)
    }

    override fun close() = engine.close()

    companion object {
        /** Создаёт детектор из модели в assets. Блокирующий вызов (копирование ~38 МБ при первом запуске). */
        fun create(
            context: Context,
            options: YoloEngineOptions = YoloEngineOptions(),
            assetPath: String = BuildConfig.DRONE_MODEL_ASSET,
            expectedSha256: String = BuildConfig.DRONE_MODEL_SHA256,
        ): OnnxDroneDetector {
            checkNotMainThread("create")
            val app = context.applicationContext
            val target = File(File(app.noBackupFilesDir, "models"), File(assetPath).name)
            try {
                ModelFiles.installVerified({ app.assets.open(assetPath) }, target, expectedSha256)
            } catch (e: FileNotFoundException) {
                throw ModelNotFoundException(
                    "Model asset '$assetPath' is missing. Run ml/scripts/fetch_and_export.py and " +
                        "ml/scripts/install_android_model.py before building the app.", e
                )
            }
            return OnnxDroneDetector(YoloOnnxEngine.fromFile(target, options))
        }

        suspend fun createAsync(
            context: Context,
            options: YoloEngineOptions = YoloEngineOptions(),
        ): OnnxDroneDetector = withContext(Dispatchers.IO) { create(context, options) }

        private fun checkNotMainThread(op: String) {
            check(!Looper.getMainLooper().isCurrentThread) { "OnnxDroneDetector.$op must not be called on the main thread" }
        }
    }
}

/** Асинхронный вызов детектора на фоновом диспетчере. */
suspend fun ObjectDetector.detectAsync(frame: Bitmap, rotationDegrees: Int): List<Detection> =
    withContext(Dispatchers.Default) { detect(frame, rotationDegrees) }

/** Bitmap -> ARGB-пиксели (конвертирует HARDWARE/RGB_565 и т.п. в ARGB_8888). */
internal fun Bitmap.toArgbImage(): ArgbImage {
    check(!isRecycled) { "Bitmap is recycled" }
    val src = if (config == Bitmap.Config.ARGB_8888) this else copy(Bitmap.Config.ARGB_8888, false)
        ?: throw IllegalArgumentException("Cannot convert bitmap with config $config to ARGB_8888")
    val pixels = IntArray(src.width * src.height)
    src.getPixels(pixels, 0, src.width, 0, 0, src.width, src.height)
    if (src !== this) src.recycle()
    return ArgbImage(width, height, pixels)
}

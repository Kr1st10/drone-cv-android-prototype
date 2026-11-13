package ru.university.dronecv.detection

import android.graphics.Bitmap

/**
 * Контракт детектора объектов. Реализация — [ru.university.dronecv.detection.onnx.OnnxDroneDetector]
 * (YOLO11s, ONNX Runtime, локально на устройстве).
 *
 * Требования к использованию:
 * - [detect] — блокирующий вызов; не вызывать с главного потока (реализация бросает IllegalStateException);
 * - вызовы сериализуются внутри реализации, по одному кадру за раз;
 * - [close] освобождает ресурсы модели (сессию ONNX Runtime); после него [detect] бросает IllegalStateException.
 */
interface ObjectDetector : AutoCloseable {

    /**
     * Выполняет обнаружение на одном кадре.
     *
     * @param frame кадр/фото в исходной ориентации (ARGB_8888; другие конфигурации конвертируются).
     * @param rotationDegrees поворот по часовой стрелке (0/90/180/270), который нужно применить к кадру,
     *        чтобы он совпал с ориентацией экрана (ImageInfo.rotationDegrees в CameraX).
     * @return видимые непустые обнаружения в координатах повёрнутого кадра; пустой список, если объектов нет.
     * @throws ru.university.dronecv.detection.yolo.DetectorException при ошибке инференса.
     */
    fun detect(frame: Bitmap, rotationDegrees: Int): List<Detection>
}

/**
 * Результат обнаружения одного объекта.
 *
 * @param label имя класса (например, "drone").
 * @param confidence уверенность модели в диапазоне [0, 1].
 * @param box прямоугольник в нормализованных координатах повёрнутого кадра.
 * @param classId индекс класса модели.
 */
data class Detection(
    val label: String,
    val confidence: Float,
    val box: NormalizedBox,
    val classId: Int = 0,
) {
    init {
        require(confidence in 0f..1f) { "confidence must be in [0, 1], was $confidence" }
    }
}

/** Прямоугольник с координатами в диапазоне [0, 1] относительно ширины/высоты кадра. */
data class NormalizedBox(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
) {
    init {
        require(left in 0f..1f && right in 0f..1f && top in 0f..1f && bottom in 0f..1f) {
            "Box coordinates must be normalized to [0, 1]"
        }
        require(left <= right && top <= bottom) { "Invalid box: left > right or top > bottom" }
    }

    /** Перевод в пиксели изображения размером [width] x [height]. */
    fun toPixels(width: Int, height: Int): FloatArray =
        floatArrayOf(left * width, top * height, right * width, bottom * height)
}

/** Clipping can collapse a raw YOLO box into padding; no minimum pixel size is imposed. */
fun List<Detection>.visibleDetections(): List<Detection> = filter {
    it.box.right > it.box.left && it.box.bottom > it.box.top
}

/** Shared by target publication and the YOLO overlay; ties preserve decoder order. */
fun List<Detection>.highestConfidenceVisibleDetection(): Detection? =
    visibleDetections().maxByOrNull { it.confidence }

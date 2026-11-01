package ru.university.dronecv.detection

import android.graphics.Bitmap

/**
 * Контракт детектора объектов для будущего подключения YOLO (этап 2).
 *
 * На текущем этапе реализаций нет: инференс не выполняется и
 * фиктивные обнаружения не создаются.
 *
 * Ожидания к реализации:
 * - [detect] вызывается с фонового потока (например, из ImageAnalysis.Analyzer)
 *   и не должен вызываться с главного потока;
 * - вызовы последовательные, по одному кадру за раз;
 * - [close] освобождает ресурсы модели (интерпретатор, делегаты GPU/NPU).
 */
interface ObjectDetector : AutoCloseable {

    /**
     * Выполняет обнаружение на одном кадре.
     *
     * @param frame кадр с камеры в исходной ориентации сенсора.
     * @param rotationDegrees поворот (0/90/180/270), который нужно применить к кадру,
     *        чтобы он совпал с ориентацией экрана (ImageInfo.rotationDegrees в CameraX).
     * @return список обнаружений; пустой список, если объектов нет.
     */
    fun detect(frame: Bitmap, rotationDegrees: Int): List<Detection>
}

/**
 * Результат обнаружения одного объекта.
 *
 * @param label имя класса (например, "drone").
 * @param confidence уверенность модели в диапазоне [0, 1].
 * @param box прямоугольник в нормализованных координатах повёрнутого кадра.
 */
data class Detection(
    val label: String,
    val confidence: Float,
    val box: NormalizedBox,
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
}

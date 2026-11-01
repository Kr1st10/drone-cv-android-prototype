package ru.university.dronecv.detection.yolo

import kotlin.math.max
import kotlin.math.min

/** Прямоугольник в пикселях изображения: `left <= right`, `top <= bottom`. */
data class PixelBox(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    val area: Float get() = max(0f, width) * max(0f, height)

    fun iou(other: PixelBox): Float {
        val iw = min(right, other.right) - max(left, other.left)
        val ih = min(bottom, other.bottom) - max(top, other.top)
        if (iw <= 0f || ih <= 0f) return 0f
        val inter = iw * ih
        return inter / (area + other.area - inter + 1e-9f)
    }
}

/** Обнаружение в пикселях (повёрнутого) исходного изображения. */
data class YoloDetection(
    val classId: Int,
    val label: String,
    val confidence: Float,
    val box: PixelBox,
)

/** Пороговые параметры постобработки (по умолчанию — как Ultralytics `predict`). */
data class PostprocessConfig(
    /** Обнаружение сохраняется, если score строго больше порога. */
    val confidenceThreshold: Float = 0.25f,
    /** Рамка подавляется, если IoU с более уверенной рамкой того же класса строго больше порога. */
    val iouThreshold: Float = 0.7f,
    val maxDetections: Int = 300,
) {
    init {
        require(confidenceThreshold in 0f..1f) { "confidenceThreshold must be in [0, 1]" }
        require(iouThreshold in 0f..1f) { "iouThreshold must be in [0, 1]" }
        require(maxDetections > 0) { "maxDetections must be positive" }
    }
}

/**
 * Декодирование сырого выхода YOLO11 (Ultralytics, экспорт без NMS) `[1, 4 + nc, N]`:
 * строки 0..3 — `cx, cy, w, h` в пикселях входа модели, строки 4.. — score классов (sigmoid уже в графе).
 * Затем порог, жадный NMS по классам и перевод координат из letterbox в исходное изображение.
 * Эталон — `ml/scripts/drone_detector.py::postprocess`.
 */
class YoloPostprocessor(private val labels: List<String>) {

    fun decode(
        output: FloatArray,
        shape: LongArray,
        letterbox: Letterbox,
        config: PostprocessConfig = PostprocessConfig(),
    ): List<YoloDetection> {
        require(shape.size == 3 && shape[0] == 1L && shape[1] >= 5 && shape[2] >= 0) {
            "Unexpected output shape ${shape.contentToString()}, expected [1, 4+nc, N]"
        }
        val channels = shape[1].toInt()
        val n = shape[2].toInt()
        val numClasses = channels - 4
        require(numClasses == labels.size) { "Model has $numClasses classes, but ${labels.size} labels given" }
        require(output.size.toLong() == shape[1] * shape[2]) {
            "Output size ${output.size} does not match shape ${shape.contentToString()}"
        }

        // 1. Порог уверенности (лучший класс для каждого якоря).
        val candidates = ArrayList<Candidate>()
        for (i in 0 until n) {
            var bestClass = 0
            var best = output[4 * n + i]
            for (c in 1 until numClasses) {
                val s = output[(4 + c) * n + i]
                if (s > best) {
                    best = s; bestClass = c
                }
            }
            if (!(best > config.confidenceThreshold)) continue // также отбрасывает NaN
            val cx = output[i]
            val cy = output[n + i]
            val w = output[2 * n + i]
            val h = output[3 * n + i]
            candidates += Candidate(bestClass, best, PixelBox(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2))
        }
        if (candidates.isEmpty()) return emptyList()

        // 2. NMS: сортировка по убыванию score (стабильная), жадное подавление внутри класса.
        candidates.sortByDescending { it.score }
        val kept = ArrayList<Candidate>()
        for (cand in candidates) {
            if (kept.size >= config.maxDetections) break
            val suppressed = kept.any { it.classId == cand.classId && it.box.iou(cand.box) > config.iouThreshold }
            if (!suppressed) kept += cand
        }

        // 3. Координаты входа модели -> исходное изображение, обрезка по его границам.
        val w = letterbox.srcWidth.toFloat()
        val h = letterbox.srcHeight.toFloat()
        return kept.map { c ->
            YoloDetection(
                classId = c.classId,
                label = labels[c.classId],
                confidence = c.score.coerceIn(0f, 1f),
                box = PixelBox(
                    left = letterbox.toSourceX(c.box.left).coerceIn(0f, w),
                    top = letterbox.toSourceY(c.box.top).coerceIn(0f, h),
                    right = letterbox.toSourceX(c.box.right).coerceIn(0f, w),
                    bottom = letterbox.toSourceY(c.box.bottom).coerceIn(0f, h),
                ),
            )
        }
    }

    private class Candidate(val classId: Int, val score: Float, val box: PixelBox)
}

package ru.university.dronecv.detection.yolo

import kotlin.math.floor

/**
 * Предобработка кадра для YOLO (эталон — `ml/scripts/drone_detector.py::preprocess`):
 * поворот -> letterbox (билинейное масштабирование как `cv2.INTER_LINEAR`, поля 114) ->
 * RGB, `pixel / 255` -> float32 NCHW `[1, 3, S, S]`.
 *
 * Поворот совмещён с выборкой пикселей: повёрнутая копия большого кадра не создаётся.
 * Класс не потокобезопасен (переиспользует буфер); используется под блокировкой движка.
 */
class YoloPreprocessor(val inputSize: Int, private val padValue: Int = PAD_VALUE) {

    init {
        require(inputSize > 0) { "inputSize must be positive" }
        require(padValue in 0..255) { "padValue must be in 0..255" }
    }

    /** Размер тензора `3 * S * S`. */
    val tensorSize: Int = 3 * inputSize * inputSize

    /**
     * Заполняет [out] (длина [tensorSize], порядок CHW: R, G, B) и возвращает геометрию letterbox
     * относительно повёрнутого изображения.
     */
    fun preprocess(image: ArgbImage, rotationDegrees: Int, out: FloatArray): Letterbox {
        require(out.size == tensorSize) { "out.size=${out.size}, expected $tensorSize" }
        val rotation = Rotation.of(rotationDegrees)
        val srcW = rotation.rotatedWidth(image.width, image.height)
        val srcH = rotation.rotatedHeight(image.width, image.height)
        val lb = Letterbox.compute(srcW, srcH, inputSize)
        val idx = rotation.indexer(image.width, image.height)
        val offset = idx[0]
        val stepX = idx[1]
        val stepY = idx[2]
        val px = image.pixels
        val s = inputSize
        val plane = s * s
        val pad = padValue / 255f
        out.fill(pad)

        val newW = lb.resizedWidth
        val newH = lb.resizedHeight
        if (newW == srcW && newH == srcH) {
            // Без масштабирования (как в Ultralytics: resize пропускается) — точное копирование.
            for (y in 0 until newH) {
                val rowBase = (y + lb.padTop) * s + lb.padLeft
                for (x in 0 until newW) {
                    val c = px[offset + x * stepX + y * stepY]
                    val o = rowBase + x
                    out[o] = ((c shr 16) and 0xFF) / 255f
                    out[plane + o] = ((c shr 8) and 0xFF) / 255f
                    out[2 * plane + o] = (c and 0xFF) / 255f
                }
            }
            return lb
        }

        // Билинейная интерполяция с отображением координат как в cv2.resize(INTER_LINEAR):
        // src = (dst + 0.5) * (srcSize / dstSize) - 0.5, края — повтор граничного пикселя.
        val x0 = IntArray(newW)
        val x1 = IntArray(newW)
        val wx = FloatArray(newW)
        linearTable(srcW, newW, x0, x1, wx)
        val y0 = IntArray(newH)
        val y1 = IntArray(newH)
        val wy = FloatArray(newH)
        linearTable(srcH, newH, y0, y1, wy)

        for (y in 0 until newH) {
            val fy = wy[y]
            val row0 = offset + y0[y] * stepY
            val row1 = offset + y1[y] * stepY
            val rowBase = (y + lb.padTop) * s + lb.padLeft
            for (x in 0 until newW) {
                val fx = wx[x]
                val c00 = px[row0 + x0[x] * stepX]
                val c01 = px[row0 + x1[x] * stepX]
                val c10 = px[row1 + x0[x] * stepX]
                val c11 = px[row1 + x1[x] * stepX]
                val o = rowBase + x
                out[o] = bilinear(c00 shr 16, c01 shr 16, c10 shr 16, c11 shr 16, fx, fy)
                out[plane + o] = bilinear(c00 shr 8, c01 shr 8, c10 shr 8, c11 shr 8, fx, fy)
                out[2 * plane + o] = bilinear(c00, c01, c10, c11, fx, fy)
            }
        }
        return lb
    }

    companion object {
        /** Цвет полей letterbox, как в Ultralytics. */
        const val PAD_VALUE = 114

        internal fun linearTable(srcSize: Int, dstSize: Int, i0: IntArray, i1: IntArray, w: FloatArray) {
            val scale = srcSize.toDouble() / dstSize
            for (d in 0 until dstSize) {
                var f = (d + 0.5) * scale - 0.5
                var i = floor(f).toInt()
                f -= i
                if (i < 0) {
                    i = 0; f = 0.0
                }
                if (i >= srcSize - 1) {
                    i = srcSize - 1; f = 0.0
                }
                i0[d] = i
                i1[d] = minOf(i + 1, srcSize - 1)
                w[d] = f.toFloat()
            }
        }

        /** Интерполяция одного 8-битного канала (младший байт аргументов) с округлением до uint8, затем / 255. */
        private fun bilinear(a: Int, b: Int, c: Int, d: Int, fx: Float, fy: Float): Float {
            val top = (a and 0xFF) + ((b and 0xFF) - (a and 0xFF)) * fx
            val bottom = (c and 0xFF) + ((d and 0xFF) - (c and 0xFF)) * fx
            val v = top + (bottom - top) * fy
            return (v + 0.5f).toInt().coerceIn(0, 255) / 255f
        }
    }
}

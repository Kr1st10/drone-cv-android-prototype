package ru.university.dronecv.detection.yolo

/**
 * Изображение в памяти: пиксели ARGB_8888 построчно (как `Bitmap.getPixels`), без зависимостей от Android.
 * Позволяет тестировать предобработку на JVM и на устройстве одним и тем же кодом.
 */
class ArgbImage(val width: Int, val height: Int, val pixels: IntArray) {
    init {
        require(width > 0 && height > 0) { "Image size must be positive, was ${width}x$height" }
        require(pixels.size == width * height) {
            "pixels.size=${pixels.size} does not match ${width}x$height"
        }
    }

    /** Пиксель (x, y) в формате ARGB. */
    operator fun get(x: Int, y: Int): Int = pixels[y * width + x]
}

/**
 * Поворот по часовой стрелке (0/90/180/270), который нужно применить к кадру, чтобы он стал «вертикальным»
 * (семантика `ImageInfo.rotationDegrees` в CameraX).
 */
internal class Rotation private constructor(val degrees: Int) {

    /** Размеры повёрнутого изображения. */
    fun rotatedWidth(srcW: Int, srcH: Int): Int = if (degrees == 90 || degrees == 270) srcH else srcW
    fun rotatedHeight(srcW: Int, srcH: Int): Int = if (degrees == 90 || degrees == 270) srcW else srcH

    /**
     * Индекс в исходном массиве пикселей для точки (rx, ry) повёрнутого изображения:
     * `index = offset + rx * stepX + ry * stepY`.
     */
    fun indexer(srcW: Int, srcH: Int): IntArray = when (degrees) {
        0 -> intArrayOf(0, 1, srcW)
        // rotated(rx, ry) = src(x = ry, y = H-1-rx)
        90 -> intArrayOf((srcH - 1) * srcW, -srcW, 1)
        // rotated(rx, ry) = src(W-1-rx, H-1-ry)
        180 -> intArrayOf((srcH - 1) * srcW + srcW - 1, -1, -srcW)
        // rotated(rx, ry) = src(x = W-1-ry, y = rx)
        270 -> intArrayOf(srcW - 1, srcW, -1)
        else -> error("unreachable")
    }

    companion object {
        fun of(degrees: Int): Rotation {
            val d = ((degrees % 360) + 360) % 360
            require(d % 90 == 0) { "rotationDegrees must be a multiple of 90, was $degrees" }
            return Rotation(d)
        }
    }
}

/** Явный поворот изображения (для тестов и отладки; в конвейере поворот совмещён с масштабированием). */
fun ArgbImage.rotated(degrees: Int): ArgbImage {
    val r = Rotation.of(degrees)
    if (r.degrees == 0) return this
    val w = r.rotatedWidth(width, height)
    val h = r.rotatedHeight(width, height)
    val (offset, stepX, stepY) = r.indexer(width, height).let { Triple(it[0], it[1], it[2]) }
    val out = IntArray(w * h)
    for (ry in 0 until h) for (rx in 0 until w) out[ry * w + rx] = pixels[offset + rx * stepX + ry * stepY]
    return ArgbImage(w, h, out)
}

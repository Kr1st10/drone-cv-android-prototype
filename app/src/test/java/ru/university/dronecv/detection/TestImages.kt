package ru.university.dronecv.detection

import ru.university.dronecv.detection.yolo.ArgbImage

internal fun argb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

internal fun solid(w: Int, h: Int, color: Int) = ArgbImage(w, h, IntArray(w * h) { color })

/** Изображение, где каждый пиксель уникален: R = x, G = y, B = (x + y) % 256. */
internal fun gradient(w: Int, h: Int) =
    ArgbImage(w, h, IntArray(w * h) { i -> val x = i % w; val y = i / w; argb(x % 256, y % 256, (x + y) % 256) })

/** Сырой выход [1, 5, n] из строк (cx, cy, w, h, score). */
internal fun yoloOutput(rows: List<FloatArray>, n: Int = 8400): FloatArray {
    val out = FloatArray(5 * n)
    rows.forEachIndexed { i, r -> for (c in 0 until 5) out[c * n + i] = r[c] }
    return out
}

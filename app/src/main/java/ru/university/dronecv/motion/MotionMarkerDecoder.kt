package ru.university.dronecv.motion

import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.Rotation
import kotlin.math.abs
import kotlin.math.roundToInt

internal data class MotionMarker(val runId: String, val stepId: Long)

/** Decoder for the white 12 x 10 module marker, including its one-module quiet zone. */
internal object MotionMarkerDecoder {
    // 5 MiB maximum retained scratch space, shared by serialized calls.
    private const val MAX_PIXELS = 1_048_576
    private var seen = BooleanArray(0)
    private var queue = IntArray(0)

    @Synchronized
    fun decode(image: ArgbImage, rotationDegrees: Int): MotionMarker? {
        val rotation = Rotation.of(rotationDegrees)
        val width = rotation.rotatedWidth(image.width, image.height)
        val height = rotation.rotatedHeight(image.width, image.height)
        val pixelCount = width.toLong() * height
        if (pixelCount > MAX_PIXELS) return null
        val size = pixelCount.toInt()
        if (seen.size < size) {
            seen = BooleanArray(size)
            queue = IntArray(size)
        } else {
            java.util.Arrays.fill(seen, 0, size, false)
        }
        val index = rotation.indexer(image.width, image.height)
        fun luminance(x: Int, y: Int): Int {
            val p = image.pixels[index[0] + x * index[1] + y * index[2]]
            return (77 * ((p ushr 16) and 255) + 150 * ((p ushr 8) and 255) + 29 * (p and 255)) ushr 8
        }
        // A connected white quiet zone bounds the marker.
        var found: MotionMarker? = null
        for (start in 0 until size) {
            if (seen[start]) continue
            seen[start] = true
            if (luminance(start % width, start / width) < 195) continue
            var head = 0
            var tail = 1
            queue[0] = start
            var minX = width; var maxX = 0; var minY = height; var maxY = 0
            var tl = start; var tr = start; var br = start; var bl = start
            var minSum = Int.MAX_VALUE; var maxSum = Int.MIN_VALUE
            var minDiff = Int.MAX_VALUE; var maxDiff = Int.MIN_VALUE
            while (head < tail) {
                val p = queue[head++]; val x = p % width; val y = p / width
                minX = minOf(minX, x); maxX = maxOf(maxX, x)
                minY = minOf(minY, y); maxY = maxOf(maxY, y)
                if (x + y < minSum) { minSum = x + y; tl = p }
                if (x + y > maxSum) { maxSum = x + y; br = p }
                if (x - y > maxDiff) { maxDiff = x - y; tr = p }
                if (x - y < minDiff) { minDiff = x - y; bl = p }
                fun add(nx: Int, ny: Int) {
                    if (nx !in 0 until width || ny !in 0 until height) return
                    val n = ny * width + nx
                    if (!seen[n]) {
                        seen[n] = true
                        if (luminance(nx, ny) >= 195) queue[tail++] = n
                    }
                }
                add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1)
            }
            val w = maxX - minX + 1; val h = maxY - minY + 1
            if (w < 24 || h < 20 || w > width * 3 / 4 || h > height * 3 / 4 || tail < 2 * (w + h)) continue
            val corners = intArrayOf(tl, tr, br, bl)
            if (corners.toSet().size != 4) continue
            val xs = DoubleArray(4) { (corners[it] % width).toDouble() }
            val ys = DoubleArray(4) { (corners[it] / width).toDouble() }
            // Homography of the unit square onto the candidate quadrilateral.
            val dx1 = xs[1] - xs[2]; val dx2 = xs[3] - xs[2]; val dx3 = xs[0] - xs[1] + xs[2] - xs[3]
            val dy1 = ys[1] - ys[2]; val dy2 = ys[3] - ys[2]; val dy3 = ys[0] - ys[1] + ys[2] - ys[3]
            val det = dx1 * dy2 - dx2 * dy1
            if (abs(det) < 1e-6) continue
            val g = (dx3 * dy2 - dx2 * dy3) / det
            val hh = (dx1 * dy3 - dx3 * dy1) / det
            fun sample(u: Double, v: Double): Int {
                val den = g * u + hh * v + 1
                if (abs(den) < 1e-6) return -1
                val x = (((xs[1] - xs[0] + g * xs[1]) * u + (xs[3] - xs[0] + hh * xs[3]) * v + xs[0]) / den).roundToInt()
                val y = (((ys[1] - ys[0] + g * ys[1]) * u + (ys[3] - ys[0] + hh * ys[3]) * v + ys[0]) / den).roundToInt()
                return if (x in 0 until width && y in 0 until height) luminance(x, y) else -1
            }
            var valid = true
            val bytes = IntArray(10)
            for (row in 0 until 10) for (col in 0 until 12) {
                val value = sample((col + 0.5) / 12, (row + 0.5) / 10)
                if (row == 0 || row == 9 || col == 0 || col == 11) {
                    if (value < 195) valid = false
                } else {
                    if (value in 81..194 || value < 0) valid = false
                    val bit = (row - 1) * 10 + col - 1
                    if (value in 0..80) bytes[bit / 8] = bytes[bit / 8] or (1 shl (7 - bit % 8))
                }
            }
            if (!valid || bytes[0] != 0xd1) continue
            var crc = 0
            for (i in 0 until 9) {
                crc = crc xor bytes[i]
                repeat(8) { crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x07) and 255 else (crc shl 1) and 255 }
            }
            if (crc != bytes[9]) continue
            var run = 0L; var step = 0L
            for (i in 1..4) run = (run shl 8) or bytes[i].toLong()
            for (i in 5..8) step = (step shl 8) or bytes[i].toLong()
            if (found != null) return null
            found = MotionMarker(run.toString(16).padStart(8, '0'), step)
        }
        return found
    }
}

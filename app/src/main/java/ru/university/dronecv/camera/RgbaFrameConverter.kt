package ru.university.dronecv.camera

import java.nio.ByteBuffer
import ru.university.dronecv.detection.yolo.ArgbImage

/** CameraX 1.4.1 RGBA bytes (R,G,B,A), including crop offsets and padded rows.
 * Owns reusable buffers. The returned image is borrowed until the next call on this worker.
 */
class RgbaFrameConverter {
    private var pixels = IntArray(0)
    private var row = ByteArray(0)

    fun convert(
        buffer: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int,
        left: Int, top: Int, right: Int, bottom: Int,
    ): ArgbImage {
        require(width > 0 && height > 0 && pixelStride == 4)
        require(left >= 0 && top >= 0 && right <= width && bottom <= height && right > left && bottom > top)
        require(rowStride.toLong() >= width.toLong() * pixelStride)
        val w = right - left
        val h = bottom - top
        require(w.toLong() * h <= Int.MAX_VALUE)
        val source = buffer.duplicate()
        val base = source.position()
        val end = base.toLong() + (bottom - 1L) * rowStride + right.toLong() * pixelStride
        require(end <= source.limit()) { "RGBA plane is truncated" }
        if (pixels.size != w * h) pixels = IntArray(w * h)
        if (row.size < w * pixelStride) row = ByteArray(w * pixelStride)
        for (y in 0 until h) {
            source.position(base + (top + y) * rowStride + left * pixelStride)
            source.get(row, 0, w * pixelStride)
            for (x in 0 until w) {
                val offset = x * pixelStride
                pixels[y * w + x] = (0xff shl 24) or
                    ((row[offset].toInt() and 0xff) shl 16) or
                    ((row[offset + 1].toInt() and 0xff) shl 8) or
                    (row[offset + 2].toInt() and 0xff)
            }
        }
        return ArgbImage(w, h, pixels)
    }

    fun clear() { pixels = IntArray(0); row = ByteArray(0) }
}

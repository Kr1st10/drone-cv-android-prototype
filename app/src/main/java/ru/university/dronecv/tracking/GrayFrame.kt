package ru.university.dronecv.tracking

import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.Rotation
import kotlin.math.min
import kotlin.math.sqrt

data class FrameKey(val generation: Long, val source: Long, val sequence: Long) {
    init { require(sequence > 0) }
}

/** Immutable, owned upright pixels. No reference to CameraX or the leased ARGB array is retained. */
class GrayFrame private constructor(
    val key: FrameKey,
    val stamp: FrameStamp,
    val width: Int,
    val height: Int,
    private val pixels: ByteArray,
    val cropWidth: Int = width,
    val cropHeight: Int = height,
) {
    internal fun sameGeometry(other: GrayFrame) =
        width == other.width && height == other.height && cropWidth == other.cropWidth && cropHeight == other.cropHeight

    val byteSize: Int get() = pixels.size
    operator fun get(x: Int, y: Int): Int = pixels[y * width + x].toInt() and 255
    fun copyPixels(): ByteArray = pixels.copyOf()

    internal fun sample(x: Double, y: Double): Double {
        val px = x.coerceIn(0.0, (width - 1).toDouble())
        val py = y.coerceIn(0.0, (height - 1).toDouble())
        val x0 = px.toInt(); val y0 = py.toInt()
        val x1 = min(x0 + 1, width - 1); val y1 = min(y0 + 1, height - 1)
        val dx = px - x0; val dy = py - y0
        return (this[x0, y0] * (1 - dx) + this[x1, y0] * dx) * (1 - dy) +
            (this[x0, y1] * (1 - dx) + this[x1, y1] * dx) * dy
    }

    companion object {
        const val MAX_BYTES = 1024 * 1024

        fun copyOf(key: FrameKey, stamp: FrameStamp, width: Int, height: Int, pixels: ByteArray): GrayFrame {
            require(stamp.analyzerEntryNs >= 0)
            require(width > 0 && height > 0 && width.toLong() * height == pixels.size.toLong())
            require(pixels.size <= MAX_BYTES)
            return GrayFrame(key, stamp, width, height, pixels.copyOf())
        }

        fun fromArgb(key: FrameKey, stamp: FrameStamp, image: ArgbImage, rotationDegrees: Int): GrayFrame {
            require(stamp.analyzerEntryNs >= 0)
            require(rotationDegrees in setOf(0, 90, 180, 270))
            val rotation = Rotation.of(rotationDegrees)
            val cropWidth = rotation.rotatedWidth(image.width, image.height)
            val cropHeight = rotation.rotatedHeight(image.width, image.height)
            val area = cropWidth.toLong() * cropHeight
            // Leave enough history for delayed YOLO even when CameraX falls back to a large crop.
            val scale = if (area > MAX_BYTES) sqrt((640.0 * 480) / area) else 1.0
            val h = (cropHeight * scale).toInt().coerceIn(1, MAX_BYTES)
            val w = (cropWidth * scale).toInt().coerceIn(1, MAX_BYTES / h)
            val index = rotation.indexer(image.width, image.height)
            val gray = ByteArray(w * h)
            val column = IntArray(w) { x -> ((x + .5) * cropWidth / w).toInt() * index[1] }
            for (y in 0 until h) {
                val row = index[0] + ((y + .5) * cropHeight / h).toInt() * index[2]
                for (x in 0 until w) {
                    val argb = image.pixels[row + column[x]]
                    gray[y * w + x] = ((77 * ((argb ushr 16) and 255) +
                        150 * ((argb ushr 8) and 255) + 29 * (argb and 255) + 128) ushr 8).toByte()
                }
            }
            return GrayFrame(key, stamp, w, h, gray, cropWidth, cropHeight)
        }
    }
}

/** Single-owner history; a replay plan can pin at most one additional bounded snapshot of this history. */
internal class GrayHistory(private val maxFrames: Int = 32, private val maxBytes: Int = 8 * 1024 * 1024) {
    init { require(maxFrames > 0 && maxBytes > 0) }
    private val frames = ArrayDeque<GrayFrame>()
    var bytes: Int = 0
        private set
    val latest: GrayFrame? get() = frames.lastOrNull()
    fun clear() { frames.clear(); bytes = 0 }
    fun add(frame: GrayFrame) {
        require(frame.byteSize <= maxBytes)
        frames.addLast(frame)
        bytes += frame.byteSize
        while (frames.size > maxFrames || bytes > maxBytes) bytes -= frames.removeFirst().byteSize
    }
    fun from(key: FrameKey): List<GrayFrame>? {
        val start = frames.indexOfFirst { it.key == key }
        return if (start < 0) null else frames.drop(start)
    }
}

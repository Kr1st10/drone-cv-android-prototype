package ru.university.dronecv.camera

import ru.university.dronecv.detection.yolo.ArgbImage

/** At most three ARGB buffers: one in inference, one pending, one being copied. */
class CameraFramePool(private val maxBytes: Long = 16L * 1024 * 1024) {
    init { require(maxBytes > 0) }
    private class Slot(var pixels: IntArray = IntArray(0), var used: Boolean = false)
    private val slots = List(3) { Slot() }

    class Lease internal constructor(val pixels: IntArray, private val release: () -> Unit) : AutoCloseable {
        private var closed = false
        @Synchronized override fun close() {
            if (!closed) { closed = true; release() }
        }
    }

    @Synchronized fun acquire(width: Int, height: Int): Lease? {
        require(width > 0 && height > 0)
        val count = width.toLong() * height
        if (count > Int.MAX_VALUE || count * 4 > maxBytes) return null
        val free = slots.filter { !it.used }
        val slot = free.firstOrNull { it.pixels.size.toLong() == count } ?: free.firstOrNull() ?: return null
        if (slot.pixels.size.toLong() != count) {
            // Unused buffers of an old crop can be discarded; leased buffers must remain untouched.
            free.forEach { it.pixels = IntArray(0) }
            val held = slots.sumOf { it.pixels.size.toLong() * 4 }
            if (held + count * 4 > maxBytes) return null
            slot.pixels = IntArray(count.toInt())
        }
        slot.used = true
        return Lease(slot.pixels) { synchronized(this) { slot.used = false } }
    }

    val allocatedBytes: Long @Synchronized get() = slots.sumOf { it.pixels.size.toLong() * 4 }
}

/** Owns raw crop pixels until inference finishes; YOLO applies [rotationDegrees] exactly once. */
class CameraFrameSnapshot(
    val image: ArgbImage,
    val rotationDegrees: Int,
    val conversionMs: Double,
    private val lease: CameraFramePool.Lease,
) : AutoCloseable {
    init {
        require(rotationDegrees in setOf(0, 90, 180, 270))
        require(conversionMs.isFinite() && conversionMs >= 0)
        require(image.pixels === lease.pixels)
    }
    override fun close() = lease.close()
}

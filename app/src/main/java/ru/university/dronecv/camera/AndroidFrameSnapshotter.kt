package ru.university.dronecv.camera

import androidx.camera.core.ImageProxy

/** Called only on VisionWorker, before closing ImageProxy. No camera buffer escapes this call. */
class AndroidFrameSnapshotter(private val pool: CameraFramePool = CameraFramePool()) {
    private val converter = RgbaFrameConverter()

    fun copy(frame: ImageProxy): PreparedLiveFrame<CameraFrameSnapshot>? {
        val start = System.nanoTime()
        val crop = frame.cropRect
        val rotation = frame.imageInfo.rotationDegrees
        val lease = pool.acquire(crop.width(), crop.height()) ?: return null
        try {
            val plane = frame.planes[0]
            val image = converter.copyInto(plane.buffer, frame.width, frame.height, plane.rowStride,
                plane.pixelStride, crop.left, crop.top, crop.right, crop.bottom, lease.pixels)
            val elapsed = (System.nanoTime() - start) / 1_000_000.0
            return PreparedLiveFrame(CameraFrameSnapshot(image, rotation, elapsed, lease), elapsed)
        } catch (e: Throwable) {
            lease.close()
            throw e
        }
    }
}

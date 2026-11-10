package ru.university.dronecv.camera

import android.util.Log
import androidx.camera.core.ImageProxy

/** Called only on VisionWorker, before closing ImageProxy. No camera buffer escapes this call. */
class AndroidFrameSnapshotter(private val pool: CameraFramePool = CameraFramePool()) {
    private val converter = RgbaFrameConverter()
    private var lastGeometry: String? = null

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
            // These are actual ImageAnalysis/crop dimensions, not the requested resolution or
            // the model's 640x640 letterbox tensor. Log changes only, on the owning VisionWorker.
            val uprightWidth = if (rotation == 90 || rotation == 270) image.height else image.width
            val uprightHeight = if (rotation == 90 || rotation == 270) image.width else image.height
            val geometry = "ImageAnalysis=${frame.width}x${frame.height}, crop=$crop, " +
                "rotation=$rotation, YOLO source=${uprightWidth}x${uprightHeight}"
            if (geometry != lastGeometry) {
                Log.i("CameraInput", geometry)
                lastGeometry = geometry
            }
            return PreparedLiveFrame(CameraFrameSnapshot(image, rotation, elapsed, lease), elapsed)
        } catch (e: Throwable) {
            lease.close()
            throw e
        }
    }
}

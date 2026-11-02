package ru.university.dronecv.camera

import android.content.Context
import android.util.Log
import androidx.camera.core.ImageProxy
import ru.university.dronecv.detection.onnx.OnnxDroneDetector
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.toDetection

class AndroidLiveBackend(context: Context) : LiveBackend<ImageProxy> {
    private val app = context.applicationContext
    private var detector: OnnxDroneDetector? = null
    private val converter = RgbaFrameConverter()

    override fun infer(frame: ImageProxy, confidence: Float): LiveInference {
        try {
            val active = detector ?: OnnxDroneDetector.create(app).also { detector = it }
            val plane = frame.planes[0]
            val crop = frame.cropRect
            val image = converter.convert(plane.buffer, frame.width, frame.height,
                plane.rowStride, plane.pixelStride, crop.left, crop.top, crop.right, crop.bottom)
            val result = active.detectArgbDetailed(image, frame.imageInfo.rotationDegrees,
                PostprocessConfig(confidenceThreshold = confidence))
            return LiveInference(result.detections.map { it.toDetection(result.imageWidth, result.imageHeight) },
                result.imageWidth, result.imageHeight, result.inferenceMs)
        } catch (e: Exception) {
            Log.e("LiveDetection", "Frame inference failed", e)
            throw e
        }
    }

    override fun close() {
        try { detector?.close() } catch (e: Exception) { Log.e("LiveDetection", "Model release failed", e) }
        detector = null
        converter.clear()
    }
}

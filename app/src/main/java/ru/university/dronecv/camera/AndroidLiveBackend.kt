package ru.university.dronecv.camera

import android.content.Context
import android.util.Log
import androidx.camera.core.ImageProxy
import ru.university.dronecv.detection.onnx.OnnxDroneDetector
import ru.university.dronecv.detection.onnx.YoloEngineOptions
import ru.university.dronecv.detection.onnx.ThreadSessionManager
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.toDetection

class AndroidLiveBackend(context: Context, initialThreads: Int = 2) : LiveBackend<ImageProxy> {
    private val app = context.applicationContext
    private val sessions = ThreadSessionManager(initialThreads) { threads ->
        OnnxDroneDetector.create(app, YoloEngineOptions(intraOpThreads = threads))
    }
    private val converter = RgbaFrameConverter()

    override fun infer(frame: ImageProxy, confidence: Float): LiveInference {
        try {
            val active = sessions.session()
            val conversionStart = System.nanoTime()
            val plane = frame.planes[0]
            val crop = frame.cropRect
            val image = converter.convert(plane.buffer, frame.width, frame.height,
                plane.rowStride, plane.pixelStride, crop.left, crop.top, crop.right, crop.bottom)
            val conversionEnd = System.nanoTime()
            val result = active.detectArgbDetailed(image, frame.imageInfo.rotationDegrees,
                PostprocessConfig(confidenceThreshold = confidence))
            return LiveInference(result.detections.map { it.toDetection(result.imageWidth, result.imageHeight) },
                result.imageWidth, result.imageHeight, result.inferenceMs,
                (conversionEnd - conversionStart) / 1_000_000.0, result.preprocessMs, result.postprocessMs)
        } catch (e: Exception) {
            Log.e("LiveDetection", "Frame inference failed", e)
            throw e
        }
    }

    override fun changeThreads(threads: Int) = sessions.switchTo(threads)

    override fun close() {
        try { sessions.close() } catch (e: Exception) { Log.e("LiveDetection", "Model release failed", e) }
        converter.clear()
    }
}

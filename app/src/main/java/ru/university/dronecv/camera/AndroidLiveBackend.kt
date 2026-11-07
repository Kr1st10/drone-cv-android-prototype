package ru.university.dronecv.camera

import android.content.Context
import android.util.Log
import ru.university.dronecv.detection.onnx.OnnxDroneDetector
import ru.university.dronecv.detection.onnx.YoloEngineOptions
import ru.university.dronecv.detection.onnx.ThreadSessionManager
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.toDetection

class AndroidLiveBackend(context: Context, initialThreads: Int = 2) : LiveBackend<CameraFrameSnapshot> {
    private val app = context.applicationContext
    private val sessions = ThreadSessionManager(initialThreads) { threads ->
        OnnxDroneDetector.create(app, YoloEngineOptions(intraOpThreads = threads))
    }

    override fun infer(frame: CameraFrameSnapshot, confidence: Float): LiveInference {
        try {
            val active = sessions.session()
            val result = active.detectArgbDetailed(frame.image, frame.rotationDegrees,
                PostprocessConfig(confidenceThreshold = confidence))
            return LiveInference(result.detections.map { it.toDetection(result.imageWidth, result.imageHeight) },
                result.imageWidth, result.imageHeight, result.inferenceMs,
                frame.conversionMs, result.preprocessMs, result.postprocessMs)
        } catch (e: Exception) {
            Log.e("LiveDetection", "Frame inference failed", e)
            throw e
        }
    }

    override fun changeThreads(threads: Int) = sessions.switchTo(threads)

    override fun close() {
        try { sessions.close() } catch (e: Exception) { Log.e("LiveDetection", "Model release failed", e) }
    }
}

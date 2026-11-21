package ru.university.dronecv.qnn

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import ru.university.dronecv.camera.AndroidLiveBackend
import ru.university.dronecv.camera.CameraFrameSnapshot
import ru.university.dronecv.camera.LiveBackend
import ru.university.dronecv.camera.LiveInference
import ru.university.dronecv.camera.toLiveInference

/** Selection is set by the camera controls while stopped. Native state stays on the ML worker. */
internal class QnnCameraBackend(context: Context, initialThreads: Int, yoloOnly: Boolean) :
    LiveBackend<CameraFrameSnapshot> {

    private val app = context.applicationContext
    private var cpu = AndroidLiveBackend(app, initialThreads)
    private var htp: QnnBenchmark.CameraSession? = null
    private var threads = initialThreads
    private var warmed = false

    private val selected = MutableStateFlow(if (yoloOnly) BenchmarkProvider.CPU else null)
    val selection = selected.asStateFlow()

    fun select(provider: BenchmarkProvider?) {
        selected.value = provider
    }

    override fun warmUp(frame: CameraFrameSnapshot, confidence: Float): Boolean {
        val provider = selected.value ?: return false
        if (warmed) return false
        releaseHtp()
        if (provider == BenchmarkProvider.HTP) {
            cpu.close()
            val session = QnnBenchmark.CameraSession()
            htp = session
            try {
                session.warmUp(app, threads, frame, confidence)
            } catch (e: LinkageError) {
                throw IllegalStateException("QNN HTP: ${e.message}", e)
            }
        } else {
            repeat(QnnBenchmark.WARMUPS) { cpu.infer(frame, confidence) }
        }
        warmed = true
        Log.i(TAG, "${provider.name} warmed")
        return true
    }

    override fun infer(frame: CameraFrameSnapshot, confidence: Float): LiveInference {
        if (selected.value != BenchmarkProvider.HTP) return cpu.infer(frame, confidence)
        val session = checkNotNull(htp?.takeIf { warmed }) { "Сессия QNN HTP не прогрета" }
        try {
            return session.detect(frame, confidence).toLiveInference(frame, session.inputSize)
                .copy(htpProfileNodeEvents = session.profileNodeEvents)
        } catch (e: LinkageError) {
            throw IllegalStateException("QNN HTP: ${e.message}", e)
        }
    }

    override fun changeThreads(threads: Int) {
        releaseHtp()
        if (selected.value == BenchmarkProvider.HTP) {
            cpu.close()
            cpu = AndroidLiveBackend(app, threads)
        } else {
            cpu.changeThreads(threads)
        }
        this.threads = threads
    }

    private fun releaseHtp() {
        val session = htp ?: return
        session.close()
        htp = null
        Log.i(TAG, "HTP closed")
    }

    override fun close() {
        warmed = false
        cpu.close()
        try {
            releaseHtp()
        } catch (e: Exception) {
            Log.e(TAG, "HTP release failed", e)
        }
    }

    private companion object {
        const val TAG = "QnnCamera"
    }
}

package ru.university.dronecv.camera

import java.util.concurrent.Executor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.diagnostics.DiagnosticFrames

enum class LivePhase { STOPPED, STARTING, RUNNING, ERROR }

data class LiveInference(
    val detections: List<Detection>,
    val width: Int,
    val height: Int,
    val inferenceMs: Double,
    val conversionMs: Double? = null,
    val preprocessMs: Double? = null,
    val postprocessMs: Double? = null,
)

data class LiveState(
    val phase: LivePhase = LivePhase.STOPPED,
    val result: LiveInference? = null,
    val pipelineMs: Double? = null,
    val fps: Double? = null,
    val completedFrames: Long = 0,
    val error: String? = null,
    val revision: Long = 0,
)

/** All backend methods run on the same worker, including release after pause or failure. */
interface LiveBackend<Frame> : AutoCloseable {
    fun infer(frame: Frame, confidence: Float): LiveInference
}

/**
 * Synchronous analyzer: CameraX KEEP_ONLY_LATEST owns scheduling; there is no second frame queue.
 * Main-thread controls only touch short state locks. Native calls and release stay on [worker].
 * Every frame is closed, even when stopped, superseded, or failing. Both results and errors carry
 * a generation, so stop/resume/threshold/rebind cannot publish an obsolete completion.
 */
class LiveController<Frame : AutoCloseable>(
    private val backend: LiveBackend<Frame>,
    private val worker: Executor,
    private val diagnostics: DiagnosticFrames? = null,
    private val nanoTime: () -> Long = System::nanoTime,
) : AutoCloseable {
    private val lock = Any()
    private val mutableState = MutableStateFlow(LiveState())
    val state = mutableState.asStateFlow()
    private var active = false
    private var closed = false
    private var busy = false
    private var confidence = 0.5f
    private var generation = 0L
    private var revision = 0L
    private var source = 0L
    private val completions = ArrayDeque<Long>()

    fun configure(enabled: Boolean, threshold: Float) = synchronized(lock) {
        require(threshold in 0.01f..1f)
        if (closed || (active == enabled && confidence == threshold)) return@synchronized
        val wasActive = active
        active = enabled
        confidence = threshold
        generation++
        completions.clear()
        mutableState.value = LiveState(
            phase = if (active) LivePhase.STARTING else LivePhase.STOPPED,
            revision = ++revision,
        )
        if (wasActive && !active) worker.execute { backend.close() }
    }

    fun updateThreshold(threshold: Float) = synchronized(lock) { configure(active, threshold) }

    /** A new binding cannot accept callbacks left queued by an older use case. */
    fun newSource(): Long = synchronized(lock) {
        configure(false, confidence)
        ++source
    }

    /** Call only on the worker supplied to CameraX.setAnalyzer. */
    fun analyze(frame: Frame, sourceId: Long? = null) {
        try {
            val request = synchronized(lock) {
                if (closed || !active || busy || (sourceId != null && sourceId != source) ||
                    mutableState.value.phase == LivePhase.ERROR) null
                else { busy = true; generation to confidence }
            } ?: return
            val token = diagnostics?.currentToken()
            if (token != null) diagnostics?.received(token)
            try {
                val start = nanoTime()
                val result = backend.infer(frame, request.second)
                val end = nanoTime()
                synchronized(lock) {
                    if (!closed && active && generation == request.first) {
                        if (token != null && result.conversionMs != null && result.preprocessMs != null && result.postprocessMs != null) {
                            diagnostics?.completed(token, end, result.conversionMs, result.preprocessMs,
                                result.inferenceMs, result.postprocessMs, (end - start) / 1_000_000.0)
                        }
                        completions.addLast(end)
                        while (completions.size > 30 ||
                            (completions.size > 2 && end - completions.first() > 3_000_000_000L)) {
                            completions.removeFirst()
                        }
                        val elapsed = end - completions.first()
                        val fps = if (completions.size > 1 && elapsed > 0)
                            (completions.size - 1) * 1_000_000_000.0 / elapsed else null
                        val previous = mutableState.value
                        mutableState.value = LiveState(
                            LivePhase.RUNNING, result, (end - start) / 1_000_000.0, fps,
                            previous.completedFrames + 1, revision = ++revision,
                        )
                    }
                }
            } catch (e: Exception) {
                fail(request.first, e.message ?: e.javaClass.simpleName)
            } catch (_: OutOfMemoryError) {
                fail(request.first, "Недостаточно памяти. Остановите детекцию и повторите запуск.")
            } finally {
                synchronized(lock) { busy = false }
            }
        } finally {
            frame.close()
        }
    }

    private fun fail(id: Long, message: String) = synchronized(lock) {
        if (closed || !active || generation != id) return@synchronized
        generation++
        mutableState.value = LiveState(LivePhase.ERROR, error = message, revision = ++revision)
        worker.execute { backend.close() }
    }

    /** Clear boxes if the camera stops supplying frames without reporting an error. */
    fun expire(revision: Long) = synchronized(lock) {
        if (mutableState.value.revision == revision && mutableState.value.result != null) {
            mutableState.value = mutableState.value.copy(result = null, fps = null, pipelineMs = null)
        }
    }

    override fun close() = synchronized(lock) {
        if (closed) return@synchronized
        closed = true
        active = false
        generation++
        source++
        mutableState.value = LiveState(revision = ++revision)
        worker.execute { backend.close() } // ordered after any in-flight native call; never wait on UI.
    }
}

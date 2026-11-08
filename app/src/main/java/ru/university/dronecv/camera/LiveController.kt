package ru.university.dronecv.camera

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.GrayFrame
import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.YoloRequest
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
    val target: TargetSignal? = null,
    val tracking: TrackingSignal? = null,
    val trackingFps: Double? = null,
)

/** All backend methods run on the same worker, including release after pause or failure. */
interface LiveBackend<Frame> : AutoCloseable {
    fun infer(frame: Frame, confidence: Float): LiveInference
    fun changeThreads(threads: Int) { throw UnsupportedOperationException("Thread switching unsupported") }
}

data class ThreadConfiguration(val threads: Int = 2, val switching: Boolean = false, val error: String? = null)

/**
 * Native inference stays on [worker]. Camera input offers owned snapshots through a latest-only slot.
 * Main-thread controls only touch short state locks. Native calls and release stay on [worker].
 * Every frame is closed, even when stopped, superseded, or failing. Both results and errors carry
 * a generation, so stop/resume/threshold/rebind cannot publish an obsolete completion.
 */
class LiveController<Frame : AutoCloseable>(
    private val backend: LiveBackend<Frame>,
    private val worker: Executor,
    private val diagnostics: DiagnosticFrames? = null,
    initialThreads: Int = 2,
    private val eventTime: (() -> Long)? = null,
    private val maxAnalyzerAgeMs: Double = 250.0,
    private val tracking: LiveTracking<Frame>? = null,
    private val nanoTime: () -> Long = System::nanoTime,
) : AutoCloseable {
    init {
        require(maxAnalyzerAgeMs.isFinite() && maxAnalyzerAgeMs >= 0)
        require(tracking == null || eventTime != null)
    }
    private val lock = Any()
    private val mutableState = MutableStateFlow(LiveState())
    val state = mutableState.asStateFlow()
    private val mutableSignals = MutableStateFlow<TargetSignal?>(null)
    /** Conflated internal signal stream; null invalidates the target on Stop/pause/error/expiry. */
    val signals = mutableSignals.asStateFlow()
    private var frameId = 0L
    private val mutableThreads = MutableStateFlow(ThreadConfiguration(initialThreads))
    val threadConfiguration = mutableThreads.asStateFlow()
    private var active = false
    private var closed = false
    private var busy = false
    private var confidence = 0.5f
    private var generation = 0L
    private var revision = 0L
    private var source = 0L
    private val completions = ArrayDeque<Long>()
    private val arrivals = ArrayDeque<Long>()
    private val mutableInput = MutableStateFlow(CameraInputStats())
    val input = mutableInput.asStateFlow()
    private data class Pending<F>(val frame: F, val token: LiveFrameToken, val stamp: FrameStamp,
                                 val preparationMs: Double, val queuedNs: Long)
    private var pending: Pending<Frame>? = null
    private var pumpScheduled = false
    private var pumpEpoch = 0L

    private fun valid(token: LiveFrameToken): Boolean = !closed && active &&
        generation == token.generation && source == token.source && mutableState.value.phase != LivePhase.ERROR

    private fun inputEvent(token: LiveFrameToken, event: CameraInputEvent, copyMs: Double = 0.0) {
        token.diagnosticToken?.let { diagnostics?.input(it, event, copyMs) }
        if (valid(token)) mutableInput.value = mutableInput.value.record(event, copyMs)
    }

    /** Called before copying, so a threshold/Stop change during preparation cannot retag an old frame. */
    fun beginFrame(sourceId: Long, stamp: FrameStamp): LiveFrameToken? = synchronized(lock) {
        val token = LiveFrameToken(generation, sourceId, diagnostics?.currentToken())
        if (!valid(token)) return@synchronized null
        inputEvent(token, CameraInputEvent.RECEIVED)
        if (!valid(token)) return@synchronized null
        arrivals.addLast(stamp.analyzerEntryNs)
        while (arrivals.size > 30) arrivals.removeFirst()
        val span = stamp.analyzerEntryNs - arrivals.first()
        mutableInput.value = mutableInput.value.copy(fps = if (arrivals.size > 1 && span > 0)
            (arrivals.size - 1) * 1_000_000_000.0 / span else null)
        if (!valid(token)) return@synchronized null
        if (stamp.ageAt(stamp.analyzerEntryNs)?.let { it > maxAnalyzerAgeMs } == true) {
            inputEvent(token, CameraInputEvent.STALE)
            token.diagnosticToken?.let { diagnostics?.discardStale(it) }
            null
        } else token
    }

    fun noFrameBuffer(token: LiveFrameToken) = synchronized(lock) { inputEvent(token, CameraInputEvent.NO_BUFFER) }

    fun captureFailed(token: LiveFrameToken, message: String) = synchronized(lock) {
        inputEvent(token, CameraInputEvent.ERROR)
        fail(token.generation, message)
    }

    /** Takes ownership even on rejection. One current pump and one replaceable pending snapshot exist. */
    fun offerFrame(frame: Frame, token: LiveFrameToken, stamp: FrameStamp, preparationMs: Double) {
        tracking?.let { offerTrackingFrame(it, frame, token, stamp, preparationMs); return }
        var retained = false
        try {
            if (!preparationMs.isFinite() || preparationMs < 0) {
                captureFailed(token, "Некорректное время копирования кадра.")
                return
            }
            val schedule = synchronized(lock) {
                inputEvent(token, CameraInputEvent.COPIED, preparationMs)
                if (!valid(token)) {
                    inputEvent(token, CameraInputEvent.INVALIDATED)
                    return@synchronized null
                }
                val next = Pending(frame, token, stamp, preparationMs, nanoTime())
                val previous = pending
                pending = next
                retained = true
                if (previous != null) {
                    try { inputEvent(previous.token, CameraInputEvent.SUPERSEDED) }
                    finally { previous.frame.close() }
                }
                if (pumpScheduled) null else { pumpScheduled = true; pumpEpoch }
            }
            if (schedule != null) schedulePump(schedule)
        } finally {
            // Allocation/clock failures before storing pending must still return the offered lease.
            if (!retained) frame.close()
        }
    }

    private fun offerTrackingFrame(live: LiveTracking<Frame>, frame: Frame, token: LiveFrameToken,
                                   stamp: FrameStamp, preparationMs: Double) {
        var submitted = false
        try {
            if (!preparationMs.isFinite() || preparationMs < 0) {
                captureFailed(token, "Некорректное время копирования кадра.")
                return
            }
            val accepted = synchronized(lock) {
                inputEvent(token, CameraInputEvent.COPIED, preparationMs)
                valid(token).also { if (!it) inputEvent(token, CameraInputEvent.INVALIDATED) }
            }
            if (!accepted) return
            live.reset(token.generation, token.source)
            val start = nanoTime()
            val gray = live.grayscale(frame, FrameKey(token.generation, token.source, ++live.sequence), stamp)
            val observation = live.session.observe(gray) ?: return
            live.latestToken = token
            publishTracking(live, token, observation, gray, TrackingSampleKind.FRAME, start)
            if (!synchronized(lock) { valid(token) }) return
            val request = live.session.requestYolo(!live.inFlight, checkNotNull(eventTime)()) ?: return
            live.inFlight = true
            try {
                val queued = nanoTime()
                worker.execute { runTrackingYolo(live, frame, token, stamp, preparationMs, queued, request) }
                submitted = true
            } catch (_: RejectedExecutionException) {
                finishTracking(live, request)
                fail(token.generation, "Worker обработки кадров недоступен.", release = false)
            } catch (e: Throwable) {
                finishTracking(live, request)
                throw e
            }
        } catch (e: Exception) {
            fail(token.generation, e.message ?: e.javaClass.simpleName)
        } catch (_: OutOfMemoryError) {
            fail(token.generation, "Недостаточно памяти для трекинга.")
        } catch (e: LinkageError) {
            fail(token.generation, "Не удалось загрузить OpenCV: ${e.message}")
        } finally {
            if (!submitted) frame.close()
        }
    }

    private fun runTrackingYolo(live: LiveTracking<Frame>, frame: Frame, token: LiveFrameToken, stamp: FrameStamp,
                                preparationMs: Double, queued: Long, request: YoloRequest) {
        try {
            val result = analyze(frame, token.source, stamp, token, preparationMs, queued, forTracking = true)
            onVision(live, token) { handleYolo(live, token, request, result) }
        } catch (e: Exception) {
            trackingFailed(live, token, request, e)
        } catch (e: OutOfMemoryError) {
            trackingFailed(live, token, request, e)
        } catch (e: LinkageError) {
            trackingFailed(live, token, request, e)
        }
    }

    private fun handleYolo(live: LiveTracking<Frame>, token: LiveFrameToken, request: YoloRequest,
                           result: LiveInference?) {
        var replayScheduled = false
        try {
            if (!synchronized(lock) { valid(token) } || result == null) return
            check(result.width == request.anchor.cropWidth && result.height == request.anchor.cropHeight) {
                "Размер кадра YOLO не совпадает с кадром трекера."
            }
            val plan = live.session.prepareCorrection(request, result.detections) ?: return
            worker.execute {
                try {
                    val start = nanoTime()
                    val correction = if (synchronized(lock) { valid(token) }) plan.replay(nanoTime) else null
                    val replayMs = (nanoTime() - start) / 1e6
                    var transferred = false
                    try {
                        transferred = onVision(live, token) {
                            try {
                                if (!synchronized(lock) { valid(token) }) return@onVision
                                if (correction == null) {
                                    live.session.rejectCorrection(request)
                                    return@onVision
                                }
                                val commitStart = nanoTime()
                                val observation = live.session.commit(correction, checkNotNull(eventTime)()) ?: return@onVision
                                publishTracking(live, checkNotNull(live.latestToken), observation, request.anchor,
                                    TrackingSampleKind.CORRECTION, commitStart, replayMs)
                            } finally {
                                try { correction?.close() } finally { finishTracking(live, request) }
                            }
                        }
                    } finally { if (!transferred) correction?.close() }
                } catch (e: Exception) {
                    trackingFailed(live, token, request, e)
                } catch (e: LinkageError) {
                    trackingFailed(live, token, request, e)
                } catch (e: OutOfMemoryError) {
                    trackingFailed(live, token, request, e)
                }
            }
            replayScheduled = true
        } catch (_: RejectedExecutionException) {
            fail(token.generation, "Worker обработки кадров недоступен.", release = false)
        } finally { if (!replayScheduled) finishTracking(live, request) }
    }

    private fun onVision(live: LiveTracking<Frame>, token: LiveFrameToken, block: () -> Unit): Boolean =
        try {
            live.executor.execute { guardVision(token.generation, block) }
            true
        } catch (_: RejectedExecutionException) {
            live.inFlight = false
            fail(token.generation, "Worker камеры недоступен.")
            false
        }

    private fun guardVision(id: Long, block: () -> Unit) {
        try { block() }
        catch (e: Exception) { fail(id, e.message ?: e.javaClass.simpleName) }
        catch (_: OutOfMemoryError) { fail(id, "Недостаточно памяти для трекинга.") }
        catch (e: LinkageError) { fail(id, "Ошибка OpenCV: ${e.message}") }
    }

    private fun trackingFailed(live: LiveTracking<Frame>, token: LiveFrameToken, request: YoloRequest, error: Throwable) {
        onVision(live, token) {
            finishTracking(live, request)
            fail(token.generation, error.message ?: error.javaClass.simpleName)
        }
    }

    private fun finishTracking(live: LiveTracking<Frame>, request: YoloRequest) {
        live.session.finish(request)
        live.inFlight = false
    }

    private fun publishTracking(live: LiveTracking<Frame>, token: LiveFrameToken, observation: TrackingObservation,
                                geometry: GrayFrame, kind: TrackingSampleKind, start: Long, extraMs: Double = 0.0) =
        synchronized(lock) {
            if (!valid(token)) return@synchronized
            val now = checkNotNull(eventTime)()
            if (observation.estimate != null &&
                (!live.session.confirmationIsCurrent(observation, now) ||
                    now - observation.stamp.analyzerEntryNs > maxAnalyzerAgeMs * 1e6 ||
                    observation.stamp.ageAt(now)?.let { it > maxAnalyzerAgeMs } == true)) {
                mutableState.value = mutableState.value.copy(tracking = null, trackingFps = null, revision = ++revision)
                return@synchronized
            }
            val end = nanoTime()
            val signal = TrackingSignal(observation, kind, geometry.cropWidth, geometry.cropHeight, now,
                extraMs + (end - start) / 1e6, geometry.width, geometry.height)
            val fps = live.fps(signal)
            mutableState.value = mutableState.value.copy(tracking = signal, trackingFps = fps, revision = ++revision)
            token.diagnosticToken?.let { diagnostics?.tracking(it, end, signal) }
        }

    private fun resetTracking(id: Long, sourceId: Long) {
        tracking?.let { live ->
            try { live.executor.execute { guardVision(id) { live.reset(id, sourceId) } } }
            catch (_: RejectedExecutionException) { /* Never release vision-owned state on another thread. */ }
        }
    }

    private fun clearPending() {
        val old = pending
        pending = null
        if (old != null) {
            inputEvent(old.token, CameraInputEvent.INVALIDATED)
            old.frame.close()
        }
    }

    private fun invalidatePending() {
        pumpEpoch++
        pumpScheduled = false
        clearPending()
    }

    private fun schedulePump(epoch: Long) {
        try { worker.execute { runPending(epoch) } }
        catch (_: java.util.concurrent.RejectedExecutionException) {
            synchronized(lock) {
                if (epoch != pumpEpoch) return@synchronized
                val id = pending?.token?.generation
                pumpScheduled = false
                clearPending()
                // A rejected worker cannot perform release; never move native close to the input thread.
                if (id != null) fail(id, "Worker обработки кадров недоступен.", release = false)
            }
        }
    }

    private fun runPending(epoch: Long) {
        val next = synchronized(lock) {
            if (epoch != pumpEpoch) return
            pending.also { pending = null }
        }
        try {
            if (next != null) analyze(next.frame, next.token.source, next.stamp, next.token,
                next.preparationMs, next.queuedNs)
        } finally {
            val again = synchronized(lock) {
                if (epoch != pumpEpoch) false
                else if (pending == null) { pumpScheduled = false; false } else true
            }
            if (again) schedulePump(epoch) // yield to close/configuration/photo tasks already queued.
        }
    }

    fun configure(enabled: Boolean, threshold: Float) = synchronized(lock) {
        require(threshold in 0.01f..1f)
        if (closed || (enabled && mutableThreads.value.switching) || (active == enabled && confidence == threshold)) return@synchronized
        val wasActive = active
        active = enabled
        confidence = threshold
        val configuredGeneration = ++generation
        completions.clear()
        arrivals.clear()
        invalidatePending()
        resetTracking(configuredGeneration, source)
        if (wasActive && !active) worker.execute { backend.close() }
        mutableInput.value = CameraInputStats()
        mutableSignals.value = null
        if (generation == configuredGeneration && !closed) {
            mutableState.value = LiveState(
                phase = if (active) LivePhase.STARTING else LivePhase.STOPPED,
                revision = ++revision,
            )
        }
    }

    /** Apply only after stopping detection and recording; all session work is ordered on the ML worker. */
    fun requestThreads(threads: Int): Boolean = synchronized(lock) {
        require(threads in setOf(1, 2, 4))
        if (closed) return@synchronized false
        if (active || busy || diagnostics?.currentToken() != null || mutableThreads.value.switching) {
            if (!mutableThreads.value.switching) mutableThreads.value = mutableThreads.value.copy(
                error = "Остановите детекцию и дождитесь завершения обработки кадра.")
            return@synchronized false
        }
        if (threads == mutableThreads.value.threads) return@synchronized true
        val previous = mutableThreads.value.threads
        mutableThreads.value = ThreadConfiguration(previous, switching = true)
        worker.execute {
            if (synchronized(lock) { closed }) return@execute
            try {
                backend.changeThreads(threads)
                synchronized(lock) { if (!closed) mutableThreads.value = ThreadConfiguration(threads) }
            } catch (e: Exception) {
                synchronized(lock) { if (!closed) mutableThreads.value = ThreadConfiguration(previous, error =
                    "Не удалось применить $threads поток(а): ${e.message ?: e.javaClass.simpleName}. " +
                    if (e.suppressed.isEmpty()) "Прежняя настройка сохранена." else "Восстановление сессии тоже не удалось; повторите запуск.") }
            } catch (e: OutOfMemoryError) {
                synchronized(lock) { if (!closed) mutableThreads.value = ThreadConfiguration(previous, error =
                    if (e.suppressed.isEmpty()) "Недостаточно памяти; прежняя настройка сохранена." else "Недостаточно памяти; восстановление сессии не удалось.") }
            }
        }
        true
    }

    fun updateThreshold(threshold: Float) = synchronized(lock) { configure(active, threshold) }

    /** A new binding cannot accept callbacks left queued by an older use case. */
    fun newSource(): Long = synchronized(lock) {
        configure(false, confidence)
        ++source
    }

    /** Synchronous ML-worker entry for owned frames; CameraX uses LiveFrameCapture/offerFrame instead. */
    fun analyze(frame: Frame, sourceId: Long? = null, stamp: FrameStamp? = null) {
        analyze(frame, sourceId, stamp, null, 0.0, null, forTracking = tracking != null)
    }

    private fun analyze(frame: Frame, sourceId: Long?, stamp: FrameStamp?, ticket: LiveFrameToken?,
                        preparationMs: Double, queuedNs: Long?, forTracking: Boolean = false): LiveInference? {
        try {
            val request = synchronized(lock) {
                if (closed || !active || busy || (ticket != null && !valid(ticket)) || (sourceId != null && sourceId != source) ||
                    mutableState.value.phase == LivePhase.ERROR) null
                else { busy = true; generation to confidence }
            } ?: return null
            val token = if (ticket != null) ticket.diagnosticToken else diagnostics?.currentToken()
            try {
                if (stamp?.ageAt(stamp.analyzerEntryNs)?.let { it > maxAnalyzerAgeMs } == true) {
                    if (token != null) diagnostics?.discardStale(token)
                    return null
                }
                val start = nanoTime()
                if (queuedNs != null && ((start - queuedNs) / 1_000_000.0 > maxAnalyzerAgeMs ||
                    (stamp != null && eventTime != null && stamp.ageAt(eventTime())?.let { it > maxAnalyzerAgeMs } == true))) {
                    synchronized(lock) { if (ticket != null) inputEvent(ticket, CameraInputEvent.STALE) }
                    if (token != null) diagnostics?.discardStale(token)
                    return null
                }
                if (token != null) diagnostics?.received(token)
                val result = backend.infer(frame, request.second)
                val end = nanoTime()
                val processingMs = preparationMs + (end - start) / 1_000_000.0
                return synchronized(lock) {
                    if (!closed && active && generation == request.first) {
                        val selected = selectTarget(result.detections, result.width, result.height)
                        completions.addLast(end)
                        while (completions.size > 30 ||
                            (completions.size > 2 && end - completions.first() > 3_000_000_000L)) {
                            completions.removeFirst()
                        }
                        val elapsed = end - completions.first()
                        val fps = if (completions.size > 1 && elapsed > 0)
                            (completions.size - 1) * 1_000_000_000.0 / elapsed else null
                        val previous = mutableState.value
                        val signal = if (!forTracking && stamp != null && eventTime != null) targetSignal(++frameId, source, stamp,
                            eventTime(), result.width, result.height, selected) else null
                        val next = previous.copy(
                            phase = LivePhase.RUNNING, result = result, pipelineMs = processingMs, fps = fps,
                            completedFrames = previous.completedFrames + 1,
                            revision = if (forTracking) previous.revision else ++revision, target = signal,
                        )
                        mutableSignals.value = signal
                        if (token != null && result.conversionMs != null && result.preprocessMs != null && result.postprocessMs != null) {
                            diagnostics?.completed(token, end, result.conversionMs, result.preprocessMs,
                                result.inferenceMs, result.postprocessMs, processingMs, signal,
                                detectionCount = result.detections.size.takeIf { forTracking })
                        }
                        // An unconfined signal subscriber may synchronously stop/reconfigure this controller.
                        if (!closed && active && generation == request.first) mutableState.value = next
                        result
                    } else null
                }
            } catch (e: Exception) {
                fail(request.first, e.message ?: e.javaClass.simpleName)
                return null
            } catch (_: OutOfMemoryError) {
                fail(request.first, "Недостаточно памяти. Остановите детекцию и повторите запуск.")
                return null
            } finally {
                synchronized(lock) { busy = false }
            }
        } finally {
            frame.close()
        }
    }

    private fun fail(id: Long, message: String, release: Boolean = true) = synchronized(lock) {
        if (closed || !active || generation != id) return@synchronized
        val failureGeneration = ++generation
        invalidatePending()
        resetTracking(failureGeneration, source)
        if (release) worker.execute { backend.close() }
        mutableSignals.value = null
        if (generation == failureGeneration && !closed && active) {
            mutableState.value = LiveState(LivePhase.ERROR, error = message, revision = ++revision)
        }
    }

    /** Clear boxes if the camera stops supplying frames without reporting an error. */
    fun expire(revision: Long) = synchronized(lock) {
        val current = mutableState.value
        val expiredGeneration = generation
        if (current.revision != revision) return@synchronized
        if (tracking != null) {
            mutableState.value = current.copy(tracking = null, trackingFps = null)
        } else if (current.result != null) {
            if (mutableSignals.value === current.target) mutableSignals.value = null
            if (generation == expiredGeneration && mutableState.value.revision == revision) {
                mutableState.value = current.copy(result = null, fps = null, pipelineMs = null, target = null)
            }
        }
    }

    override fun close() = synchronized(lock) {
        if (closed) return@synchronized
        closed = true
        active = false
        generation++
        source++
        invalidatePending()
        mutableSignals.value = null
        mutableState.value = LiveState(revision = ++revision)
        val closingGeneration = generation
        tracking?.let { live ->
            try { live.executor.execute { guardVision(closingGeneration) { live.session.close() } } }
            catch (_: RejectedExecutionException) { /* The process-wide executor is never shut down by a controller. */ }
        }
        worker.execute { backend.close() } // ordered after any in-flight native call; never wait on UI.
    }
}

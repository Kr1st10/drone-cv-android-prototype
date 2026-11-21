package ru.university.dronecv.camera

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.GrayFrame
import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.YoloRequest
import ru.university.dronecv.tracking.TrackingFailure
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.visibleDetections
import ru.university.dronecv.detection.highestConfidenceVisibleDetection
import ru.university.dronecv.diagnostics.DiagnosticFrames
import ru.university.dronecv.motion.MotionJournal
import ru.university.dronecv.detection.NormalizedBox

private fun quoted(value: Long?): String = value?.let { "\"$it\"" } ?: "null"
private fun jsonString(value: String?): String = value?.let {
    "\"" + it.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
} ?: "null"
private fun boxJson(box: NormalizedBox?): String = box?.let {
    "[${it.left},${it.top},${it.right},${it.bottom}]"
} ?: "null"

enum class LivePhase { STOPPED, STARTING, RUNNING, ERROR }

data class LiveInference(
    val detections: List<Detection>,
    val width: Int,
    val height: Int,
    val inferenceMs: Double,
    val conversionMs: Double? = null,
    val preprocessMs: Double? = null,
    val postprocessMs: Double? = null,
    val modelInputSize: Int? = null,
    val htpProfileNodeEvents: Int? = null,
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
    val htpProfileNodeEvents: Int? = null,
)

/** All backend methods run on the same worker, including release after pause or failure. */
interface LiveBackend<Frame> : AutoCloseable {
    fun infer(frame: Frame, confidence: Float): LiveInference
    fun warmUp(frame: Frame, confidence: Float): Boolean = false
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
    val motion: MotionJournal? = null,
    private val motionFrame: ((Frame, Long, FrameStamp) -> Long?)? = null,
    private val onFailure: ((String) -> Unit)? = null,
    private val packagedMetadataFields: String? = null,
    private val experimentalYolo: Boolean = false,
    private val nanoTime: () -> Long = System::nanoTime,
) : AutoCloseable {
    init {
        require(maxAnalyzerAgeMs.isFinite() && maxAnalyzerAgeMs >= 0)
        require(tracking == null || eventTime != null)
    }
    private val lock = Any()
    private var publicationDepth = 0
    private var drainingControls = false
    private val deferredControls = ArrayDeque<() -> Unit>()

    // Reentrant StateFlow controls run after state and timeline commit, under the same lock.
    private inline fun <T> publicationTransaction(block: () -> T): T = synchronized(lock) {
        publicationDepth++
        try { block() } finally {
            publicationDepth--
            if (publicationDepth == 0 && !drainingControls) {
                drainingControls = true
                try {
                    while (deferredControls.isNotEmpty()) deferredControls.removeFirst().invoke()
                } finally { drainingControls = false }
            }
        }
    }
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
    private var trackingEnabled = motion?.ui?.value?.mode != "yolo"

    fun setTrackingEnabled(enabled: Boolean): Boolean = publicationTransaction {
        if (active || motion?.token() != null) false else { trackingEnabled = enabled; true }
    }
    private var generation = 0L
    private var revision = 0L
    private var source = 0L
    // Own scalar snapshot only; never retain a frame lease for an inventory export.
    private var latestFrameGeometry: (() -> String)? = null
    private var nextSource = 0L
    private val completions = ArrayDeque<Long>()
    private val arrivals = ArrayDeque<Long>()
    private val mutableInput = MutableStateFlow(CameraInputStats())
    val input = mutableInput.asStateFlow()
    private data class Pending<F>(val frame: F, val token: LiveFrameToken, val stamp: FrameStamp,
                                 val preparationMs: Double, val queuedNs: Long)
    private var pending: Pending<Frame>? = null
    private var pumpScheduled = false
    private var pumpEpoch = 0L

    // Protected by lock. The stored observation keeps its original frame time across snapshots.
    private var timelinePayload: ((Long, String) -> String)? = null
    private var acceptedYoloFrame: Long? = null
    private var acceptedYoloStamp: FrameStamp? = null
    private var acceptedYoloNs: Long? = null

    /** Test observer at the serialization boundary, including payloads deferred to a writer. */
    internal var beforePublication: (() -> Unit)? = null

    internal var beforeDiagnosticSerialization: ((String) -> Unit)? = null

    private fun observedPayload(type: String, payload: () -> String): () -> String {
        val observer = beforeDiagnosticSerialization
        return { observer?.invoke(type); payload() }
    }

    private fun timeline(now: Long, reason: String, token: Long? = motion?.token(), diagnosticToken: Long? = diagnostics?.currentToken()) {
        val hasMotion = motion?.hasTimeline(token) == true
        val hasDiagnostic = diagnostics?.hasTimeline(diagnosticToken) == true
        if (!hasMotion && !hasDiagnostic) return
        val snapshot = timelinePayload
        val capturedGeneration = generation
        val capturedSource = source
        val payload = observedPayload("state") {
            snapshot?.invoke(now, reason) ?: "{\"publication_clock\":\"elapsed_realtime_ns\",\"publication_ns\":${quoted(now)},\"reason\":${jsonString(reason)},\"generation\":${quoted(capturedGeneration)},\"source_id\":${quoted(capturedSource)},\"frame_id\":null,\"box\":null}"
        }
        if (hasMotion) motion?.event(token, "state", payload)
        if (hasDiagnostic) diagnostics?.event(diagnosticToken, "state", payload, now)
    }
    private fun discarded(now: Long, token: LiveFrameToken?, stamp: FrameStamp?, reason: String) {
        val motionToken = token?.motionToken
        val diagnosticToken = token?.diagnosticToken
        val hasMotion = motion?.hasTimeline(motionToken) == true
        val hasDiagnostic = diagnostics?.hasTimeline(diagnosticToken) == true
        if (!hasMotion && !hasDiagnostic) return
        val capturedGeneration = token?.generation ?: generation
        val capturedSource = token?.source ?: source
        val payload = observedPayload("discard") {
            "{\"reason\":${jsonString(reason)},\"clock\":\"elapsed_realtime_ns\",\"time_ns\":${quoted(now)}," +
                "\"generation\":${quoted(capturedGeneration)},\"source_id\":${quoted(capturedSource)}," +
                "\"capture_ns\":${quoted(stamp?.captureNs)},\"timestamp_source\":${jsonString(stamp?.timebase?.name?.lowercase())}," +
                "\"analyzer_entry_ns\":${quoted(stamp?.analyzerEntryNs)}}"
        }
        if (hasMotion) motion?.event(motionToken, "discard", payload)
        if (hasDiagnostic) diagnostics?.event(diagnosticToken, "discard", payload, now)
    }

    private fun updateTimeline(now: Long, reason: String, token: Long?, frame: Long?, motionFrame: Long?,
                               stamp: FrameStamp?, kind: String?, box: NormalizedBox?,
                               yoloFrame: Long? = null, yoloStamp: FrameStamp? = null,
                               yoloAccepted: Long? = null, detectorFrame: Long? = null, diagnosticToken: Long? = diagnostics?.currentToken(),
                               readyNs: Long? = null, signalNs: Long? = null) {
        val capturedGeneration = generation
        val capturedSource = source
        timelinePayload = { publication, why ->
            "{\"publication_clock\":\"elapsed_realtime_ns\",\"publication_ns\":${quoted(publication)},\"reason\":${jsonString(why)}," +
                "\"generation\":${quoted(capturedGeneration)},\"source_id\":${quoted(capturedSource)}," +
                "\"timing_semantics\":\"stateflow_assignment_v1\",\"result_ready_ns\":${quoted(readyNs)},\"signal_publication_ns\":${quoted(signalNs)},\"state_publication_ns\":${quoted(now)},\"observation_publication_ns\":${quoted(now)}," +
                "\"frame_id\":${quoted(frame)},\"motion_frame_id\":${quoted(motionFrame)}," +
                "\"capture_ns\":${quoted(stamp?.captureNs)},\"timestamp_source\":${jsonString(stamp?.timebase?.name?.lowercase())}," +
                "\"analyzer_entry_ns\":${quoted(stamp?.analyzerEntryNs)},\"timing_issue\":${jsonString(stamp?.timingIssue(publication))}," +
                "\"result_source\":${jsonString(kind)},\"box\":${boxJson(box)}," +
                "\"last_yolo_frame_id\":${quoted(yoloFrame)},\"last_yolo_capture_ns\":${quoted(yoloStamp?.captureNs)}," +
                "\"last_yolo_timestamp_source\":${jsonString(yoloStamp?.timebase?.name?.lowercase())},\"last_yolo_analyzer_entry_ns\":${quoted(yoloStamp?.analyzerEntryNs)},\"last_yolo_accepted_ns\":${quoted(yoloAccepted)},\"detector_frame_id\":${quoted(detectorFrame)}}"
        }
        timeline(now, reason, token, diagnosticToken)
    }
    private fun clearTimeline(now: Long, reason: String, token: Long? = motion?.token()) {
        updateTimeline(now, reason, token, null, null, null, null, null)
    }
    private fun executionMetadata(): String {
        val state = mutableState.value
        val nodes = state.htpProfileNodeEvents
        val threads = mutableThreads.value.threads
        if (nodes != null) {
            return "\"backend\":\"ONNX Runtime QNN HTP, intra-op $threads, inter-op 1\"," +
                "\"execution_provider\":\"QNNExecutionProvider\",\"htp_confirmed\":true," +
                "\"cpu_ep_fallback_disabled\":true,\"profile_node_events\":{\"QNNExecutionProvider\":$nodes}"
        }
        return if (experimentalYolo && !trackingEnabled && state.completedFrames == 0L) {
            "\"backend\":null,\"execution_provider\":null"
        } else {
            "\"backend\":\"ONNX Runtime CPU, intra-op $threads, inter-op 1\",\"execution_provider\":\"CPU\""
        }
    }

    private fun metadata(extra: String): String = "{${packagedMetadataFields?.let { "$it," } ?: ""}\"mode\":\"${if (trackingEnabled) "yolo_lk" else "yolo"}\",\"confidence\":$confidence,\"nms_iou\":${ru.university.dronecv.detection.yolo.PostprocessConfig().iouThreshold},\"nms_max_detections\":${ru.university.dronecv.detection.yolo.PostprocessConfig().maxDetections},\"model_input_size\":${mutableState.value.result?.modelInputSize},\"model_input_size_source\":\"latest retained inference result; null means unavailable (not measured or result cleared)\",${executionMetadata()},\"inter_op_threads\":1,\"execution_mode\":\"SEQUENTIAL\",\"intra_op_threads\":${mutableThreads.value.threads},\"yolo_period_ns\":${quoted(tracking?.session?.yoloPeriodNs)},\"confirmation_ttl_ns\":${quoted(tracking?.session?.confirmationTtlNs)},\"retry_ns\":${quoted(tracking?.session?.retryNs)},\"coordinate_timeout_ns\":${quoted(MAX_TRACKING_SILENCE_NS)},\"lk\":{\"max_points\":${ru.university.dronecv.tracking.LkParameters.MAX_POINTS},\"min_points\":${ru.university.dronecv.tracking.LkParameters.MIN_POINTS},\"corner_quality\":${ru.university.dronecv.tracking.LkParameters.CORNER_QUALITY},\"corner_distance\":${ru.university.dronecv.tracking.LkParameters.CORNER_DISTANCE},\"window\":${ru.university.dronecv.tracking.LkParameters.WINDOW},\"pyramid_levels\":${ru.university.dronecv.tracking.LkParameters.PYRAMID_LEVELS},\"iterations\":${ru.university.dronecv.tracking.LkParameters.ITERATIONS},\"epsilon\":${ru.university.dronecv.tracking.LkParameters.EPSILON},\"forward_back_error\":${ru.university.dronecv.tracking.LkParameters.FORWARD_BACK_ERROR},\"inlier_distance\":${ru.university.dronecv.tracking.LkParameters.INLIER_DISTANCE},\"retained_fraction\":${ru.university.dronecv.tracking.LkParameters.RETAINED_FRACTION},\"min_correlation\":${ru.university.dronecv.tracking.LkParameters.MIN_CORRELATION}},\"camera_context\":$extra}"
    /** Snapshot current controls at the caller boundary, never on a frame callback. */
    fun exportMetadata(extra: String = "null"): String = publicationTransaction {
        metadata(extra).dropLast(1) + ",\"frame_geometry\":${latestFrameGeometry?.invoke() ?: "null"}," +
            "\"frame_geometry_source\":\"latest received frame of current generation/source; null means not measured; not a recording-wide value\"}"
    }
    fun startDiagnostics(extra: String = "null", start: () -> Unit): Unit = publicationTransaction {
        if (publicationDepth > 1) {
            deferredControls.addLast { startDiagnostics(extra, start) }
            return@publicationTransaction
        }
        if (closed || !active) return@publicationTransaction
        start()
        eventTime?.invoke()?.let {
            diagnostics?.event(diagnostics?.currentToken(), "metadata", metadata(extra), it)
            timeline(it, "initial_snapshot", null)
        }
    }
    fun startRecording(extra: String = "null"): Unit = publicationTransaction {
        if (publicationDepth > 1) {
            deferredControls.addLast { startRecording(extra) }
            return@publicationTransaction
        }
        if (closed || !active) return@publicationTransaction
        motion?.start()
        eventTime?.invoke()?.let {
            motion?.event(motion?.token(), "metadata", metadata(extra))
            timeline(it, "initial_snapshot", diagnosticToken = null)
        }
    }

    private fun valid(token: LiveFrameToken): Boolean = !closed && active &&
        generation == token.generation && source == token.source && mutableState.value.phase != LivePhase.ERROR

    private fun inputEvent(token: LiveFrameToken, event: CameraInputEvent, copyMs: Double = 0.0) {
        token.diagnosticToken?.let { diagnostics?.input(it, event, copyMs) }
        if (valid(token)) mutableInput.value = mutableInput.value.record(event, copyMs)
    }

    /** Called before copying, so a threshold/Stop change during preparation cannot retag an old frame. */
    fun beginFrame(sourceId: Long, stamp: FrameStamp): LiveFrameToken? = publicationTransaction {
        val token = LiveFrameToken(generation, sourceId, diagnostics?.currentToken(), motion?.token())
        if (!valid(token)) return@publicationTransaction null
        inputEvent(token, CameraInputEvent.RECEIVED)
        if (!valid(token)) return@publicationTransaction null
        arrivals.addLast(stamp.analyzerEntryNs)
        while (arrivals.size > 30) arrivals.removeFirst()
        val span = stamp.analyzerEntryNs - arrivals.first()
        mutableInput.value = mutableInput.value.copy(fps = if (arrivals.size > 1 && span > 0)
            (arrivals.size - 1) * 1_000_000_000.0 / span else null)
        if (!valid(token)) return@publicationTransaction null
        if (stamp.ageAt(stamp.analyzerEntryNs)?.let { it > maxAnalyzerAgeMs } == true) {
            inputEvent(token, CameraInputEvent.STALE)
            token.diagnosticToken?.let { diagnostics?.discardStale(it) }
            eventTime?.invoke()?.let { discarded(it, token, stamp, "stale_capture") }
            null
        } else token
    }

    fun noFrameBuffer(token: LiveFrameToken) = publicationTransaction { inputEvent(token, CameraInputEvent.NO_BUFFER) }

    fun captureFailed(token: LiveFrameToken, message: String) = publicationTransaction {
        inputEvent(token, CameraInputEvent.ERROR)
        fail(token.generation, message)
    }

    /** Takes ownership even on rejection. One current pump and one replaceable pending snapshot exist. */
    fun offerFrame(frame: Frame, token: LiveFrameToken, stamp: FrameStamp, preparationMs: Double) {
        if (frame is CameraFrameSnapshot) {
            // Capture scalar metadata only: the writer must never retain the leased image.
            val sourceId = token.source
            val frameGeneration = token.generation
            val sourceWidth = frame.sourceWidth
            val sourceHeight = frame.sourceHeight
            val cropLeft = frame.cropLeft
            val cropTop = frame.cropTop
            val cropRight = frame.cropRight
            val cropBottom = frame.cropBottom
            val rotation = frame.rotationDegrees
            eventTime?.invoke()?.let { now ->
                val payload = observedPayload("frame_geometry") {
                    "{\"source_id\":${quoted(sourceId)},\"generation\":${quoted(frameGeneration)},\"analyzer_entry_ns\":${quoted(stamp.analyzerEntryNs)},\"source_width\":$sourceWidth,\"source_height\":$sourceHeight,\"crop\":[$cropLeft,$cropTop,$cropRight,$cropBottom],\"rotation_degrees\":$rotation}"
                }
                synchronized(lock) { if (valid(token)) latestFrameGeometry = payload }
                diagnostics?.event(token.diagnosticToken, "frame_geometry", payload, now)
                motion?.event(token.motionToken, "frame_geometry", payload)
            }
        }
        try { token.motionToken?.let { token.motionFrame = motionFrame?.invoke(frame, it, stamp) } }
        catch (e: Exception) { frame.close(); captureFailed(token, e.message ?: e.javaClass.simpleName); return }
        catch (_: OutOfMemoryError) { frame.close(); captureFailed(token, "Недостаточно памяти для записи стенда."); return }
        tracking?.takeIf { trackingEnabled }?.let { offerTrackingFrame(it, frame, token, stamp, preparationMs); return }
        var retained = false
        try {
            if (!preparationMs.isFinite() || preparationMs < 0) {
                captureFailed(token, "Некорректное время копирования кадра.")
                return
            }
            val schedule = publicationTransaction {
                inputEvent(token, CameraInputEvent.COPIED, preparationMs)
                if (!valid(token)) {
                    inputEvent(token, CameraInputEvent.INVALIDATED)
                    return@publicationTransaction null
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
            val accepted = publicationTransaction {
                inputEvent(token, CameraInputEvent.COPIED, preparationMs)
                valid(token).also { if (!it) inputEvent(token, CameraInputEvent.INVALIDATED) }
            }
            if (!accepted) return
            live.reset(token.generation, token.source)
            live.session.events = token.diagnosticToken?.let { diagnosticToken ->
                { event -> diagnostics?.trackingEvent(diagnosticToken, event); Unit }
            }
            val start = nanoTime()
            val gray = live.grayscale(frame, FrameKey(token.generation, token.source, ++live.sequence), stamp)
            val observation = live.session.observe(gray) ?: return
            live.latestToken = token
            publishTracking(live, token, observation, gray, TrackingSampleKind.FRAME, start)
            if (!publicationTransaction { valid(token) }) return
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
            var failure = TrackingFailure.UNKNOWN
            val result = analyze(frame, token.source, stamp, token, preparationMs, queued, forTracking = true,
                onDiscard = { failure = it })
            onVision(live, token) { handleYolo(live, token, request, result, failure) }
        } catch (e: Exception) {
            trackingFailed(live, token, request, e)
        } catch (e: OutOfMemoryError) {
            trackingFailed(live, token, request, e)
        } catch (e: LinkageError) {
            trackingFailed(live, token, request, e)
        }
    }

    private fun handleYolo(live: LiveTracking<Frame>, token: LiveFrameToken, request: YoloRequest,
                           result: LiveInference?, failure: TrackingFailure) {
        var replayScheduled = false
        try {
            if (!publicationTransaction { valid(token) }) return
            if (result == null) {
                live.session.reject(request, failure)
                return
            }
            check(result.width == request.anchor.cropWidth && result.height == request.anchor.cropHeight) {
                "Размер кадра YOLO не совпадает с кадром трекера."
            }
            val plan = live.session.prepareCorrection(request, result.detections) ?: return
            worker.execute {
                try {
                    val start = nanoTime()
                    val correction = if (publicationTransaction { valid(token) }) plan.replay(nanoTime) else null
                    val replayMs = (nanoTime() - start) / 1e6
                    var transferred = false
                    try {
                        transferred = onVision(live, token) {
                            try {
                                if (!publicationTransaction { valid(token) }) return@onVision
                                if (correction == null) {
                                    live.session.rejectCorrection(request)
                                    return@onVision
                                }
                                val commitStart = nanoTime()
                                val observation = live.session.commit(correction, checkNotNull(eventTime)()) ?: return@onVision
                                motion?.detection(token.motionToken, token.motionFrame, plan.detection, checkNotNull(eventTime)())
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
            live.session.reject(request, TrackingFailure.PROCESSING_EXCEPTION)
            fail(token.generation, "Worker обработки кадров недоступен.", release = false)
        } catch (e: Throwable) {
            live.session.reject(request, TrackingFailure.PROCESSING_EXCEPTION)
            throw e
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
            live.session.reject(request, TrackingFailure.PROCESSING_EXCEPTION)
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
        publicationTransaction {
            if (!valid(token)) return@publicationTransaction
            val now = checkNotNull(eventTime)()
            val silenceDeadline = now + MAX_TRACKING_SILENCE_NS
            val displayUntil = if (observation.estimate == null) silenceDeadline else
                minOf(silenceDeadline, live.session.confirmationDeadlineNs(observation) ?: now)
            if (observation.estimate != null &&
                (displayUntil <= now ||
                    now - observation.stamp.analyzerEntryNs > maxAnalyzerAgeMs * 1e6 ||
                    observation.stamp.ageAt(now)?.let { it > maxAnalyzerAgeMs } == true)) {
                val hadBox = mutableState.value.tracking?.box != null
                val cleared = mutableState.value.copy(tracking = null, trackingFps = null, revision = ++revision)
                val clearedNs = checkNotNull(eventTime)()
                mutableState.value = cleared
                if (!valid(token)) return@publicationTransaction
                if (hadBox) {
                    motion?.publication(token.motionToken, null, null, "clear", clearedNs)
                    val deadline = live.session.confirmationDeadlineNs(observation)
                    clearTimeline(clearedNs, if (deadline != null && now >= deadline) "classification_expired" else "stale_result")
                } else {
                    discarded(now, token, observation.stamp, "stale_result")
                }
                return@publicationTransaction
            }
            val end = nanoTime()
            val readyNs = checkNotNull(eventTime)()
            val preparedSignal = TrackingSignal(observation, kind, geometry.cropWidth, geometry.cropHeight, now,
                extraMs + (end - start) / 1e6, geometry.width, geometry.height, displayUntil)
            val fps = live.fps(preparedSignal)
            val b = preparedSignal.box?.let { NormalizedBox((it.left / preparedSignal.width).toFloat(), (it.top / preparedSignal.height).toFloat(), (it.right / preparedSignal.width).toFloat(), (it.bottom / preparedSignal.height).toFloat()) }
            beforePublication?.invoke()
            val publicationNs = checkNotNull(eventTime)()
            if (observation.estimate != null && (publicationNs >= displayUntil ||
                    publicationNs - observation.stamp.analyzerEntryNs > maxAnalyzerAgeMs * 1e6 ||
                    observation.stamp.ageAt(publicationNs)?.let { it > maxAnalyzerAgeMs } == true)) {
                mutableState.value = mutableState.value.copy(tracking = null, trackingFps = null, revision = ++revision)
                if (valid(token)) {
                    motion?.publication(token.motionToken, null, null, "clear", publicationNs)
                    clearTimeline(publicationNs, "stale_result")
                }
                return@publicationTransaction
            }
            val signal = preparedSignal.copy(dispatchNs = publicationNs, resultReadyNs = readyNs)
            mutableState.value = mutableState.value.copy(tracking = signal, trackingFps = fps, revision = ++revision)
            if (!valid(token)) return@publicationTransaction
            motion?.publication(token.motionToken, token.motionFrame, b, if (b == null) "clear" else "lk", publicationNs)
            val obs = signal.observation
            updateTimeline(publicationNs, obs.reason ?: if (kind == TrackingSampleKind.CORRECTION) "correction" else if (b == null) "searching" else "update",
                motion?.token(), obs.key.sequence, token.motionFrame.takeIf { token.motionToken == motion?.token() }, obs.stamp,
                if (kind == TrackingSampleKind.CORRECTION) "correction" else "lk", b,
                obs.lastYoloKey?.sequence, obs.lastYoloStamp, obs.lastYoloAcceptedNs,
                if (kind == TrackingSampleKind.CORRECTION) obs.lastYoloKey?.sequence else null, diagnostics?.currentToken(), readyNs = readyNs)
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
        latestFrameGeometry = null
        pumpEpoch++
        pumpScheduled = false
        clearPending()
    }

    private fun schedulePump(epoch: Long) {
        try { worker.execute { runPending(epoch) } }
        catch (_: java.util.concurrent.RejectedExecutionException) {
            publicationTransaction {
                if (epoch != pumpEpoch) return@publicationTransaction
                val id = pending?.token?.generation
                pumpScheduled = false
                clearPending()
                // A rejected worker cannot perform release; never move native close to the input thread.
                if (id != null) fail(id, "Worker обработки кадров недоступен.", release = false)
            }
        }
    }

    private fun runPending(epoch: Long) {
        val next = publicationTransaction {
            if (epoch != pumpEpoch) return
            pending.also { pending = null }
        }
        try {
            if (next != null) analyze(next.frame, next.token.source, next.stamp, next.token,
                next.preparationMs, next.queuedNs)
        } finally {
            val again = publicationTransaction {
                if (epoch != pumpEpoch) false
                else if (pending == null) { pumpScheduled = false; false } else true
            }
            if (again) schedulePump(epoch) // yield to close/configuration/photo tasks already queued.
        }
    }

    fun configure(enabled: Boolean, threshold: Float, stopReason: String = "detection_stop"): Unit = publicationTransaction {
        require(threshold in 0.01f..1f)
        if (publicationDepth > 1) deferredControls.addLast { publicationTransaction { applyConfiguration(enabled, threshold, stopReason) } }
        else applyConfiguration(enabled, threshold, stopReason)
    }

    /** Apply at the command's FIFO position; callers hold the publication lock. */
    private fun applyConfiguration(enabled: Boolean, threshold: Float, stopReason: String = "detection_stop") {
        if (closed || (enabled && mutableThreads.value.switching) || (active == enabled && confidence == threshold)) return
        val clearReason = if (active && (enabled != active || threshold != confidence))
            if (!enabled) stopReason else "configuration_changed" else null
        val wasActive = active
        active = enabled
        confidence = threshold
        val configuredGeneration = ++generation
        timelinePayload = null
        acceptedYoloFrame = null; acceptedYoloStamp = null; acceptedYoloNs = null
        completions.clear()
        arrivals.clear()
        invalidatePending()
        resetTracking(configuredGeneration, source)
        if (wasActive && !active) worker.execute { backend.close() }
        mutableInput.value = CameraInputStats()
        mutableSignals.value = null
        if (generation == configuredGeneration && !closed) {
            val next = LiveState(phase = if (active) LivePhase.STARTING else LivePhase.STOPPED, revision = ++revision)
            val publicationNs = eventTime?.invoke()
            mutableState.value = next
            if (generation == configuredGeneration && clearReason != null) {
                publicationNs?.let { clearTimeline(it, clearReason) }
                motion?.stop(if (!enabled) stopReason else "Detection configuration changed")
            }
        }
    }

    /** Apply only after stopping detection and recording; all session work is ordered on the ML worker. */
    fun requestThreads(threads: Int): Boolean = publicationTransaction {
        require(threads in setOf(1, 2, 4))
        if (closed) return@publicationTransaction false
        if (active || busy || diagnostics?.currentToken() != null || mutableThreads.value.switching) {
            if (!mutableThreads.value.switching) mutableThreads.value = mutableThreads.value.copy(
                error = "Остановите детекцию и дождитесь завершения обработки кадра.")
            return@publicationTransaction false
        }
        if (threads == mutableThreads.value.threads) return@publicationTransaction true
        val previous = mutableThreads.value.threads
        mutableThreads.value = ThreadConfiguration(previous, switching = true)
        worker.execute {
            if (publicationTransaction { closed }) return@execute
            try {
                backend.changeThreads(threads)
                publicationTransaction { if (!closed) mutableThreads.value = ThreadConfiguration(threads) }
            } catch (e: Exception) {
                publicationTransaction { if (!closed) mutableThreads.value = ThreadConfiguration(previous, error =
                    "Не удалось применить $threads поток(а): ${e.message ?: e.javaClass.simpleName}. " +
                    if (e.suppressed.isEmpty()) "Прежняя настройка сохранена." else "Восстановление сессии тоже не удалось; повторите запуск.") }
            } catch (e: OutOfMemoryError) {
                publicationTransaction { if (!closed) mutableThreads.value = ThreadConfiguration(previous, error =
                    if (e.suppressed.isEmpty()) "Недостаточно памяти; прежняя настройка сохранена." else "Недостаточно памяти; восстановление сессии не удалось.") }
            }
        }
        true
    }

    fun updateThreshold(threshold: Float): Unit = publicationTransaction {
        require(threshold in 0.01f..1f)
        if (publicationDepth > 1) deferredControls.addLast { publicationTransaction { applyConfiguration(active, threshold) } }
        else applyConfiguration(active, threshold)
    }

    /** A new binding cannot accept callbacks left queued by an older use case. */
    fun newSource(): Long = publicationTransaction {
        val reserved = maxOf(nextSource, source) + 1
        nextSource = reserved
        val change = {
            configure(false, confidence)
            source = reserved
        }
        deferredControls.addLast(change)
        reserved
    }

    /** Synchronous ML-worker entry for owned frames; CameraX uses LiveFrameCapture/offerFrame instead. */
    fun analyze(frame: Frame, sourceId: Long? = null, stamp: FrameStamp? = null) {
        analyze(frame, sourceId, stamp, null, 0.0, null, forTracking = tracking != null)
    }

    private fun analyze(frame: Frame, sourceId: Long?, stamp: FrameStamp?, ticket: LiveFrameToken?,
                        preparationMs: Double, queuedNs: Long?, forTracking: Boolean = false,
                        onDiscard: ((TrackingFailure) -> Unit)? = null): LiveInference? {
        try {
            val request = publicationTransaction {
                if (closed || !active || busy || (ticket != null && !valid(ticket)) || (sourceId != null && sourceId != source) ||
                    mutableState.value.phase == LivePhase.ERROR) null
                else { busy = true; generation to confidence }
            } ?: return null
            val token = if (ticket != null) ticket.diagnosticToken else diagnostics?.currentToken()
            try {
                if (stamp?.ageAt(stamp.analyzerEntryNs)?.let { it > maxAnalyzerAgeMs } == true) {
                    if (token != null) diagnostics?.discardStale(token)
                    publicationTransaction { eventTime?.invoke()?.let { discarded(it, ticket, stamp, "stale_capture") } }
                    onDiscard?.invoke(TrackingFailure.STALE_CAPTURE)
                    return null
                }
                val start = nanoTime()
                if (queuedNs != null && ((start - queuedNs) / 1_000_000.0 > maxAnalyzerAgeMs ||
                    (stamp != null && eventTime != null && stamp.ageAt(eventTime())?.let { it > maxAnalyzerAgeMs } == true))) {
                    publicationTransaction { if (ticket != null) inputEvent(ticket, CameraInputEvent.STALE) }
                    if (token != null) diagnostics?.discardStale(token)
                    publicationTransaction { eventTime?.invoke()?.let { discarded(it, ticket, stamp, "stale_queue") } }
                    onDiscard?.invoke(TrackingFailure.STALE_QUEUE)
                    return null
                }
                if (!forTracking && backend.warmUp(frame, request.second)) return null
                if (token != null) diagnostics?.received(token)
                val rawResult = backend.infer(frame, request.second)
                val result = rawResult.copy(detections = rawResult.detections.visibleDetections())
                val end = nanoTime()
                val processingMs = preparationMs + (end - start) / 1_000_000.0
                return publicationTransaction {
                    if (!closed && active && generation == request.first) {
                        val selected = selectTarget(result.detections, result.width, result.height)
                        val selectedDetection = result.detections.highestConfidenceVisibleDetection()
                        val readyNs = eventTime?.invoke()
                        completions.addLast(end)
                        while (completions.size > 30 ||
                            (completions.size > 2 && end - completions.first() > 3_000_000_000L)) {
                            completions.removeFirst()
                        }
                        val elapsed = end - completions.first()
                        val fps = if (completions.size > 1 && elapsed > 0)
                            (completions.size - 1) * 1_000_000_000.0 / elapsed else null
                        val previous = mutableState.value
                        val preparedSignal = if (!forTracking && stamp != null && eventTime != null) targetSignal(++frameId, source, stamp,
                            eventTime(), result.width, result.height, selected) else null
                        val next = previous.copy(
                            phase = LivePhase.RUNNING, result = result, pipelineMs = processingMs, fps = fps,
                            completedFrames = previous.completedFrames + 1,
                            htpProfileNodeEvents = result.htpProfileNodeEvents,
                            revision = if (forTracking) previous.revision else ++revision, target = preparedSignal,
                        )
                        beforePublication?.invoke()
                        val signal = preparedSignal?.copy(dispatchNs = checkNotNull(eventTime)(), resultReadyNs = readyNs)
                        mutableSignals.value = signal
                        if (token != null && result.conversionMs != null && result.preprocessMs != null && result.postprocessMs != null) {
                            diagnostics?.completed(token, end, result.conversionMs, result.preprocessMs,
                                result.inferenceMs, result.postprocessMs, processingMs, signal,
                                detectionCount = result.detections.size)
                        }
                        // An unconfined signal subscriber may synchronously stop/reconfigure this controller.
                        if (!closed && active && generation == request.first) {
                            if (!forTracking && ticket != null && eventTime != null && valid(ticket)) {
                                val stateReady = next.copy(target = signal)
                                val now = eventTime()
                                mutableState.value = stateReady
                                if (!valid(ticket)) return@publicationTransaction result
                                if (selectedDetection != null) motion?.detection(ticket.motionToken, ticket.motionFrame, selectedDetection, now)
                                motion?.publication(ticket.motionToken, ticket.motionFrame, selectedDetection?.box, if (selectedDetection == null) "clear" else "yolo", now)
                                if (selectedDetection != null) {
                                    acceptedYoloFrame = signal?.frameId
                                    acceptedYoloStamp = stamp
                                    acceptedYoloNs = now
                                }
                                updateTimeline(now, if (selectedDetection == null) "no_detection" else "update", motion?.token(),
                                    signal?.frameId, ticket.motionFrame.takeIf { ticket.motionToken == motion?.token() }, stamp, "yolo", selectedDetection?.box,
                                    acceptedYoloFrame, acceptedYoloStamp, acceptedYoloNs, signal?.frameId, diagnostics?.currentToken(), readyNs, signal?.dispatchNs)
                            }
                            if (forTracking || ticket == null || eventTime == null) mutableState.value = next.copy(target = signal)
                        }
                        result
                    } else null
                }
            } catch (e: Exception) {
                if (forTracking && ticket != null) throw e
                fail(request.first, e.message ?: e.javaClass.simpleName)
                return null
            } catch (e: OutOfMemoryError) {
                if (forTracking && ticket != null) throw e
                fail(request.first, "Недостаточно памяти. Остановите детекцию и повторите запуск.")
                return null
            } finally {
                publicationTransaction { busy = false }
            }
        } finally {
            frame.close()
        }
    }

    private fun fail(id: Long, message: String, release: Boolean = true) = publicationTransaction {
        if (closed || !active || generation != id) return@publicationTransaction
        val failureGeneration = ++generation
        invalidatePending()
        resetTracking(failureGeneration, source)
        if (release) worker.execute { backend.close() }
        mutableSignals.value = null
        if (generation == failureGeneration && !closed && active) {
            val next = LiveState(LivePhase.ERROR, error = message, revision = ++revision)
            val publicationNs = eventTime?.invoke()
            mutableState.value = next
            if (generation != failureGeneration) return@publicationTransaction
            publicationNs?.let { clearTimeline(it, "detector_error") }
            motion?.stop("Detector error: $message")
            onFailure?.invoke(message)
        }
    }

    /** Clear boxes if the camera stops supplying frames without reporting an error. */
    fun expire(revision: Long): Unit = publicationTransaction {
        if (publicationDepth > 1) {
            deferredControls.addLast { expire(revision) }
            return@publicationTransaction
        }
        val current = mutableState.value
        val expiredGeneration = generation
        if (current.revision != revision) return@publicationTransaction
        if (tracking != null && trackingEnabled) {
            val next = current.copy(tracking = null, trackingFps = null)
            val now = eventTime?.invoke()
            mutableState.value = next
            if (generation != expiredGeneration) return@publicationTransaction
            if (current.tracking?.box != null && now != null) {
                motion?.publication(motion.token(), null, null, "clear", now)
                val confirmationDeadline = tracking.session.confirmationDeadlineNs(current.tracking.observation)
                clearTimeline(now, if (confirmationDeadline != null && now >= confirmationDeadline) "classification_expired" else "no_update_timeout")
            }
        } else if (current.result != null) {
            if (mutableSignals.value === current.target) mutableSignals.value = null
            if (generation == expiredGeneration && mutableState.value.revision == revision) {
                val next = current.copy(result = null, fps = null, pipelineMs = null, target = null)
                val publicationNs = eventTime?.invoke()
                mutableState.value = next
                if (generation != expiredGeneration) return@publicationTransaction
                publicationNs?.let { now ->
                    motion?.publication(motion.token(), null, null, "clear", now)
                    clearTimeline(now, "no_update_timeout")
                }
            }
        }
    }

    override fun close(): Unit = publicationTransaction {
        if (publicationDepth > 1) {
            deferredControls.addLast { close() }
            return@publicationTransaction
        }
        if (closed) return@publicationTransaction
        closed = true
        active = false
        generation++
        source++
        invalidatePending()
        mutableSignals.value = null
        val next = LiveState(revision = ++revision)
        val publicationNs = eventTime?.invoke()
        mutableState.value = next
        publicationNs?.let { clearTimeline(it, "screen_closed") }
        motion?.stop("Camera screen closed")
        val closingGeneration = generation
        tracking?.let { live ->
            try { live.executor.execute { guardVision(closingGeneration) { live.session.close() } } }
            catch (_: RejectedExecutionException) { /* The process-wide executor is never shut down by a controller. */ }
        }
        worker.execute { backend.close() } // ordered after any in-flight native call; never wait on UI.
    }
}

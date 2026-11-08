package ru.university.dronecv.diagnostics

import kotlin.math.ceil
import ru.university.dronecv.camera.CameraInputEvent
import ru.university.dronecv.camera.CameraInputStats
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.tracking.VisualPhase

/** Statistics over measured frame durations in milliseconds; p95 is nearest rank. */
data class DurationSummary(
    val count: Int,
    val mean: Double,
    val median: Double,
    val p95: Double?,
    val min: Double,
    val max: Double,
)

fun durationSummary(values: List<Double>): DurationSummary? {
    if (values.isEmpty()) return null
    require(values.all { it.isFinite() && it >= 0.0 })
    val sorted = values.sorted()
    val n = sorted.size
    val median = if (n % 2 == 1) sorted[n / 2] else (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    return DurationSummary(n, sorted.average(), median, if (n >= 20) sorted[ceil(.95 * n).toInt() - 1] else null, sorted.first(), sorted.last())
}

/** Backend durations exclude capture/display; the optional target signal has separate exposure timing. */
data class FrameMeasurement(
    val offsetNanos: Long,
    val conversionMs: Double,
    val preprocessMs: Double,
    val inferenceMs: Double,
    val postprocessMs: Double,
    val pipelineMs: Double,
    val targetSignal: TargetSignal? = null,
    val detectionCount: Int? = null,
)

data class TrackingMeasurement(val offsetNanos: Long, val signal: TrackingSignal)

data class TrackingSnapshot(
    val observedFrames: Long,
    val trackUpdates: Long,
    val corrections: Long,
    val lossEvents: Long,
    val unstoredSamples: Long,
    val samples: List<TrackingMeasurement>,
)

/** Bounded, synchronized storage. Old session tokens can never publish into a new session. */
class DiagnosticFrames(private val capacity: Int = 100_000, private val trackingCapacity: Int = 10_000) {
    init { require(capacity > 0 && trackingCapacity > 0) }
    private val lock = Any()
    private var generation = 0L
    private var recording = false
    private var startNanos = 0L
    private var received = 0L
    private var completed = 0L
    private var truncated = 0L
    private var staleDiscarded = 0L
    private var input = CameraInputStats()
    private val frames = ArrayList<FrameMeasurement>()
    private val trackingSamples = ArrayList<TrackingMeasurement>()
    private var observedFrames = 0L
    private var trackUpdates = 0L
    private var corrections = 0L
    private var lossEvents = 0L
    private var unstoredSamples = 0L
    private var lastTrackingSignal: TrackingSignal? = null

    fun start(nowNanos: Long): Long = synchronized(lock) {
        check(!recording)
        generation++
        startNanos = nowNanos
        received = 0
        completed = 0
        truncated = 0
        staleDiscarded = 0
        input = CameraInputStats()
        frames.clear()
        trackingSamples.clear()
        observedFrames = 0
        trackUpdates = 0
        corrections = 0
        lossEvents = 0
        unstoredSamples = 0
        lastTrackingSignal = null
        recording = true
        generation
    }
    fun currentToken(): Long? = synchronized(lock) { generation.takeIf { recording } }
    fun received(token: Long) = synchronized(lock) { if (recording && token == generation) received++ }
    fun input(token: Long, event: CameraInputEvent, copyMs: Double = 0.0) = synchronized(lock) {
        if (recording && token == generation) input = input.record(event, copyMs)
    }
    fun discardStale(token: Long) = synchronized(lock) { if (recording && token == generation) staleDiscarded++ }
    fun completed(token: Long, endNanos: Long, conversionMs: Double, preprocessMs: Double,
                  inferenceMs: Double, postprocessMs: Double, pipelineMs: Double, targetSignal: TargetSignal? = null,
                  detectionCount: Int? = null) = synchronized(lock) {
        if (!recording || token != generation) return@synchronized
        require(endNanos >= startNanos && conversionMs.isFinite() && conversionMs >= 0 &&
            preprocessMs.isFinite() && preprocessMs >= 0 && inferenceMs.isFinite() && inferenceMs >= 0 &&
            postprocessMs.isFinite() && postprocessMs >= 0 && pipelineMs.isFinite() && pipelineMs >= 0)
        completed++
        if (frames.size < capacity) frames.add(FrameMeasurement(endNanos - startNanos, conversionMs,
            preprocessMs, inferenceMs, postprocessMs, pipelineMs, targetSignal, detectionCount)) else truncated++
    }
    fun tracking(token: Long, endNanos: Long, signal: TrackingSignal) = synchronized(lock) {
        if (!recording || token != generation) return@synchronized
        require(endNanos >= startNanos)
        if (signal.kind == TrackingSampleKind.FRAME) {
            observedFrames++
            if (signal.observation.estimate != null) trackUpdates++
            val previous = lastTrackingSignal?.observation
            if (signal.observation.phase == VisualPhase.LOST && previous?.estimate != null &&
                previous.key.generation == signal.observation.key.generation &&
                previous.key.source == signal.observation.key.source) lossEvents++
        } else corrections++
        lastTrackingSignal = signal
        if (trackingSamples.size < trackingCapacity) trackingSamples.add(TrackingMeasurement(endNanos - startNanos, signal))
        else unstoredSamples++
    }

    fun stop(token: Long, nowNanos: Long, interrupted: Boolean, reason: String?): DiagnosticFrameSnapshot? = synchronized(lock) {
        if (!recording || token != generation) return@synchronized null
        require(nowNanos >= startNanos)
        recording = false
        DiagnosticFrameSnapshot(nowNanos - startNanos, received, completed, truncated, interrupted, reason, frames.toList(), staleDiscarded,
            input.copy(fps = if (nowNanos > startNanos) input.received * 1_000_000_000.0 / (nowNanos - startNanos) else null),
            if (observedFrames + corrections > 0)
                TrackingSnapshot(observedFrames, trackUpdates, corrections, lossEvents, unstoredSamples, trackingSamples.toList())
            else null)
    }
}

data class DiagnosticFrameSnapshot(
    val durationNanos: Long,
    val analyzerCallbacks: Long,
    val completedFrames: Long,
    val unstoredFrames: Long,
    val interrupted: Boolean,
    val reason: String?,
    val frames: List<FrameMeasurement>,
    val staleFramesDiscarded: Long = 0,
    val cameraInput: CameraInputStats = CameraInputStats(),
    val tracking: TrackingSnapshot? = null,
) {
    /** Session-wall-time throughput; pauses/stalls are included. Not camera FPS. */
    val processedFps: Double? get() = if (durationNanos > 0) completedFrames * 1_000_000_000.0 / durationNanos else null
}

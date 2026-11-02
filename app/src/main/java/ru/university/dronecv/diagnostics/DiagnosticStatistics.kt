package ru.university.dronecv.diagnostics

import kotlin.math.ceil

/** Statistics over measured frame durations in milliseconds; p95 is nearest rank. */
data class DurationSummary(
    val count: Int,
    val mean: Double,
    val median: Double,
    val p95: Double,
    val min: Double,
    val max: Double,
)

fun durationSummary(values: List<Double>): DurationSummary? {
    if (values.isEmpty()) return null
    require(values.all { it.isFinite() && it >= 0.0 })
    val sorted = values.sorted()
    val n = sorted.size
    val median = if (n % 2 == 1) sorted[n / 2] else (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    return DurationSummary(n, sorted.average(), median, sorted[ceil(.95 * n).toInt() - 1], sorted.first(), sorted.last())
}

/** The monotonic frame duration excludes time between capture and analyzer entry and display. */
data class FrameMeasurement(
    val offsetNanos: Long,
    val conversionMs: Double,
    val preprocessMs: Double,
    val inferenceMs: Double,
    val postprocessMs: Double,
    val pipelineMs: Double,
)

/** Bounded, synchronized storage. Old session tokens can never publish into a new session. */
class DiagnosticFrames(private val capacity: Int = 100_000) {
    init { require(capacity > 0) }
    private val lock = Any()
    private var generation = 0L
    private var recording = false
    private var startNanos = 0L
    private var received = 0L
    private var completed = 0L
    private var truncated = 0L
    private val frames = ArrayList<FrameMeasurement>()

    fun start(nowNanos: Long): Long = synchronized(lock) {
        check(!recording)
        generation++
        startNanos = nowNanos
        received = 0
        completed = 0
        truncated = 0
        frames.clear()
        recording = true
        generation
    }
    fun currentToken(): Long? = synchronized(lock) { generation.takeIf { recording } }
    fun received(token: Long) = synchronized(lock) { if (recording && token == generation) received++ }
    fun completed(token: Long, endNanos: Long, conversionMs: Double, preprocessMs: Double,
                  inferenceMs: Double, postprocessMs: Double, pipelineMs: Double) = synchronized(lock) {
        if (!recording || token != generation) return@synchronized
        val times = listOf(conversionMs, preprocessMs, inferenceMs, postprocessMs, pipelineMs)
        require(endNanos >= startNanos && times.all { it.isFinite() && it >= 0 })
        completed++
        if (frames.size < capacity) frames.add(FrameMeasurement(endNanos - startNanos, conversionMs,
            preprocessMs, inferenceMs, postprocessMs, pipelineMs)) else truncated++
    }
    fun stop(token: Long, nowNanos: Long, interrupted: Boolean, reason: String?): DiagnosticFrameSnapshot? = synchronized(lock) {
        if (!recording || token != generation) return@synchronized null
        require(nowNanos >= startNanos)
        recording = false
        DiagnosticFrameSnapshot(nowNanos - startNanos, received, completed, truncated, interrupted, reason, frames.toList())
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
) {
    /** Session-wall-time throughput; pauses/stalls are included. Not camera FPS. */
    val processedFps: Double? get() = if (durationNanos > 0) completedFrames * 1_000_000_000.0 / durationNanos else null
}

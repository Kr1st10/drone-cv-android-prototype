package ru.university.dronecv.camera

import kotlin.math.hypot
import kotlin.math.max
import ru.university.dronecv.detection.Detection

/** Camera timestamp source, not the clock used for backend stage durations. */
enum class CaptureTimebase { ELAPSED_REALTIME, UNKNOWN }

/** Camera2 exposure timestamp and analyzer entry; only REALTIME permits subtraction from elapsedRealtimeNanos. */
data class FrameStamp(val captureNs: Long?, val timebase: CaptureTimebase, val analyzerEntryNs: Long) {
    fun timingIssue(dispatchNs: Long): String? = when {
        timebase != CaptureTimebase.ELAPSED_REALTIME -> "unsynchronized_camera_clock"
        captureNs == null || captureNs <= 0 -> "missing_capture_timestamp"
        captureNs > analyzerEntryNs -> "capture_after_analyzer"
        dispatchNs < analyzerEntryNs -> "non_monotonic_dispatch_clock"
        else -> null
    }

    /** Milliseconds since exposure, or null when the time bases/order do not permit subtraction. */
    fun ageAt(nowNs: Long): Double? = if (timingIssue(nowNs) == null)
        (nowNs - checkNotNull(captureNs)) / 1_000_000.0 else null
}

/** Continuous upright-crop pixel coordinates; integer pixel indices use floor on nonnegative values. */
data class PixelPoint(val x: Double, val y: Double)
/** Apparent image-plane motion in pixels per second, including motion of the phone. */
data class PixelVelocity(val xPerSecond: Double, val yPerSecond: Double)
/** Predicted position at [afterSignalMs] after internal dispatch, not after the old exposure. */
data class ForecastPoint(val afterSignalMs: Int, val point: PixelPoint)
enum class TargetStatus { OBSERVED, LOST, NO_TARGET }

/**
 * Latest internal signal, in upright crop pixels; forecasts are estimates, never detector boxes.
 * [frameId] counts emitted signals in one controller; [sourceId] identifies its analyzer activation.
 * [dispatchNs] uses the same elapsed-realtime clock as [FrameStamp.analyzerEntryNs].
 * [history] contains observed centers for UI only; the JSON payload omits it.
 * [predictionErrorPx] evaluates the previous fit at the current observed exposure, not at dispatch.
 * Invalid dimensions, non-finite coordinates/velocity or negative errors throw IllegalArgumentException.
 */
data class TargetSignal(
    val frameId: Long,
    val sourceId: Long,
    val stamp: FrameStamp,
    val dispatchNs: Long,
    val width: Int,
    val height: Int,
    val targetId: Long?,
    val status: TargetStatus,
    val observed: PixelPoint?,
    val confidence: Float?,
    val velocity: PixelVelocity?,
    val history: List<PixelPoint>,
    val forecast: List<ForecastPoint>,
    val predictionIssue: String?,
    val predictionErrorPx: Double?,
) {
    init {
        require(width > 0 && height > 0 && frameId > 0)
        require(observed == null || (observed.x in 0.0..(width - 1).toDouble() && observed.y in 0.0..(height - 1).toDouble()))
        require((status == TargetStatus.OBSERVED) == (observed != null))
        require(confidence == null || confidence in 0f..1f)
        require(velocity == null || (velocity.xPerSecond.isFinite() && velocity.yPerSecond.isFinite()))
        require(forecast.all { it.afterSignalMs >= 0 && it.point.x.isFinite() && it.point.y.isFinite() })
        require(predictionErrorPx == null || (predictionErrorPx.isFinite() && predictionErrorPx >= 0))
    }
    val timingIssue: String? get() = stamp.timingIssue(dispatchNs)
    val captureToSignalMs: Double? get() = stamp.ageAt(dispatchNs)
    val captureToAnalyzerMs: Double? get() = if (timingIssue == null)
        (stamp.analyzerEntryNs - checkNotNull(stamp.captureNs)) / 1_000_000.0 else null
    val analyzerToSignalMs: Double? get() = if (dispatchNs >= stamp.analyzerEntryNs)
        (dispatchNs - stamp.analyzerEntryNs) / 1_000_000.0 else null
}

internal data class TargetObservation(
    val id: Long?, val status: TargetStatus, val point: PixelPoint?, val confidence: Float?,
    val velocity: PixelVelocity?, val history: List<PixelPoint>, val predictionErrorPx: Double?,
)

/** Single-target association and a least-squares constant-velocity fit over up to five camera observations. */
internal class TargetTracker {
    private data class Sample(val ns: Long, val point: PixelPoint)
    private val samples = ArrayDeque<Sample>()
    private var nextId = 0L
    private var id: Long? = null
    private var previous: Detection? = null
    private var width = 0
    private var height = 0

    fun reset() { samples.clear(); id = null; previous = null }

    fun observe(detections: List<Detection>, width: Int, height: Int, captureNs: Long?): TargetObservation {
        require(width > 0 && height > 0)
        if (this.width != width || this.height != height) reset()
        this.width = width; this.height = height
        val timestamp = captureNs?.takeIf { it > 0 }
        val last = samples.lastOrNull()
        if (timestamp == null || (last != null && (timestamp <= last.ns || timestamp - last.ns > 2_000_000_000L))) reset()
        val valid = detections.filter { it.classId == 0 && it.box.right > it.box.left && it.box.bottom > it.box.top }
        val oldVelocity = velocity()
        val anchor = samples.lastOrNull()
        val chosen = if (id == null || anchor == null) valid.maxByOrNull { it.confidence } else {
            val seconds = (checkNotNull(timestamp) - anchor.ns) / 1_000_000_000.0
            val expected = extrapolate(anchor.point, oldVelocity, seconds)
            val gate = max(.06, max(previous!!.box.right - previous!!.box.left,
                previous!!.box.bottom - previous!!.box.top).toDouble() * 1.5).coerceAtMost(.25)
            val ranked = valid.map { it to distance(center(it), expected) }.filter { it.second <= gate }.sortedBy { it.second }
            // An ambiguous crossing invalidates identity rather than switching to the other drone.
            if (ranked.size > 1 && ranked[1].second - ranked[0].second < .02) null else ranked.firstOrNull()?.first
        }
        if (chosen == null) {
            val lostId = id
            reset()
            return TargetObservation(lostId, if (lostId == null) TargetStatus.NO_TARGET else TargetStatus.LOST,
                null, null, null, emptyList(), null)
        }
        if (id == null) id = ++nextId
        val point = center(chosen)
        val error = if (anchor != null && oldVelocity != null && timestamp != null && timestamp - anchor.ns <= 1_000_000_000L) {
            val predicted = extrapolate(anchor.point, oldVelocity, (timestamp - anchor.ns) / 1_000_000_000.0)
            hypot(predicted.x - point.x, predicted.y - point.y)
        } else null
        previous = chosen
        if (timestamp != null) {
            samples.addLast(Sample(timestamp, point))
            while (samples.size > 5 || (samples.size > 1 && timestamp - samples.first().ns > 2_000_000_000L)) samples.removeFirst()
        }
        return TargetObservation(id, TargetStatus.OBSERVED, point, chosen.confidence, velocity(), samples.map { it.point }, error)
    }

    private fun center(d: Detection) = PixelPoint(
        ((d.box.left + d.box.right) * .5 * width).coerceIn(0.0, (width - 1).toDouble()),
        ((d.box.top + d.box.bottom) * .5 * height).coerceIn(0.0, (height - 1).toDouble()))

    private fun distance(a: PixelPoint, b: PixelPoint) = hypot((a.x - b.x) / width, (a.y - b.y) / height)

    private fun velocity(): PixelVelocity? {
        if (samples.size < 3 || samples.last().ns - samples.first().ns < 20_000_000L) return null
        val origin = samples.first().ns
        val ts = samples.map { (it.ns - origin) / 1_000_000_000.0 }
        val mean = ts.average(); val x = samples.map { it.point.x }.average(); val y = samples.map { it.point.y }.average()
        val denominator = ts.sumOf { (it - mean) * (it - mean) }
        if (denominator <= 0) return null
        return PixelVelocity(samples.withIndex().sumOf { (ts[it.index] - mean) * (it.value.point.x - x) } / denominator,
            samples.withIndex().sumOf { (ts[it.index] - mean) * (it.value.point.y - y) } / denominator)
    }
}

private fun extrapolate(point: PixelPoint, velocity: PixelVelocity?, seconds: Double) = PixelPoint(
    point.x + (velocity?.xPerSecond ?: 0.0) * seconds, point.y + (velocity?.yPerSecond ?: 0.0) * seconds)

/** Predictions cover signal time and +100/+200 ms, bounded to 1 s from the last exposure. */
internal fun targetSignal(frameId: Long, sourceId: Long, stamp: FrameStamp, dispatchNs: Long,
                          width: Int, height: Int, observation: TargetObservation): TargetSignal {
    val age = stamp.ageAt(dispatchNs)
    val issue = when {
        observation.point == null -> "no_observed_target"
        stamp.timingIssue(dispatchNs) != null -> stamp.timingIssue(dispatchNs)
        observation.velocity == null -> "insufficient_history"
        checkNotNull(age) + 200 > 1000 -> "prediction_horizon_exceeded"
        else -> null
    }
    val predicted = if (issue == null) listOf(0, 100, 200).map { offset ->
        ForecastPoint(offset, extrapolate(checkNotNull(observation.point), observation.velocity, (checkNotNull(age) + offset) / 1000))
    } else emptyList()
    val outside = predicted.any { it.point.x !in 0.0..(width - 1).toDouble() || it.point.y !in 0.0..(height - 1).toDouble() }
    return TargetSignal(frameId, sourceId, stamp, dispatchNs, width, height, observation.id, observation.status,
        observation.point, observation.confidence, observation.velocity, observation.history,
        if (outside) emptyList() else predicted, if (outside) "prediction_outside_frame" else issue, observation.predictionErrorPx)
}

/** Additive JSON payload for diagnostic schema 1. All coordinates refer to this signal's upright crop. */
fun TargetSignal.toJson(): String {
    fun point(p: PixelPoint?) = p?.let { "{\"x\":${it.x},\"y\":${it.y}}" } ?: "null"
    fun text(s: String?): String = if (s == null) "null" else buildString {
        append('"')
        s.forEach { c -> when (c) {
            '"' -> append("\\\""); '\\' -> append("\\\\")
            else -> if (c.code < 32) append("\\u%04x".format(c.code)) else append(c)
        } }
        append('"')
    }
    val forecastJson = forecast.joinToString(",") { "{\"after_signal_ms\":${it.afterSignalMs},\"point\":${point(it.point)}}" }
    return "{\"schema_version\":1,\"frame_id\":$frameId,\"source_id\":$sourceId,\"target_id\":$targetId,\"status\":\"${status.name.lowercase()}\"," +
        "\"capture_ns\":${stamp.captureNs},\"timestamp_source\":\"${stamp.timebase.name.lowercase()}\",\"analyzer_entry_ns\":${stamp.analyzerEntryNs},\"signal_dispatch_ns\":$dispatchNs," +
        "\"capture_to_signal_ms\":$captureToSignalMs,\"capture_to_analyzer_ms\":$captureToAnalyzerMs,\"analyzer_to_signal_ms\":$analyzerToSignalMs,\"timing_issue\":${text(timingIssue)}," +
        "\"width\":$width,\"height\":$height,\"coordinate_space\":\"upright_crop_pixels\",\"observed\":${point(observed)}," +
        "\"observed_pixel\":${observed?.let { "{\"x\":${it.x.toInt()},\"y\":${it.y.toInt()}}" } ?: "null"},\"confidence\":$confidence," +
        "\"velocity_px_per_second\":${velocity?.let { "{\"x\":${it.xPerSecond},\"y\":${it.yPerSecond}}" } ?: "null"}," +
        "\"forecast\":[$forecastJson]," +
        "\"prediction_issue\":${text(predictionIssue)},\"one_step_prediction_error_px\":$predictionErrorPx}"
}

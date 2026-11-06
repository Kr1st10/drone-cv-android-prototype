package ru.university.dronecv.camera

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
enum class TargetStatus { DETECTED, NO_TARGET }

/**
 * One frame's selection in upright-crop pixels; frame/source IDs describe publication, never object identity.
 * [dispatchNs] and [stamp.analyzerEntryNs] use elapsedRealtimeNanos; capture latency requires REALTIME.
 * [width]/[height] describe the processed crop. NO_TARGET requires null [center] and [confidence].
 * Invalid dimensions, frame ID, point, status/center or confidence throw IllegalArgumentException.
 */
data class TargetSignal(
    val frameId: Long,
    val sourceId: Long,
    val stamp: FrameStamp,
    val dispatchNs: Long,
    val width: Int,
    val height: Int,
    val status: TargetStatus,
    val center: PixelPoint?,
    val confidence: Float?,
) {
    init {
        require(width > 0 && height > 0 && frameId > 0)
        require(center == null || (center.x in 0.0..(width - 1).toDouble() && center.y in 0.0..(height - 1).toDouble()))
        require((status == TargetStatus.DETECTED) == (center != null))
        require((center == null) == (confidence == null))
        require(confidence == null || confidence in 0f..1f)
    }
    val timingIssue: String? get() = stamp.timingIssue(dispatchNs)
    val captureToSignalMs: Double? get() = stamp.ageAt(dispatchNs)
    val captureToAnalyzerMs: Double? get() = if (timingIssue == null)
        (stamp.analyzerEntryNs - checkNotNull(stamp.captureNs)) / 1_000_000.0 else null
    val analyzerToSignalMs: Double? get() = if (dispatchNs >= stamp.analyzerEntryNs)
        (dispatchNs - stamp.analyzerEntryNs) / 1_000_000.0 else null
}

internal data class DetectedTarget(val center: PixelPoint, val confidence: Float)

/** Independent selection from the current YOLO frame; equal confidence keeps the first detection. */
internal fun selectTarget(detections: List<Detection>, width: Int, height: Int): DetectedTarget? {
    require(width > 0 && height > 0)
    val chosen = detections.maxByOrNull { it.confidence } ?: return null
    return DetectedTarget(PixelPoint(
        ((chosen.box.left.toDouble() + chosen.box.right) * .5 * width).coerceIn(0.0, (width - 1).toDouble()),
        ((chosen.box.top.toDouble() + chosen.box.bottom) * .5 * height).coerceIn(0.0, (height - 1).toDouble())), chosen.confidence)
}

internal fun targetSignal(frameId: Long, sourceId: Long, stamp: FrameStamp, dispatchNs: Long,
                          width: Int, height: Int, target: DetectedTarget?): TargetSignal =
    TargetSignal(frameId, sourceId, stamp, dispatchNs, width, height,
        if (target == null) TargetStatus.NO_TARGET else TargetStatus.DETECTED, target?.center, target?.confidence)

/** Payload v2 is embedded in diagnostic schema 1. Coordinates refer to this frame's upright crop. */
fun TargetSignal.toJson(): String {
    fun point(p: PixelPoint?) = p?.let { "{\"x\":${it.x},\"y\":${it.y}}" } ?: "null"
    val issue = timingIssue?.let { "\"$it\"" } ?: "null"
    return "{\"schema_version\":2,\"frame_id\":$frameId,\"source_id\":$sourceId,\"status\":\"${status.name.lowercase()}\"," +
        "\"capture_ns\":${stamp.captureNs},\"timestamp_source\":\"${stamp.timebase.name.lowercase()}\",\"analyzer_entry_ns\":${stamp.analyzerEntryNs},\"signal_dispatch_ns\":$dispatchNs," +
        "\"capture_to_signal_ms\":$captureToSignalMs,\"capture_to_analyzer_ms\":$captureToAnalyzerMs,\"analyzer_to_signal_ms\":$analyzerToSignalMs,\"timing_issue\":$issue," +
        "\"width\":$width,\"height\":$height,\"coordinate_space\":\"upright_crop_pixels\",\"center\":${point(center)}," +
        "\"pixel\":${center?.let { "{\"x\":${it.x.toInt()},\"y\":${it.y.toInt()}}" } ?: "null"},\"confidence\":$confidence}"
}

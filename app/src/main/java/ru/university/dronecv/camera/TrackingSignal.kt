package ru.university.dronecv.camera

import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.TrackBox

internal const val MAX_TRACKING_SILENCE_NS = 250_000_000L

enum class TrackingSampleKind { FRAME, CORRECTION }

/** Internal publication on a real upright frame. A correction can revise the same frame without counting it again. */
data class TrackingSignal(
    val observation: TrackingObservation,
    val kind: TrackingSampleKind,
    val width: Int,
    val height: Int,
    val dispatchNs: Long,
    val workMs: Double,
    val trackingWidth: Int = width,
    val trackingHeight: Int = height,
    /** Monotonic UI deadline; this is not a duration or a measurement in the report. */
    val displayUntilNs: Long = dispatchNs + MAX_TRACKING_SILENCE_NS,
) {
    init {
        require(trackingWidth in 1..width && trackingHeight in 1..height && workMs.isFinite() && workMs >= 0)
    }
    val box: TrackBox? get() = observation.estimate?.box?.let {
        val sx = width.toDouble() / trackingWidth
        val sy = height.toDouble() / trackingHeight
        TrackBox(it.left * sx, it.top * sy, (it.right * sx).coerceAtMost(width.toDouble()),
            (it.bottom * sy).coerceAtMost(height.toDouble()))
    }
    val center: PixelPoint? get() = box?.let {
        PixelPoint(it.centerX.coerceIn(0.0, width - 1.0), it.centerY.coerceIn(0.0, height - 1.0))
    }
    val timingIssue get() = observation.stamp.timingIssue(dispatchNs)
    val captureToSignalMs get() = observation.stamp.ageAt(dispatchNs)
    val captureToAnalyzerMs get() = observation.stamp.ageAt(observation.stamp.analyzerEntryNs).takeIf { timingIssue == null }
    val analyzerToSignalMs get() = (dispatchNs - observation.stamp.analyzerEntryNs)
        .takeIf { it >= 0 }?.div(1e6)
    val confirmationAgeMs get() = observation.confirmationAgeMs(dispatchNs)
}

package ru.university.dronecv.tracking

import ru.university.dronecv.camera.FrameStamp

internal const val MAX_TRACK_GAP_NS = 150_000_000L
internal const val MAX_FRAME_AGE_MS = 250.0

/** Entry clocks always bound work; compatible capture clocks additionally bound the real observation gap. */
internal fun invalidGap(previous: GrayFrame, next: GrayFrame): Boolean {
    val entryGap = next.stamp.analyzerEntryNs - previous.stamp.analyzerEntryNs
    if (entryGap <= 0 || entryGap > MAX_TRACK_GAP_NS) return true
    val a = previous.stamp
    val b = next.stamp
    if (a.timingIssue(a.analyzerEntryNs) != null || b.timingIssue(b.analyzerEntryNs) != null) return false
    val captureGap = checkNotNull(b.captureNs) - checkNotNull(a.captureNs)
    return captureGap <= 0 || captureGap > MAX_TRACK_GAP_NS
}

internal fun confirmationExpired(stamp: FrameStamp, nowEntryNs: Long, ttlNs: Long): Boolean =
    nowEntryNs - stamp.analyzerEntryNs >= ttlNs ||
        stamp.ageAt(nowEntryNs)?.let { it >= ttlNs / 1_000_000.0 } == true

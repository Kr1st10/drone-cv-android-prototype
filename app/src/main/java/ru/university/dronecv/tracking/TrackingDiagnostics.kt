package ru.university.dronecv.tracking

/** Stable wire codes. UNKNOWN is mandatory for backends exposing only a null estimate. */
enum class TrackingFailure {
    UNKNOWN, NO_CANDIDATE, ASSOCIATION_REJECTED, INSUFFICIENT_POINTS,
    INVALID_BOX, LOW_TEXTURE, FRAME_GAP, GEOMETRY_CHANGED, HISTORY_MISSING, REPLAY_BUDGET,
    REPLAY_QUALITY, UPDATE_QUALITY, STALE_CORRECTION, CANCELLED, STALE_SESSION,
    CONFIRMATION_EXPIRED, PROCESSING_EXCEPTION, STALE_CAPTURE, STALE_QUEUE,
}

enum class TrackingEventKind {
    REQUEST_STARTED, REPLAY_PLANNED, INITIALIZATION_ATTEMPT, INITIALIZATION_SUCCEEDED, INITIALIZATION_FAILED,
    REPLAY_SUCCEEDED, REPLAY_FAILED, CORRECTION_ACCEPTED, REQUEST_REJECTED, TRACK_LOST,
}

data class TrackingEvent(val kind: TrackingEventKind, val reason: TrackingFailure? = null)

internal fun replayFailure(tracker: VisualTracker): TrackingFailure =
    if (tracker.failureReason == TrackingFailure.UPDATE_QUALITY) TrackingFailure.REPLAY_QUALITY else tracker.failureReason

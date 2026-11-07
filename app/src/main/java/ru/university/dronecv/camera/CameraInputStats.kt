package ru.university.dronecv.camera

enum class CameraInputEvent { RECEIVED, COPIED, SUPERSEDED, NO_BUFFER, STALE, INVALIDATED, ERROR }

/** Counts application input work, not unobservable upstream CameraX drops. */
data class CameraInputStats(
    val received: Long = 0,
    val copied: Long = 0,
    val superseded: Long = 0,
    val noBuffer: Long = 0,
    val stale: Long = 0,
    val invalidated: Long = 0,
    val errors: Long = 0,
    val copyTotalMs: Double = 0.0,
    val copyMaxMs: Double = 0.0,
    val fps: Double? = null,
) {
    val copyMeanMs: Double? get() = if (copied > 0) copyTotalMs / copied else null

    fun record(event: CameraInputEvent, copyMs: Double = 0.0): CameraInputStats {
        require(copyMs.isFinite() && copyMs >= 0)
        return when (event) {
            CameraInputEvent.RECEIVED -> copy(received = received + 1)
            CameraInputEvent.COPIED -> copy(copied = copied + 1, copyTotalMs = copyTotalMs + copyMs,
                copyMaxMs = maxOf(copyMaxMs, copyMs))
            CameraInputEvent.SUPERSEDED -> copy(superseded = superseded + 1)
            CameraInputEvent.NO_BUFFER -> copy(noBuffer = noBuffer + 1)
            CameraInputEvent.STALE -> copy(stale = stale + 1)
            CameraInputEvent.INVALIDATED -> copy(invalidated = invalidated + 1)
            CameraInputEvent.ERROR -> copy(errors = errors + 1)
        }
    }
}

class LiveFrameToken internal constructor(
    internal val generation: Long,
    internal val source: Long,
    internal val diagnosticToken: Long?,
)

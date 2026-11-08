package ru.university.dronecv.camera

import java.util.concurrent.Executor
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.GrayFrame
import ru.university.dronecv.tracking.TrackingSession

/** The same serial executor must own frame ingress, session state and correction callbacks. */
class LiveTracking<Frame>(
    internal val executor: Executor,
    internal val session: TrackingSession,
    internal val grayscale: (Frame, FrameKey, FrameStamp) -> GrayFrame,
) {
    internal var generation = -1L
        private set
    internal var sequence = 0L
    @Volatile internal var inFlight = false
    internal var latestToken: LiveFrameToken? = null
    private val updates = ArrayDeque<Long>()

    internal fun reset(generation: Long, source: Long) {
        if (generation <= this.generation) return
        session.reset(generation, source)
        this.generation = generation
        sequence = 0
        latestToken = null
        updates.clear()
    }

    internal fun fps(signal: TrackingSignal): Double? {
        val ns = signal.observation.stamp.analyzerEntryNs
        if (signal.kind == TrackingSampleKind.FRAME && signal.center != null) updates.addLast(ns)
        while (updates.isNotEmpty() && (updates.size > 30 || ns - updates.first() > 1_000_000_000L)) updates.removeFirst()
        if (signal.center == null) { updates.clear(); return null }
        return if (updates.size > 1) (updates.size - 1) * 1e9 / (updates.last() - updates.first()) else null
    }
}

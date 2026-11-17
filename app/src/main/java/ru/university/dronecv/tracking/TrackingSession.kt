package ru.university.dronecv.tracking

import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.Detection
import kotlin.math.hypot
import java.util.concurrent.atomic.AtomicBoolean

enum class VisualPhase { SEARCHING, TRACKING, LOST }
enum class ClassConfirmation { NONE, CONFIRMED, MISSED, EXPIRED }

data class TrackingObservation(
    val key: FrameKey,
    val stamp: FrameStamp,
    val phase: VisualPhase,
    val trackId: Long?,
    val estimate: TrackEstimate?,
    val classification: ClassConfirmation,
    val lastYoloConfidence: Float?,
    val lastYoloStamp: FrameStamp?,
    val reason: String?,
    val lastYoloKey: FrameKey? = null,
    val lastYoloAcceptedNs: Long? = null,
) {
    /** Absolute age is unavailable for UNKNOWN Camera2 clocks, even if the visual track is good. */
    fun confirmationAgeMs(nowElapsedNs: Long): Double? = lastYoloStamp?.ageAt(nowElapsedNs)
}

class YoloRequest internal constructor(
    val anchor: GrayFrame,
    internal val epoch: Long,
    internal val expected: TrackBox?,
    internal val events: ((TrackingEvent) -> Unit)?,
) {
    internal var plan: CorrectionPlan? = null
}

/** Immutable replay input; create on the vision owner, run [replay] after ORT on the ML worker. */
class CorrectionPlan internal constructor(
    internal val request: YoloRequest,
    internal val detection: Detection,
    internal val frames: List<GrayFrame>,
    private val factory: () -> VisualTracker,
) {
    private val replayStarted = AtomicBoolean(false)
    internal val events = ArrayList<TrackingEvent>(4)
    @Volatile internal var completed = false
    internal var reported = false
    private fun rejected(why: TrackingFailure): ReplayedCorrection? {
        events.add(TrackingEvent(TrackingEventKind.REPLAY_FAILED, why))
        return null
    }
    /** Null has a structured outcome in [events]; the vision owner consumes it after [completed]. */
    fun replay(nanoTime: () -> Long = System::nanoTime,
               budgetNs: Long = 100_000_000L): ReplayedCorrection? {
        require(budgetNs > 0)
        if (!replayStarted.compareAndSet(false, true)) return null
        val start = nanoTime()
        var tracker: VisualTracker? = null
        var transferred = false
        try {
            tracker = factory()
            val anchor = request.anchor
            val box = TrackBox.from(detection.box, anchor.width, anchor.height) ?: return rejected(TrackingFailure.INVALID_BOX)
            events.add(TrackingEvent(TrackingEventKind.INITIALIZATION_ATTEMPT))
            var estimate = tracker.initialize(anchor, box) ?: run {
                events.add(TrackingEvent(TrackingEventKind.INITIALIZATION_FAILED, tracker.failureReason))
                return rejected(tracker.failureReason)
            }
            events.add(TrackingEvent(TrackingEventKind.INITIALIZATION_SUCCEEDED))
            var last = anchor
            for (frame in frames.drop(1)) {
                if (nanoTime() - start >= budgetNs) return rejected(TrackingFailure.REPLAY_BUDGET)
                if (!last.sameGeometry(frame)) return rejected(TrackingFailure.GEOMETRY_CHANGED)
                if (invalidGap(last, frame)) return rejected(TrackingFailure.FRAME_GAP)
                estimate = tracker.update(frame) ?: return rejected(replayFailure(tracker))
                last = frame
            }
            if (nanoTime() - start >= budgetNs) return rejected(TrackingFailure.REPLAY_BUDGET)
            val correction = ReplayedCorrection(this, tracker, last, estimate)
            events.add(TrackingEvent(TrackingEventKind.REPLAY_SUCCEEDED))
            transferred = true
            return correction
        } catch (e: Throwable) {
            if (events.lastOrNull()?.kind == TrackingEventKind.INITIALIZATION_ATTEMPT)
                events.add(TrackingEvent(TrackingEventKind.INITIALIZATION_FAILED, TrackingFailure.PROCESSING_EXCEPTION))
            events.add(TrackingEvent(TrackingEventKind.REPLAY_FAILED, TrackingFailure.PROCESSING_EXCEPTION))
            throw e
        } finally { try { if (!transferred) tracker?.close() } finally { completed = true } }
    }
}

/** Ownership passes from ML to vision at commit. A rejected/abandoned correction must be closed. */
class ReplayedCorrection internal constructor(
    internal val plan: CorrectionPlan,
    private var ownedTracker: VisualTracker?,
    internal val frame: GrayFrame,
    internal var estimate: TrackEstimate,
) : AutoCloseable {
    internal fun tracker(): VisualTracker = checkNotNull(ownedTracker)
    internal fun take(): VisualTracker = tracker().also { ownedTracker = null }
    override fun close() {
        val tracker = ownedTracker
        ownedTracker = null
        tracker?.close()
    }
}

/**
 * State machine confined to the vision executor. No method calls ORT.
 * The caller keeps one detector request in flight through completion of replay.
 */
class TrackingSession(
    private val factory: () -> VisualTracker,
    val yoloPeriodNs: Long = 500_000_000L,
    val confirmationTtlNs: Long = 1_000_000_000L,
    val retryNs: Long = 100_000_000L,
) : AutoCloseable {
    init { require(yoloPeriodNs > 0 && confirmationTtlNs > yoloPeriodNs && retryNs > 0) }
    /** Set by the owner for the current input token; a request captures this sink at admission. */
    var events: ((TrackingEvent) -> Unit)? = null
    private val history = GrayHistory()
    private var lastSeenSequence = 0L
    private var lastSeenEntryNs = -1L
    private var generation = 0L
    private var source = 0L
    private var epoch = 0L
    private var nextTrackId = 0L
    private var trackId: Long? = null
    private var tracker: VisualTracker? = null
    private var estimate: TrackEstimate? = null
    private var phase = VisualPhase.SEARCHING
    private var confirmation = ClassConfirmation.NONE
    private var lastYolo: FrameStamp? = null
    private var lastYoloKey: FrameKey? = null
    private var lastYoloAcceptedNs: Long? = null
    private var confidence: Float? = null
    private var lastRequestNs: Long? = null
    private var inFlight: YoloRequest? = null
    private var planned = false
    private var reason: String? = null
    private var closed = false

    fun reset(generation: Long, source: Long) {
        check(!closed)
        clearTrack(if (source != this.source) TrackingFailure.STALE_SESSION else TrackingFailure.CANCELLED)
        this.generation = generation
        this.source = source
        history.clear()
        lastSeenSequence = 0L
        lastSeenEntryNs = -1L
        lastRequestNs = null
        lastYolo = null
        lastYoloKey = null
        lastYoloAcceptedNs = null
        confidence = null
        confirmation = ClassConfirmation.NONE
        phase = VisualPhase.SEARCHING
        reason = null
    }

    /** Rejects old callbacks without disturbing the current track. Exactly one observation per fresh image. */
    fun observe(frame: GrayFrame): TrackingObservation? {
        if (closed || frame.key.generation != generation || frame.key.source != source) return null
        if (frame.key.sequence <= lastSeenSequence || frame.stamp.analyzerEntryNs <= lastSeenEntryNs) return null
        lastSeenSequence = frame.key.sequence
        lastSeenEntryNs = frame.stamp.analyzerEntryNs
        val previous = history.latest
        if (frame.stamp.ageAt(frame.stamp.analyzerEntryNs)?.let { it > MAX_FRAME_AGE_MS } == true) {
            lose("stale_capture", TrackingFailure.STALE_CAPTURE)
            history.clear()
            return observation(frame)
        }
        if (previous != null && (!previous.sameGeometry(frame) || invalidGap(previous, frame))) {
            lose("frame_gap_or_geometry", if (!previous.sameGeometry(frame)) TrackingFailure.GEOMETRY_CHANGED else TrackingFailure.FRAME_GAP)
            history.clear()
        }
        val confirmed = lastYolo
        if (tracker != null && confirmed != null &&
            confirmationExpired(confirmed, frame.stamp.analyzerEntryNs, confirmationTtlNs)) {
            lose("classification_expired", TrackingFailure.CONFIRMATION_EXPIRED)
            confirmation = ClassConfirmation.EXPIRED
        }
        if (tracker != null) {
            try {
                estimate = tracker?.update(frame)
                if (estimate == null) lose("visual_quality", tracker?.failureReason ?: TrackingFailure.UNKNOWN)
            } catch (e: Throwable) { lose("tracker_error", TrackingFailure.PROCESSING_EXCEPTION); throw e }
        }
        history.add(frame)
        return observation(frame)
    }

    /** Time based, never every Nth callback. The caller must reserve the sole ORT slot before dispatch. */
    fun requestYolo(detectorIdle: Boolean, nowElapsedNs: Long): YoloRequest? {
        if (closed || !detectorIdle || inFlight != null) return null
        val frame = history.latest ?: return null
        if (nowElapsedNs < frame.stamp.analyzerEntryNs ||
            nowElapsedNs - frame.stamp.analyzerEntryNs > 250_000_000L ||
            frame.stamp.ageAt(nowElapsedNs)?.let { it > MAX_FRAME_AGE_MS } == true) return null
        val weak = estimate?.quality?.let { it.retainedFraction < .7 || it.correlation < .75 } ?: true
        val period = if (tracker == null || weak || confirmation == ClassConfirmation.MISSED) retryNs else yoloPeriodNs
        if (lastRequestNs?.let { frame.stamp.analyzerEntryNs - it < period } == true) return null
        lastRequestNs = frame.stamp.analyzerEntryNs
        return YoloRequest(frame, epoch, estimate?.box, events).also {
            inFlight = it; planned = false
            it.events?.invoke(TrackingEvent(TrackingEventKind.REQUEST_STARTED))
        }
    }

    /** Select at the detector frame's timestamp, not against a more recent position. */
    fun prepareCorrection(request: YoloRequest, detections: List<Detection>): CorrectionPlan? {
        if (!accepts(request) || planned) return null
        val frames = history.from(request.anchor.key)
        if (frames == null) { reject(request, TrackingFailure.HISTORY_MISSING); reason = "history_evicted"; return null }
        val candidates = detections.filter { it.classId == 0 && it.label == "drone" &&
            TrackBox.from(it.box, request.anchor.width, request.anchor.height) != null }
        val chosen = if (request.expected == null) candidates.maxByOrNull { it.confidence }
            else associate(request.expected, candidates, request.anchor.width, request.anchor.height)
        if (chosen == null) {
            if (request.expected != null) confirmation = ClassConfirmation.MISSED
            reason = if (candidates.isEmpty()) "yolo_no_match" else "yolo_ambiguous_or_other_target"
            reject(request, if (candidates.isEmpty()) TrackingFailure.NO_CANDIDATE else TrackingFailure.ASSOCIATION_REJECTED)
            return null
        }
        planned = true
        return CorrectionPlan(request, chosen, frames, factory).also {
            request.plan = it
            request.events?.invoke(TrackingEvent(TrackingEventKind.REPLAY_PLANNED))
        }
    }

    /** Replays at most two tail frames here; larger lag requires a fresh request instead of a position jump. */
    fun commit(correction: ReplayedCorrection, nowElapsedNs: Long): TrackingObservation? {
        val request = correction.plan.request
        try {
            if (!accepts(request)) return null
            reportReplay(request)
            val latest = history.latest ?: run { reject(request, TrackingFailure.HISTORY_MISSING); return null }
            val tail = history.from(correction.frame.key)?.drop(1)
            if (tail == null || tail.size > 2 || nowElapsedNs < latest.stamp.analyzerEntryNs ||
                nowElapsedNs - latest.stamp.analyzerEntryNs > 250_000_000L ||
                latest.stamp.ageAt(nowElapsedNs)?.let { it > MAX_FRAME_AGE_MS } == true ||
                confirmationExpired(request.anchor.stamp, nowElapsedNs, confirmationTtlNs)) {
                reason = "correction_too_old"
                reject(request, if (tail == null) TrackingFailure.HISTORY_MISSING else TrackingFailure.STALE_CORRECTION)
                return null
            }
            var previous = correction.frame
            for (frame in tail) {
                if (!previous.sameGeometry(frame) || invalidGap(previous, frame)) {
                    reject(request, if (!previous.sameGeometry(frame)) TrackingFailure.GEOMETRY_CHANGED else TrackingFailure.FRAME_GAP)
                    return null
                }
                correction.estimate = correction.tracker().update(frame) ?: run {
                    reject(request, replayFailure(correction.tracker())); return null
                }
                previous = frame
            }
            val previousTracker = tracker
            tracker = null
            estimate = null
            previousTracker?.close()
            tracker = correction.take()
            estimate = correction.estimate
            if (trackId == null) trackId = ++nextTrackId
            phase = VisualPhase.TRACKING
            lastYolo = request.anchor.stamp
            lastYoloKey = request.anchor.key
            lastYoloAcceptedNs = nowElapsedNs
            confidence = correction.plan.detection.confidence
            confirmation = ClassConfirmation.CONFIRMED
            reason = null
            request.events?.invoke(TrackingEvent(TrackingEventKind.CORRECTION_ACCEPTED))
            complete(request)
            return observation(latest)
        } catch (e: Throwable) {
            reject(request, TrackingFailure.PROCESSING_EXCEPTION)
            lose("correction_error", TrackingFailure.PROCESSING_EXCEPTION)
            throw e
        } finally { correction.close() }
    }

    internal fun rejectCorrection(request: YoloRequest) {
        if (!accepts(request)) return
        reportReplay(request)
        reason = "replay_rejected"
        reject(request, request.plan?.events?.lastOrNull { it.kind == TrackingEventKind.REPLAY_FAILED }?.reason
            ?: TrackingFailure.UNKNOWN)
    }

    private fun reportReplay(request: YoloRequest) {
        request.plan?.let { plan ->
            if (plan.completed && !plan.reported) {
                plan.reported = true
                plan.events.forEach { request.events?.invoke(it) }
            }
        }
    }

    internal fun reject(request: YoloRequest, why: TrackingFailure) {
        if (inFlight !== request) return
        reportReplay(request)
        request.events?.invoke(TrackingEvent(TrackingEventKind.REQUEST_REJECTED, why))
        complete(request)
    }

    internal fun confirmationDeadlineNs(observation: TrackingObservation): Long? =
        observation.lastYoloStamp?.let { confirmationDeadlineNs(it, confirmationTtlNs) }

    /** Also call after ORT/replay failure, executor rejection or cancellation. */
    fun finish(request: YoloRequest) { reject(request, TrackingFailure.CANCELLED) }

    private fun complete(request: YoloRequest) {
        if (inFlight === request) { inFlight = null; planned = false }
    }

    private fun accepts(request: YoloRequest): Boolean = !closed && inFlight === request && request.epoch == epoch &&
        request.anchor.key.generation == generation && request.anchor.key.source == source

    private fun observation(frame: GrayFrame) = TrackingObservation(frame.key, frame.stamp, phase, trackId, estimate,
        confirmation, confidence, lastYolo, reason, lastYoloKey, lastYoloAcceptedNs)

    private fun lose(why: String, failure: TrackingFailure) {
        if (trackId != null) events?.invoke(TrackingEvent(TrackingEventKind.TRACK_LOST, failure))
        inFlight?.let { reject(it, failure) }
        phase = VisualPhase.LOST
        reason = why
        clearTrack()
    }

    private fun clearTrack(cancellation: TrackingFailure = TrackingFailure.CANCELLED) {
        inFlight?.let { reject(it, cancellation) }
        epoch++
        val previousTracker = tracker
        tracker = null
        estimate = null
        trackId = null
        inFlight = null
        planned = false
        previousTracker?.close()
    }

    override fun close() {
        if (closed) return
        closed = true
        try { clearTrack() } finally { history.clear() }
    }

    companion object {
        /** Geometry gates are conservative, not proof of physical identity when objects cross. */
        internal fun associate(expected: TrackBox, candidates: List<Detection>, width: Int, height: Int): Detection? {
            val ranked = candidates.mapNotNull { detection ->
                val box = TrackBox.from(detection.box, width, height) ?: return@mapNotNull null
                val overlap = expected.iou(box)
                val distance = hypot(box.centerX - expected.centerX, box.centerY - expected.centerY)
                if (overlap < .2 || distance > .6 * hypot(expected.width, expected.height) ||
                    box.width / expected.width !in .5..2.0 || box.height / expected.height !in .5..2.0) null
                else detection to overlap
            }.sortedByDescending { it.second }
            if (ranked.isEmpty() || (ranked.size > 1 && ranked[0].second - ranked[1].second < .15)) return null
            return ranked[0].first
        }
    }
}

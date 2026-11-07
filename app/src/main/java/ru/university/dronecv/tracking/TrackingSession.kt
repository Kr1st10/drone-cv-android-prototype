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
) {
    /** Absolute age is unavailable for UNKNOWN Camera2 clocks, even if the visual track is good. */
    fun confirmationAgeMs(nowElapsedNs: Long): Double? = lastYoloStamp?.ageAt(nowElapsedNs)
}

class YoloRequest internal constructor(
    val anchor: GrayFrame,
    internal val epoch: Long,
    internal val expected: TrackBox?,
)

/** Immutable replay input; create on the vision owner, run [replay] after ORT on the ML worker. */
class CorrectionPlan internal constructor(
    internal val request: YoloRequest,
    internal val detection: Detection,
    internal val frames: List<GrayFrame>,
    private val factory: () -> VisualTracker,
) {
    private val replayStarted = AtomicBoolean(false)
    /** Null means loss, a missing/old frame or budget exhaustion. This does not publish a result. */
    fun replay(nanoTime: () -> Long = System::nanoTime,
               budgetNs: Long = 100_000_000L): ReplayedCorrection? {
        require(budgetNs > 0)
        if (!replayStarted.compareAndSet(false, true)) return null
        val start = nanoTime()
        val tracker = factory()
        var transferred = false
        try {
            val anchor = request.anchor
            val box = TrackBox.from(detection.box, anchor.width, anchor.height) ?: return null
            var estimate = tracker.initialize(anchor, box) ?: return null
            var last = anchor
            for (frame in frames.drop(1)) {
                if (nanoTime() - start >= budgetNs || invalidGap(last, frame)) return null
                estimate = tracker.update(frame) ?: return null
                last = frame
            }
            if (nanoTime() - start >= budgetNs) return null
            return ReplayedCorrection(this, tracker, last, estimate).also { transferred = true }
        } finally { if (!transferred) tracker.close() }
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
 * Single vision-owner state machine, not wired into CameraScreen yet. No method calls ORT.
 * Requests require the shared DetectorWorker to be idle; only replay uses a separate tracker instance.
 */
class TrackingSession(
    private val factory: () -> VisualTracker,
    private val yoloPeriodNs: Long = 500_000_000L,
    private val confirmationTtlNs: Long = 1_000_000_000L,
    private val retryNs: Long = 100_000_000L,
) : AutoCloseable {
    init { require(yoloPeriodNs > 0 && confirmationTtlNs > yoloPeriodNs && retryNs > 0) }
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
    private var confidence: Float? = null
    private var lastRequestNs: Long? = null
    private var inFlight: YoloRequest? = null
    private var planned = false
    private var reason: String? = null
    private var closed = false

    fun reset(generation: Long, source: Long) {
        check(!closed)
        clearTrack()
        this.generation = generation
        this.source = source
        history.clear()
        lastSeenSequence = 0L
        lastSeenEntryNs = -1L
        lastRequestNs = null
        lastYolo = null
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
            lose("stale_capture")
            history.clear()
            return observation(frame)
        }
        if (previous != null && (previous.width != frame.width || previous.height != frame.height ||
                invalidGap(previous, frame))) {
            lose("frame_gap_or_geometry")
            history.clear()
        }
        val confirmed = lastYolo
        if (tracker != null && confirmed != null &&
            confirmationExpired(confirmed, frame.stamp.analyzerEntryNs, confirmationTtlNs)) {
            lose("classification_expired")
            confirmation = ClassConfirmation.EXPIRED
        }
        if (tracker != null) {
            try {
                estimate = tracker?.update(frame)
                if (estimate == null) lose("visual_quality")
            } catch (e: Throwable) { lose("tracker_error"); throw e }
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
        return YoloRequest(frame, epoch, estimate?.box).also { inFlight = it; planned = false }
    }

    /** Select at the detector frame's timestamp, not against a more recent position. */
    fun prepareCorrection(request: YoloRequest, detections: List<Detection>): CorrectionPlan? {
        if (!accepts(request) || planned) return null
        val frames = history.from(request.anchor.key)
        if (frames == null) { finish(request); reason = "history_evicted"; return null }
        val candidates = detections.filter { it.classId == 0 && it.label == "drone" &&
            TrackBox.from(it.box, request.anchor.width, request.anchor.height) != null }
        val chosen = if (request.expected == null) candidates.maxByOrNull { it.confidence }
            else associate(request.expected, candidates, request.anchor.width, request.anchor.height)
        if (chosen == null) {
            if (request.expected != null) confirmation = ClassConfirmation.MISSED
            reason = if (candidates.isEmpty()) "yolo_no_match" else "yolo_ambiguous_or_other_target"
            finish(request)
            return null
        }
        planned = true
        return CorrectionPlan(request, chosen, frames, factory)
    }

    /** Replays at most two tail frames here; larger lag requires a fresh request instead of a position jump. */
    fun commit(correction: ReplayedCorrection, nowElapsedNs: Long): TrackingObservation? {
        val request = correction.plan.request
        try {
            if (!accepts(request)) return null
            val latest = history.latest ?: return null
            val tail = history.from(correction.frame.key)?.drop(1)
            if (tail == null || tail.size > 2 || nowElapsedNs < latest.stamp.analyzerEntryNs ||
                nowElapsedNs - latest.stamp.analyzerEntryNs > 250_000_000L ||
                latest.stamp.ageAt(nowElapsedNs)?.let { it > MAX_FRAME_AGE_MS } == true ||
                confirmationExpired(request.anchor.stamp, nowElapsedNs, confirmationTtlNs)) {
                reason = "correction_too_old"
                finish(request)
                return null
            }
            var previous = correction.frame
            for (frame in tail) {
                if (invalidGap(previous, frame)) {
                    finish(request); return null
                }
                correction.estimate = correction.tracker().update(frame) ?: run {
                    finish(request); return null
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
            confidence = correction.plan.detection.confidence
            confirmation = ClassConfirmation.CONFIRMED
            reason = null
            finish(request)
            return observation(latest)
        } catch (e: Throwable) {
            lose("correction_error")
            throw e
        } finally { correction.close() }
    }

    /** Also call after ORT/replay failure, executor rejection or cancellation. */
    fun finish(request: YoloRequest) {
        if (inFlight === request) { inFlight = null; planned = false }
    }

    private fun accepts(request: YoloRequest): Boolean = !closed && inFlight === request && request.epoch == epoch &&
        request.anchor.key.generation == generation && request.anchor.key.source == source

    private fun observation(frame: GrayFrame) = TrackingObservation(frame.key, frame.stamp, phase, trackId, estimate,
        confirmation, confidence, lastYolo, reason)

    private fun lose(why: String) {
        phase = VisualPhase.LOST
        reason = why
        clearTrack()
    }

    private fun clearTrack() {
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

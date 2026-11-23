package ru.university.dronecv.centering

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.university.dronecv.camera.MAX_TRACKING_SILENCE_NS
import ru.university.dronecv.camera.PixelPoint
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.VisualPhase
import ru.university.dronecv.tracking.confirmationDeadlineNs

private const val NS_PER_MS = 1_000_000L

internal data class CenteringConfig(
    val deadZoneWidthPx: Double,
    val deadZoneHeightPx: Double = deadZoneWidthPx,
    val coordinatesTtlNs: Long = MAX_TRACKING_SILENCE_NS,
    val confirmationTtlNs: Long = 1_000_000_000L,
) {
    init {
        require(deadZoneWidthPx.isFinite() && deadZoneWidthPx >= 0)
        require(deadZoneHeightPx.isFinite() && deadZoneHeightPx >= 0)
        require(coordinatesTtlNs > 0 && confirmationTtlNs > 0)
    }
}

internal data class CenteringSession(val generation: Long, val source: Long) {
    fun matches(key: FrameKey) = generation == key.generation && source == key.source
}

internal enum class Horizontal { LEFT, RIGHT, NONE }
internal enum class Vertical { UP, DOWN, NONE }
internal enum class CenteringAction { MOVE, HOLD, STOP }
internal enum class BoxState { PRESENT, MISSING, STALE }
internal enum class CenteringReason {
    TARGET_OFFSET, IN_DEAD_ZONE, WAITING_FOR_BOX, BOX_LOST, COORDINATES_EXPIRED,
    YOLO_UNCONFIRMED, CONFIRMATION_EXPIRED, TRACKING_CLEARED, CAMERA_STOPPED, CAMERA_PAUSED,
    CAMERA_ERROR, SOURCE_CHANGED, RECORDING_STOPPED, INPUT_OVERFLOW,
}

internal data class CenteringDecision(
    val timeNs: Long,
    val session: CenteringSession,
    val boxState: BoxState,
    val yoloState: ClassConfirmation,
    val confirmationValid: Boolean,
    val offsetPx: PixelPoint?,
    val action: CenteringAction,
    val reason: CenteringReason,
    val horizontal: Horizontal = Horizontal.NONE,
    val vertical: Vertical = Vertical.NONE,
    val frameId: Long? = null,
) {
    fun toDryRunJson(startNs: Long): String =
        """{"mode":"dry_run","time_ms":${(timeNs - startNs) / 1e6},"generation":${session.generation},"source_id":${session.source},${decisionFields()}}"""

    fun toTimelineJson(): String {
        val frame = frameId?.let { "\"$it\"" } ?: "null"
        return """{"decision_ns":"$timeNs","generation":"${session.generation}","source_id":"${session.source}","frame_id":$frame,${decisionFields()}}"""
    }

    private fun decisionFields(): String =
        """"dx_px":${offsetPx?.x},"dy_px":${offsetPx?.y},"box_state":"$boxState","yolo_state":"$yoloState",""" +
            """"confirmation_valid":$confirmationValid,"action":"$action","horizontal":"$horizontal","vertical":"$vertical","reason":"$reason""""
}

/**
 * Run commands and [scope]'s timer on the same serial dispatcher. [publish] runs there too and
 * must return without calling back into this controller. Keep the scope active until [stop].
 * [nowNs] uses the same monotonic clock as signal dispatch and analyzer entry.
 */
internal class CameraCentering(
    private val config: CenteringConfig,
    private val scope: CoroutineScope,
    private val nowNs: () -> Long,
    private val publish: (CenteringDecision) -> Unit,
) {
    private data class Reading(
        val session: CenteringSession,
        val signal: TrackingSignal,
        val offsetPx: PixelPoint?,
        val coordinatesDeadlineNs: Long,
        val yoloDeadlineNs: Long?,
    ) {
        val deadlineNs get() = minOf(coordinatesDeadlineNs, yoloDeadlineNs ?: Long.MAX_VALUE)
    }

    private var active: CenteringSession? = null
    private var lastSession: CenteringSession? = null
    private var lastSequence = 0L
    private var clearedThroughSequence = 0L
    private var lastDispatchNs = Long.MIN_VALUE
    private var lastYoloState = ClassConfirmation.NONE
    private var pendingExpiry: Reading? = null
    private var expiryJob: Job? = null

    /** Admit a new session explicitly. A stopped generation/source pair cannot be reopened. */
    fun start(session: CenteringSession) {
        val previous = lastSession
        if (previous != null && (session == previous || session.generation < previous.generation ||
                session.source < previous.source)) return
        val sourceChanged = active?.let { it.source != session.source } == true
        clearTimer()
        active = session
        lastSession = session
        lastSequence = 0L
        clearedThroughSequence = 0L
        lastDispatchNs = Long.MIN_VALUE
        lastYoloState = ClassConfirmation.NONE
        val reason = if (sourceChanged) CenteringReason.SOURCE_CHANGED
            else CenteringReason.WAITING_FOR_BOX
        publish(lifecycleDecision(session, reason))
    }

    /** Invalidate this session before publishing STOP. Late lifecycle events for other sessions are ignored. */
    fun stop(session: CenteringSession, reason: CenteringReason = CenteringReason.CAMERA_STOPPED) {
        if (active != session) return
        active = null
        clearTimer()
        publish(lifecycleDecision(session, reason))
    }

    fun stopActive(reason: CenteringReason): Boolean {
        val session = active ?: return false
        stop(session, reason)
        return true
    }

    /** Report the invalidated box even if its signal was superseded before evaluation. */
    fun clear(session: CenteringSession, previous: TrackingSignal) {
        val observation = previous.observation
        if (active != session || !session.matches(observation.key)) return
        val sequence = observation.key.sequence
        if (sequence < lastSequence || sequence <= clearedThroughSequence) return
        clearedThroughSequence = sequence
        lastYoloState = observation.classification
        clearTimer()
        val now = nowNs()
        val yoloValid = yoloDeadline(session, observation)?.let { now < it } == true
        publish(CenteringDecision(now, session, BoxState.MISSING, observation.classification,
            yoloValid, null, CenteringAction.STOP, CenteringReason.TRACKING_CLEARED, frameId = sequence))
    }

    fun onSignal(signal: TrackingSignal) {
        val session = active ?: return
        val observation = signal.observation
        val sequence = observation.key.sequence
        if (!session.matches(observation.key) || sequence <= clearedThroughSequence ||
            sequence < lastSequence || signal.dispatchNs < lastDispatchNs ||
            (sequence == lastSequence &&
                (signal.kind != TrackingSampleKind.CORRECTION || signal.dispatchNs == lastDispatchNs))) return
        val receivedNs = nowNs()
        if (signal.dispatchNs !in observation.stamp.analyzerEntryNs..receivedNs) return
        expireIfDue(receivedNs)
        clearTimer()
        lastSequence = sequence
        lastDispatchNs = signal.dispatchNs
        lastYoloState = observation.classification
        if (observation.phase == VisualPhase.LOST) clearedThroughSequence = sequence

        val stamp = observation.stamp
        val frameTime = if (stamp.timingIssue(signal.dispatchNs) == null) checkNotNull(stamp.captureNs)
            else stamp.analyzerEntryNs
        val center = if (observation.phase == VisualPhase.TRACKING) signal.center else null
        val offset = center?.let { PixelPoint(it.x - signal.width / 2.0, it.y - signal.height / 2.0) }
        val reading = Reading(session, signal, offset, frameTime + config.coordinatesTtlNs,
            yoloDeadline(session, observation))
        // Publishing the previous expiry can consume the new frame's remaining lifetime.
        val decision = evaluate(reading, nowNs())
        publish(decision)
        if (decision.action != CenteringAction.STOP) armTimer(reading)
    }

    private fun yoloDeadline(session: CenteringSession, observation: TrackingObservation): Long? {
        val hasConfirmation = observation.classification == ClassConfirmation.CONFIRMED ||
            observation.classification == ClassConfirmation.MISSED
        return observation.lastYoloStamp?.takeIf {
            hasConfirmation && it.analyzerEntryNs <= observation.stamp.analyzerEntryNs &&
                observation.lastYoloKey?.let(session::matches) != false
        }?.let { confirmationDeadlineNs(it, config.confirmationTtlNs) }
    }

    private fun evaluate(reading: Reading, now: Long): CenteringDecision {
        val observation = reading.signal.observation
        val yoloDeadline = reading.yoloDeadlineNs
        val freshCoordinates = now < reading.coordinatesDeadlineNs
        val offset = reading.offsetPx.takeIf { freshCoordinates }
        val boxState = when {
            reading.offsetPx == null -> BoxState.MISSING
            freshCoordinates -> BoxState.PRESENT
            else -> BoxState.STALE
        }
        val stopReason = when {
            observation.classification == ClassConfirmation.EXPIRED -> CenteringReason.CONFIRMATION_EXPIRED
            observation.phase == VisualPhase.LOST -> CenteringReason.BOX_LOST
            reading.offsetPx == null -> CenteringReason.WAITING_FOR_BOX
            yoloDeadline != null && yoloDeadline <= reading.coordinatesDeadlineNs && now >= yoloDeadline ->
                CenteringReason.CONFIRMATION_EXPIRED
            !freshCoordinates -> CenteringReason.COORDINATES_EXPIRED
            yoloDeadline == null -> CenteringReason.YOLO_UNCONFIRMED
            else -> null
        }
        val yoloValid = yoloDeadline != null && now < yoloDeadline
        if (stopReason != null) return CenteringDecision(now, reading.session, boxState, observation.classification,
            yoloValid, offset, CenteringAction.STOP, stopReason, frameId = observation.key.sequence)

        checkNotNull(offset)
        val horizontal = when {
            offset.x < -config.deadZoneWidthPx / 2 -> Horizontal.LEFT
            offset.x > config.deadZoneWidthPx / 2 -> Horizontal.RIGHT
            else -> Horizontal.NONE
        }
        val vertical = when {
            offset.y < -config.deadZoneHeightPx / 2 -> Vertical.UP
            offset.y > config.deadZoneHeightPx / 2 -> Vertical.DOWN
            else -> Vertical.NONE
        }
        val moving = horizontal != Horizontal.NONE || vertical != Vertical.NONE
        return CenteringDecision(now, reading.session, boxState, observation.classification, yoloValid, offset,
            if (moving) CenteringAction.MOVE else CenteringAction.HOLD,
            if (moving) CenteringReason.TARGET_OFFSET else CenteringReason.IN_DEAD_ZONE, horizontal, vertical, observation.key.sequence)
    }

    private fun armTimer(reading: Reading) {
        pendingExpiry = reading
        expiryJob = scope.launch {
            while (pendingExpiry === reading) {
                val now = nowNs()
                if (expireIfDue(now)) break
                delay((reading.deadlineNs - now - 1) / NS_PER_MS + 1)
            }
        }
    }

    private fun expireIfDue(now: Long): Boolean {
        val reading = pendingExpiry ?: return false
        if (now < reading.deadlineNs) return false
        clearTimer()
        publish(evaluate(reading, now))
        return true
    }

    private fun clearTimer() {
        pendingExpiry = null
        expiryJob?.cancel()
        expiryJob = null
    }

    private fun lifecycleDecision(session: CenteringSession, reason: CenteringReason) =
        CenteringDecision(nowNs(), session, BoxState.MISSING, lastYoloState, false, null,
            CenteringAction.STOP, reason)
}

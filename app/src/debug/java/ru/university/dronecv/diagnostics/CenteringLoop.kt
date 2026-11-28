package ru.university.dronecv.diagnostics

import kotlin.math.abs
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import ru.university.dronecv.camera.TargetSignal

internal const val CENTERING_DEAD_ZONE_PERCENT = 10

internal enum class CenteringDirection(val code: String) { RIGHT("right"), LEFT("left") }

internal enum class CenteringStop(val code: String) {
    CENTERED("centered"), TARGET_LOST("target_lost"), FRAME_TIMEOUT("frame_timeout"),
    STALE_FRAME("stale_frame"), FRAME_CLOCK("invalid_frame_clock"), STEP_TIMEOUT("step_timeout"),
    STEP_LIMIT("step_limit"), SOURCE_CHANGED("source_changed"), STOPPED("stopped"),
    CAMERA_LEFT("camera_left"), SOURCE_BUSY("source_busy"), FRAME_OVERFLOW("frame_overflow"), ERROR("error"),
}

internal enum class CenteringFrameIssue(val code: String, val stop: CenteringStop? = null) {
    INVALID_CLOCK("invalid_frame_clock", CenteringStop.FRAME_CLOCK),
    EARLY("before_required_capture"), STALE("stale_frame", CenteringStop.STALE_FRAME),
}

internal data class CenteringPolicy(
    val maxFrameAgeMs: Long,
    val frameTimeoutMs: Long,
    val stepLimit: Int,
    val stopOnInvalidFrame: Boolean = false,
)

internal sealed interface CenteringStepResult {
    data class Completed(val elapsedRealtimeNs: Long) : CenteringStepResult
    data class Reconsider(val firstFrameId: Long) : CenteringStepResult
    data class Stopped(val reason: CenteringStop) : CenteringStepResult
}

internal val TargetSignal.horizontalOffsetPercent: Double?
    get() = center?.let { (it.x / width - 0.5) * 100 }

internal fun Double.centeringDirection(): CenteringDirection? = when {
    abs(this) <= CENTERING_DEAD_ZONE_PERCENT -> null
    this > 0 -> CenteringDirection.RIGHT
    else -> CenteringDirection.LEFT
}

internal fun TargetSignal.centeringIssue(afterNs: Long, nowNs: Long, maxFrameAgeMs: Long): CenteringFrameIssue? {
    val age = stamp.ageAt(nowNs)
    return when {
        timingIssue != null || age == null || dispatchNs > nowNs -> CenteringFrameIssue.INVALID_CLOCK
        checkNotNull(stamp.captureNs) <= afterNs -> CenteringFrameIssue.EARLY
        age > maxFrameAgeMs -> CenteringFrameIssue.STALE
        else -> null
    }
}

/** The transport returns a completion timestamp only after the step has finished. */
internal suspend fun runCenteringLoop(
    frames: ReceiveChannel<TargetSignal>,
    startNs: Long,
    policy: CenteringPolicy,
    nowNs: () -> Long,
    onFrame: (TargetSignal, requiredAfterNs: Long, CenteringFrameIssue?) -> Unit,
    move: suspend (step: Int, CenteringDirection, TargetSignal, requiredAfterNs: Long) -> CenteringStepResult,
): CenteringStop {
    var afterNs = startNs
    var completedSteps = 0
    var firstFrameId = 0L
    while (true) {
        val (frame, issue) = withTimeoutOrNull(policy.frameTimeoutMs) {
            var frame: TargetSignal
            var issue: CenteringFrameIssue?
            do {
                do {
                    frame = frames.receive()
                    currentCoroutineContext().ensureActive()
                } while (frame.frameId < firstFrameId)
                issue = frame.centeringIssue(afterNs, nowNs(), policy.maxFrameAgeMs)
                onFrame(frame, afterNs, issue)
            } while (issue != null && (!policy.stopOnInvalidFrame || issue.stop == null))
            frame to issue
        } ?: return CenteringStop.FRAME_TIMEOUT
        issue?.stop?.let { return it }
        val offset = frame.horizontalOffsetPercent ?: return CenteringStop.TARGET_LOST
        val direction = offset.centeringDirection() ?: return CenteringStop.CENTERED
        if (completedSteps >= policy.stepLimit) return CenteringStop.STEP_LIMIT

        when (val result = move(completedSteps + 1, direction, frame, afterNs)) {
            is CenteringStepResult.Stopped -> return result.reason
            is CenteringStepResult.Reconsider -> firstFrameId = result.firstFrameId
            is CenteringStepResult.Completed -> {
                afterNs = result.elapsedRealtimeNs
                completedSteps++
            }
        }
    }
}

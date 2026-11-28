package ru.university.dronecv.diagnostics

import kotlin.math.abs
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.Angles
import ru.university.dronecv.weact.deltaFrom

internal val PHYSICAL_CENTERING_POLICY = CenteringPolicy(
    maxFrameAgeMs = 2_500,
    frameTimeoutMs = 6_000,
    stepLimit = 5,
    stopOnInvalidFrame = true,
)

internal data class PhysicalCenteringUi(
    val running: Boolean = false,
    val stopping: Boolean = false,
    val completedSteps: Int = 0,
    val offsetPercent: Double? = null,
    val captureToSignalMs: Double? = null,
    val frameAgeMs: Double? = null,
    val reason: CenteringStop? = null,
    val detail: String? = null,
    val steps: List<PhysicalStepUi> = emptyList(),
)

internal data class PhysicalStepUi(
    val number: Int,
    val direction: CenteringDirection,
    val command: DjiTurnUi,
    val before: Double?,
    val after: Double?,
    val settled: Double?,
    val recovered: Double?,
    val verified: Boolean,
)

internal data class CenteringRejection(val frame: TargetSignal, val result: CenteringStepResult)

internal fun checkCenteringAdmission(
    selected: TargetSignal,
    latest: TargetSignal,
    lastUnsafe: TargetSignal?,
    direction: CenteringDirection,
    requiredAfterNs: Long,
    nowNs: Long,
): CenteringRejection? {
    fun TargetSignal.issue() = centeringIssue(requiredAfterNs, nowNs, PHYSICAL_CENTERING_POLICY.maxFrameAgeMs)
    fun TargetSignal.stop(reason: CenteringStop) = CenteringRejection(this, CenteringStepResult.Stopped(reason))

    // A later safe observation must not erase a loss or timing failure during yaw readout.
    if (lastUnsafe != null && lastUnsafe.frameId > selected.frameId) {
        val issue = lastUnsafe.issue()
        issue?.stop?.let { return lastUnsafe.stop(it) }
        if (issue == null && lastUnsafe.center == null) return lastUnsafe.stop(CenteringStop.TARGET_LOST)
    }

    val issue = latest.issue()
    issue?.stop?.let { return latest.stop(it) }
    if (issue == CenteringFrameIssue.EARLY) {
        selected.issue()?.stop?.let { return selected.stop(it) }
        return CenteringRejection(latest, CenteringStepResult.Reconsider(selected.frameId + 1))
    }
    val offset = latest.horizontalOffsetPercent ?: return latest.stop(CenteringStop.TARGET_LOST)
    val currentDirection = offset.centeringDirection() ?: return latest.stop(CenteringStop.CENTERED)
    return if (currentDirection == direction) null
    else CenteringRejection(latest, CenteringStepResult.Reconsider(latest.frameId))
}

internal enum class YawIssue(val label: String) {
    TOO_SMALL("Изменение yaw меньше 0,5°"),
    WRONG_DIRECTION("Yaw изменился в обратную сторону"),
    UNSTABLE("Yaw не стабилизировался"),
}

internal fun checkYawMovement(direction: CenteringDirection, before: Angles, after: Angles, settled: Angles): YawIssue? {
    val delta = settled.deltaFrom(before).yawDegrees
    return when {
        abs(settled.deltaFrom(after).yawDegrees) > 0.2 -> YawIssue.UNSTABLE
        abs(delta) < 0.5 -> YawIssue.TOO_SMALL
        (delta > 0) != (direction == CenteringDirection.RIGHT) -> YawIssue.WRONG_DIRECTION
        else -> null
    }
}

package ru.university.dronecv.diagnostics

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.PixelPoint
import ru.university.dronecv.camera.TargetSignal
import ru.university.dronecv.camera.TargetStatus
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.Angles

@OptIn(ExperimentalCoroutinesApi::class)
class PhysicalCenteringTest {
    @Test fun takesOneStepAtATimeAndUsesOnlyExposuresAfterCompletion() = runTest {
        val frames = Channel<TargetSignal>(8)
        val decisions = mutableListOf<Pair<Long, CenteringFrameIssue?>>()
        val requests = mutableListOf<Triple<Int, CenteringDirection, Long>>()
        val replies = Channel<CenteringStepResult>(1)
        val start = 10_000_000_000L
        fun now() = start + testScheduler.currentTime * 1_000_000
        val result = async {
            runCenteringLoop(frames, start, PHYSICAL_CENTERING_POLICY, ::now,
                onFrame = { frame, _, issue -> decisions += frame.frameId to issue }) { step, direction, frame, _ ->
                requests += Triple(step, direction, frame.frameId)
                replies.receive()
            }
        }

        advanceTimeBy(1_600)
        frames.send(frame(1, now() - 1_580_000_000, now(), x = 80))
        runCurrent()
        assertEquals(listOf(Triple(1, CenteringDirection.RIGHT, 1L)), requests)
        advanceTimeBy(1_600)
        val firstCompletion = now()
        frames.send(frame(2, firstCompletion - 1, now(), x = 20))
        runCurrent()
        assertEquals(1, requests.size)

        replies.send(CenteringStepResult.Completed(firstCompletion))
        advanceTimeBy(1_250)
        frames.send(frame(3, firstCompletion, now(), x = 50))
        frames.send(frame(4, firstCompletion + 1, now(), x = 30))
        runCurrent()
        assertEquals(listOf(Triple(1, CenteringDirection.RIGHT, 1L), Triple(2, CenteringDirection.LEFT, 4L)), requests)

        advanceTimeBy(1_600)
        val secondCompletion = now()
        replies.send(CenteringStepResult.Completed(secondCompletion))
        advanceTimeBy(1_240)
        frames.send(frame(5, secondCompletion + 1, now(), x = 60))
        assertEquals(CenteringStop.CENTERED, result.await())
        assertEquals(listOf(1L to null, 2L to CenteringFrameIssue.EARLY, 3L to CenteringFrameIssue.EARLY,
            4L to null, 5L to null), decisions)
        assertEquals(2, requests.size)
    }

    @Test fun stopsOnStaleResultWithoutConsumingAnotherFrame() = runTest {
        val start = 1_000_000_000L
        val now = start + 3_000_000_000
        val frames = Channel<TargetSignal>(2)
        frames.send(frame(1, start + 1, now, x = 80))
        frames.send(frame(2, now - 1, now, x = 80))

        val stop = runCenteringLoop(frames, start, PHYSICAL_CENTERING_POLICY, { now }, { _, _, _ -> }) { _, _, _, _ ->
            error("A stale result must stop the session before requesting movement")
        }
        assertEquals(CenteringStop.STALE_FRAME, stop)
        assertEquals(2L, frames.receive().frameId)
    }

    @Test fun doesNotRetryAfterTimeoutOfATransmittedStep() = runTest {
        val frames = Channel<TargetSignal>(2)
        val transmitted = CompletableDeferred<Unit>()
        val reply = CompletableDeferred<CenteringStepResult>()
        val start = 10_000_000_000L
        val now = start + 1_250_000_000
        var commands = 0
        val result = async {
            runCenteringLoop(frames, start, PHYSICAL_CENTERING_POLICY, { now }, { _, _, _ -> }) { _, _, _, _ ->
                commands++
                transmitted.complete(Unit)
                reply.await()
            }
        }
        frames.send(frame(1, start + 1, now, x = 85))
        transmitted.await()
        frames.send(frame(2, start + 2, now, x = 75))
        reply.complete(CenteringStepResult.Stopped(CenteringStop.STEP_TIMEOUT))
        assertEquals(CenteringStop.STEP_TIMEOUT, result.await())
        assertEquals(1, commands)
        assertEquals(2L, frames.receive().frameId)
    }

    @Test fun stopsAtTheCenterOrLossWithoutOpeningTheTransport() = runTest {
        for ((x, expected) in listOf(40 to CenteringStop.CENTERED, null to CenteringStop.TARGET_LOST)) {
            val frames = Channel<TargetSignal>(1)
            frames.send(frame(1, 2, 3, x))
            assertEquals(expected, runCenteringLoop(frames, 1, PHYSICAL_CENTERING_POLICY, { 3 }, { _, _, _ -> }) { _, _, _, _ ->
                error("Movement must stay idle")
            })
        }
    }

    @Test fun requestsAtMostFiveStepsWhenTheTargetStaysOutsideTheDeadZone() = runTest {
        val frames = Channel<TargetSignal>(6)
        for (id in 1L..6) frames.send(frame(id, id * 10, id * 10 + 1, x = 80))
        val commands = mutableListOf<Int>()
        val stop = runCenteringLoop(frames, 1, PHYSICAL_CENTERING_POLICY, { 100 }, { _, _, _ -> }) { step, _, frame, _ ->
            commands += step
            CenteringStepResult.Completed(frame.dispatchNs + 1)
        }
        assertEquals(CenteringStop.STEP_LIMIT, stop)
        assertEquals(listOf(1, 2, 3, 4, 5), commands)
    }

    @Test fun admissionUsesTheLatestCenterAndDirection() {
        val selected = frame(1, 11, 12, x = 80)
        val latest = frame(2, 13, 14, x = 60)
        fun check(update: TargetSignal) = checkCenteringAdmission(selected, update, null,
            CenteringDirection.RIGHT, requiredAfterNs = 10, nowNs = 15)?.result

        assertEquals(CenteringStepResult.Stopped(CenteringStop.CENTERED), check(latest))
        assertEquals(CenteringStepResult.Reconsider(2), check(frame(2, 13, 14, x = 20)))
        assertNull(check(frame(2, 13, 14, x = 75)))
    }

    @Test fun admissionKeepsTheExposureBoundaryAndFailsOnLossOrStaleness() {
        val cutoff = 1_000_000_000L
        val selected = frame(1, cutoff + 1, cutoff + 2, x = 80)
        val early = frame(2, cutoff, cutoff + 3, x = 50)
        val lost = frame(3, cutoff + 4, cutoff + 5, x = null)
        val recovered = frame(4, cutoff + 6, cutoff + 7, x = 75)
        val direction = CenteringDirection.RIGHT

        assertEquals(CenteringStepResult.Reconsider(2),
            checkCenteringAdmission(selected, early, null, direction, cutoff, cutoff + 8)?.result)
        assertEquals(CenteringStepResult.Stopped(CenteringStop.TARGET_LOST),
            checkCenteringAdmission(selected, recovered, lost, direction, cutoff, cutoff + 8)?.result)
        assertEquals(CenteringStepResult.Stopped(CenteringStop.STALE_FRAME),
            checkCenteringAdmission(selected, recovered, null, direction, cutoff, cutoff + 2_500_000_007)?.result)
    }

    @Test fun reversalReusesTheStepNumberAndExposureBoundary() = runTest {
        val frames = Channel<TargetSignal>(6)
        val sent = mutableListOf<Pair<Int, CenteringDirection>>()
        val admittedFrom = mutableListOf<Long>()
        frames.send(frame(1, 11, 12, x = 80))
        frames.send(frame(2, 13, 14, x = 70))
        val latest = frame(3, 15, 16, x = 20)
        frames.send(latest)
        frames.send(frame(4, 22, 23, x = 50))
        val result = runCenteringLoop(frames, 10, PHYSICAL_CENTERING_POLICY, { 30 },
            onFrame = { frame, _, _ -> admittedFrom += frame.frameId }) { step, direction, selected, afterNs ->
            assertEquals(1, step)
            assertEquals(10L, afterNs)
            checkCenteringAdmission(selected, latest, null, direction, afterNs, nowNs = 30)?.result ?: run {
                sent += step to direction
                CenteringStepResult.Completed(21)
            }
        }
        assertEquals(CenteringStop.CENTERED, result)
        assertEquals(listOf(1L, 3L, 4L), admittedFrom)
        assertEquals(listOf(1 to CenteringDirection.LEFT), sent)
    }

    @Test fun acknowledgesOnlyMeasuredMovementInTheRequestedDirectionWithStableYaw() {
        fun yaw(value: Double) = Angles(value, 0.0, 0.0)
        assertNull(checkYawMovement(CenteringDirection.RIGHT, yaw(179.7), yaw(-177.6), yaw(-177.5)))
        assertNull(checkYawMovement(CenteringDirection.LEFT, yaw(-179.7), yaw(177.6), yaw(177.7)))
        assertEquals(YawIssue.TOO_SMALL, checkYawMovement(CenteringDirection.RIGHT, yaw(12.0), yaw(12.1), yaw(12.1)))
        assertEquals(YawIssue.WRONG_DIRECTION, checkYawMovement(CenteringDirection.RIGHT, yaw(12.0), yaw(9.0), yaw(9.0)))
        assertEquals(YawIssue.UNSTABLE, checkYawMovement(CenteringDirection.RIGHT, yaw(12.0), yaw(14.1), yaw(15.0)))
    }

    @Test fun excludesUnsynchronizedOrFutureResults() {
        val synchronized = frame(1, 100, 200, x = 80)
        val unknown = synchronized.copy(stamp = synchronized.stamp.copy(timebase = CaptureTimebase.UNKNOWN))
        assertEquals(CenteringFrameIssue.INVALID_CLOCK, unknown.centeringIssue(1, 250, 2_500))
        assertEquals(CenteringFrameIssue.INVALID_CLOCK, synchronized.centeringIssue(1, 199, 2_500))
        assertTrue(synchronized.centeringIssue(1, 200, 2_500) == null)
    }

    private fun frame(id: Long, capture: Long, published: Long, x: Int?): TargetSignal = TargetSignal(
        id, 1, FrameStamp(capture, CaptureTimebase.ELAPSED_REALTIME, capture), published, 100, 100,
        if (x == null) TargetStatus.NO_TARGET else TargetStatus.DETECTED,
        x?.let { PixelPoint(it.toDouble(), 50.0) }, x?.let { 0.9f },
    )
}

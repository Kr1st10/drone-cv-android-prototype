package ru.university.dronecv.oneturn

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.*

@OptIn(ExperimentalCoroutinesApi::class)
class OneTurnControllerTest {
    private class Scenario(scope: TestScope, reply: suspend () -> OneTurnReply = { OneTurnReply("success", "Выполнено", 2.0, 5.0) }) {
        var now = 1_000_000_000L
        val requests = mutableListOf<OneTurnRequest>()
        val events = mutableListOf<OneTurnEvent>()
        var ids = 0
        val controller = OneTurnController(scope, { now }, OneTurnTransport { requests += it; reply() }, { "attempt-${++ids}" })
        fun arm() = controller.arm(7, events::add)
        fun signal(id: Long = 1, x: Double? = 80.0, capture: Long = 1_100_000_000L, source: Long = 7) =
            TargetSignal(id, source, FrameStamp(capture, CaptureTimebase.ELAPSED_REALTIME, capture + 10_000_000),
                now, 100, 100, if (x == null) TargetStatus.NO_TARGET else TargetStatus.DETECTED,
                x?.let { PixelPoint(it, 50.0) }, x?.let { .9f })
        fun observe(signal: TargetSignal = signal()) = controller.observe(signal)
    }
    @Test fun rightFrameWithVivoLatencySendsExactlyOneRightRequest() = runTest {
        val s = Scenario(this); assertTrue(s.arm()); s.now = 2_500_000_000
        s.observe(); s.observe(); s.observe(s.signal(2)); assertFalse(s.arm())
        runCurrent()
        assertEquals(1, s.requests.size); assertEquals(30.0, s.requests.single().offsetX, 0.0)
        assertTrue(s.requests.single().json("test").contains("\"direction\":\"right\""))
        assertEquals(OneTurnPhase.IDLE, s.controller.state.value.phase)
        assertEquals(listOf("armed", "selected", "result"), s.events.map { it.kind })
        assertEquals("success", s.events.last().reply?.status)
    }
    @Test fun centerBoundaryLeftAndMissingTargetDoNotSend() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000
        listOf(50.0, 60.0, 20.0, null).forEachIndexed { i, x -> s.observe(s.signal(i + 1L, x)) }
        runCurrent(); assertTrue(s.requests.isEmpty()); assertEquals(OneTurnPhase.ARMED, s.controller.state.value.phase)
        s.controller.invalidate()
    }
    @Test fun exposureBeforeOrAtButtonNeverSendsDespiteLaterPublication() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000
        s.observe(s.signal(capture = 999_000_000)); s.observe(s.signal(2, capture = 1_000_000_000))
        runCurrent(); assertTrue(s.requests.isEmpty()); s.controller.invalidate()
    }
    @Test fun staleExposureIsRejectedAndFreshFollowingFrameMaySend() = runTest {
        val s = Scenario(this); s.arm(); s.now = 3_600_000_001
        s.observe(); runCurrent(); assertTrue(s.requests.isEmpty())
        s.observe(s.signal(2, capture = 3_000_000_000)); runCurrent(); assertEquals(1, s.requests.size)
    }
    @Test fun duplicateFrameIsNotReconsideredAfterNoTarget() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000
        s.observe(s.signal(x = null)); s.observe(); runCurrent(); assertTrue(s.requests.isEmpty()); s.controller.invalidate()
    }
    @Test fun timeoutConsumesPermitAndDoesNotRetry() = runTest {
        val s = Scenario(this) { delay(60_000); OneTurnReply("success", "late") }
        s.arm(); s.now = 2_500_000_000; s.observe(); runCurrent()
        advanceTimeBy(15_001); runCurrent(); s.observe(s.signal(2)); runCurrent()
        assertEquals(1, s.requests.size); assertEquals("timeout", s.events.last().reply?.status)
        assertEquals(OneTurnPhase.IDLE, s.controller.state.value.phase)
    }
    @Test fun queueDelayRechecksAgeBeforeTransport() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000; s.observe()
        s.now = 4_000_000_000; runCurrent(); assertTrue(s.requests.isEmpty())
        assertEquals("rejected", s.events.last().reply?.status)
    }
    @Test fun sourceChangeAndCameraPauseRemoveWaitingPermit() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000
        s.observe(s.signal(source = 8)); runCurrent(); assertTrue(s.requests.isEmpty())
        assertEquals(OneTurnPhase.IDLE, s.controller.state.value.phase)
        s.arm(); s.controller.invalidate(); s.observe(s.signal(2, capture = 2_600_000_000)); runCurrent()
        assertTrue(s.requests.isEmpty())
    }
    @Test fun unknownCameraClockCannotAuthorizeMotion() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000
        s.observe(s.signal().copy(stamp = FrameStamp(null, CaptureTimebase.UNKNOWN, 2_000_000_000)))
        runCurrent(); assertTrue(s.requests.isEmpty()); s.controller.invalidate()
    }
    @Test fun newPressAfterSuccessRequiresANewExposure() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000; s.observe(); runCurrent()
        assertTrue(s.arm()); s.observe(s.signal(2)); runCurrent(); assertEquals(1, s.requests.size)
        s.now = 3_000_000_000; s.observe(s.signal(3, capture = 2_600_000_000)); runCurrent()
        assertEquals(2, s.requests.size); assertNotEquals(s.requests[0].attemptId, s.requests[1].attemptId)
    }
    @Test fun invalidationAfterSelectionBeforeDispatchDoesNotSend() = runTest {
        val s = Scenario(this); s.arm(); s.now = 2_500_000_000; s.observe()
        s.controller.invalidate(); runCurrent()
        assertTrue(s.requests.isEmpty()); assertEquals("cancelled", s.events.last().reply?.status)
    }
    @Test fun errorReturnsToWaitingWithoutRetry() = runTest {
        val s = Scenario(this) { error("connection lost") }; s.arm(); s.now = 2_500_000_000
        s.observe(); runCurrent(); s.observe(s.signal(2)); runCurrent()
        assertEquals(1, s.requests.size); assertEquals("error", s.events.last().reply?.status)
    }
    @Test fun endingDiagnosticRemovesWaitingPermit() = runTest {
        val s = Scenario(this); s.arm(); s.controller.endDiagnostic(); s.now = 2_500_000_000
        s.observe(); runCurrent(); assertTrue(s.requests.isEmpty())
    }
    @Test fun endingDiagnosticRecordsUncertainOutcomeBeforeLateReply() = runTest {
        val s = Scenario(this) { delay(1000); OneTurnReply("success", "Выполнено") }
        s.arm(); s.now = 2_500_000_000; s.observe(); runCurrent(); s.controller.endDiagnostic()
        assertEquals("interrupted", s.events.last().reply?.status)
        advanceTimeBy(1001); runCurrent()
        assertEquals(1, s.events.count { it.kind == "result" }); assertEquals(1, s.requests.size)
        assertEquals(OneTurnPhase.IDLE, s.controller.state.value.phase)
    }
    @Test fun waitingPermitExpiresAndCannotSurviveClose() = runTest {
        val s = Scenario(this); s.arm(); advanceTimeBy(30_001); runCurrent()
        assertEquals(OneTurnPhase.IDLE, s.controller.state.value.phase)
        s.controller.close(); assertFalse(s.arm())
    }
}

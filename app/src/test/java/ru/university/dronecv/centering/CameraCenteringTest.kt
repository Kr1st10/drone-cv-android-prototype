package ru.university.dronecv.centering

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.PixelPoint
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.TrackBox
import ru.university.dronecv.tracking.TrackEstimate
import ru.university.dronecv.tracking.TrackQuality
import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.VisualPhase

@OptIn(ExperimentalCoroutinesApi::class)
class CameraCenteringTest {
    @Test fun directionsUseTheFullUprightCrop() = runTest {
        val run = Scenario(this)
        val cases = listOf(
            Triple(PixelPoint(-21.0, 0.0), Horizontal.LEFT, Vertical.NONE),
            Triple(PixelPoint(21.0, 0.0), Horizontal.RIGHT, Vertical.NONE),
            Triple(PixelPoint(0.0, -21.0), Horizontal.NONE, Vertical.UP),
            Triple(PixelPoint(0.0, 21.0), Horizontal.NONE, Vertical.DOWN),
        )
        for ((index, case) in cases.withIndex()) {
            val (offset, horizontal, vertical) = case
            run.advanceTo(index * 10L)
            run.controller.onSignal(run.signal(index + 1L, offset))
            assertEquals(offset, run.last.offsetPx)
            assertEquals(horizontal, run.last.horizontal)
            assertEquals(vertical, run.last.vertical)
            assertEquals(CenteringAction.MOVE, run.last.action)
        }
    }

    @Test fun exactDeadZoneEdgesHoldAndAxesAreIndependent() = runTest {
        val run = Scenario(this, CenteringConfig(deadZoneWidthPx = 40.0, deadZoneHeightPx = 20.0))
        run.controller.onSignal(run.signal(1, PixelPoint(-20.0, 10.0)))
        assertEquals(CenteringAction.HOLD, run.last.action)
        assertEquals(CenteringReason.IN_DEAD_ZONE, run.last.reason)
        run.advanceTo(10)
        run.controller.onSignal(run.signal(2, PixelPoint(20.0, -10.0)))
        assertEquals(CenteringAction.HOLD, run.last.action)
        run.advanceTo(20)
        run.controller.onSignal(run.signal(3, PixelPoint(20.0, -10.25)))
        assertEquals(Horizontal.NONE, run.last.horizontal)
        assertEquals(Vertical.UP, run.last.vertical)
    }

    @Test fun freshLkMovesAfterAMissedCheckUntilThePreviousConfirmationExpires() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1, PixelPoint(30.0, 0.0)))
        run.advanceTo(200)
        run.controller.onSignal(run.signal(2, PixelPoint(-30.0, 0.0)))
        assertEquals(Horizontal.LEFT, run.last.horizontal)
        run.advanceTo(400)
        run.controller.onSignal(run.signal(3, PixelPoint(0.0, 30.0), yolo = ClassConfirmation.MISSED))
        assertEquals(Vertical.DOWN, run.last.vertical)
        assertEquals(BoxState.PRESENT, run.last.boxState)
        assertEquals(ClassConfirmation.MISSED, run.last.yoloState)
        assertTrue(run.last.confirmationValid)
        run.advanceTo(600)
        run.controller.onSignal(run.signal(4, yolo = ClassConfirmation.MISSED))
        run.advanceTo(800)
        run.controller.onSignal(run.signal(5, yolo = ClassConfirmation.MISSED))
        run.advanceTo(999)
        assertEquals(CenteringAction.MOVE, run.last.action)
        run.advanceTo(1_000)
        run.assertStop(CenteringReason.CONFIRMATION_EXPIRED)
        assertEquals(BoxState.PRESENT, run.last.boxState)
        assertEquals(ClassConfirmation.MISSED, run.last.yoloState)
        assertFalse(run.last.confirmationValid)
        run.controller.onSignal(run.signal(6, yolo = ClassConfirmation.MISSED))
        run.assertStop(CenteringReason.CONFIRMATION_EXPIRED)
    }

    @Test fun newYoloConfirmationCanCorrectTheLatestFrame() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1, PixelPoint(30.0, 0.0)))
        run.advanceTo(100)
        run.controller.onSignal(run.signal(2, PixelPoint(-30.0, 0.0)))
        run.advanceTo(120)
        run.controller.onSignal(
            run.signal(2, PixelPoint(0.0, -30.0), kind = TrackingSampleKind.CORRECTION, frameMs = 100, yoloMs = 100),
        )
        assertEquals(Vertical.UP, run.last.vertical)
        val corrected = run.last
        run.controller.onSignal(run.signal(1, PixelPoint(30.0, 0.0), kind = TrackingSampleKind.CORRECTION))
        assertEquals(corrected, run.last)
        run.advanceTo(349)
        assertEquals(corrected, run.last)
        run.advanceTo(350)
        run.assertStop(CenteringReason.COORDINATES_EXPIRED)
    }

    @Test fun lostBoxStopsImmediatelyEvenWhileYoloConfirmationIsValid() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1))
        run.advanceTo(50)
        run.controller.onSignal(run.signal(2, offset = null))
        run.assertStop(CenteringReason.BOX_LOST)
        assertEquals(BoxState.MISSING, run.last.boxState)
        assertEquals(ClassConfirmation.CONFIRMED, run.last.yoloState)
        assertTrue(run.last.confirmationValid)
        assertNull(run.last.offsetPx)
        val count = run.journal.size
        run.advanceTo(1_100)
        assertEquals(count, run.journal.size)
    }

    @Test fun noMoreFramesStopsThroughTheTimerAtTheCoordinateDeadline() = runTest {
        val run = Scenario(this)
        run.advanceTo(70)
        run.controller.onSignal(run.signal(1, frameMs = 0))
        run.advanceTo(249)
        assertEquals(CenteringAction.MOVE, run.last.action)
        run.advanceTo(250)
        run.assertStop(CenteringReason.COORDINATES_EXPIRED)
        assertEquals(run.startNs + 250_000_000L, run.last.timeNs)
        assertEquals(BoxState.STALE, run.last.boxState)
        assertNull(run.last.offsetPx)
        assertTrue(run.last.confirmationValid)
        val count = run.journal.size
        run.advanceTo(1_100)
        assertEquals(count, run.journal.size)
    }

    @Test fun frameExpiringDuringPreviousStopIsNeverAllowedToMove() = runTest {
        val run = Scenario(this, onDecision = { decision ->
            if (decision.reason == CenteringReason.COORDINATES_EXPIRED && testScheduler.currentTime == 282L) {
                testScheduler.advanceTimeBy(2)
            }
        })
        run.advanceTo(32)
        run.controller.onSignal(run.signal(1, yoloMs = 32))
        // Stop at the old frame's deadline before dispatching its scheduled expiry.
        testScheduler.advanceTimeBy(250)
        run.controller.onSignal(run.signal(2, frameMs = 33, yoloMs = 32))

        assertEquals(
            listOf(
                Triple(0L, CenteringAction.STOP, CenteringReason.WAITING_FOR_BOX),
                Triple(32L, CenteringAction.MOVE, CenteringReason.TARGET_OFFSET),
                Triple(282L, CenteringAction.STOP, CenteringReason.COORDINATES_EXPIRED),
                Triple(284L, CenteringAction.STOP, CenteringReason.COORDINATES_EXPIRED),
            ),
            run.journal.map { Triple((it.timeNs - run.startNs) / 1_000_000L, it.action, it.reason) },
        )
        run.assertStop(CenteringReason.COORDINATES_EXPIRED)
        assertEquals(BoxState.STALE, run.last.boxState)
        assertNull(run.last.offsetPx)
        assertTrue(run.last.confirmationValid)
        run.advanceTo(1_100)
        assertEquals(4, run.journal.size)
    }

    @Test fun staleCaptureDoesNotBecomeFreshWhenDeliveredLate() = runTest {
        val run = Scenario(this)
        run.advanceTo(280)
        val late = run.signal(1, frameMs = 270)
        run.controller.onSignal(late.copy(observation = late.observation.copy(
            stamp = late.observation.stamp.copy(captureNs = run.startNs),
        )))
        run.assertStop(CenteringReason.COORDINATES_EXPIRED)
    }

    @Test fun unknownCaptureClockUsesAnalyzerTimeForExpiry() = runTest {
        val run = Scenario(this)
        val signal = run.signal(1)
        val unrelated = FrameStamp(7, CaptureTimebase.UNKNOWN, run.startNs)
        run.controller.onSignal(signal.copy(observation = signal.observation.copy(
            stamp = unrelated, lastYoloStamp = unrelated,
        )))
        assertEquals(CenteringAction.MOVE, run.last.action)
        run.advanceTo(250)
        run.assertStop(CenteringReason.COORDINATES_EXPIRED)
    }

    @Test fun visibleBoxWithoutConfirmationDoesNotMove() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1, yolo = ClassConfirmation.NONE))
        run.assertStop(CenteringReason.YOLO_UNCONFIRMED)
        assertEquals(BoxState.PRESENT, run.last.boxState)
        assertFalse(run.last.confirmationValid)
    }

    @Test fun stopRejectsDelayedCorrectionAndCannotReopenOldSession() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1))
        run.advanceTo(25)
        run.controller.stop(run.session)
        run.assertStop(CenteringReason.CAMERA_STOPPED)
        val count = run.journal.size
        run.controller.start(run.session)
        run.controller.onSignal(run.signal(1, kind = TrackingSampleKind.CORRECTION))
        run.advanceTo(1_100)
        assertEquals(count, run.journal.size)
        val restarted = run.session.copy(generation = run.session.generation + 1)
        run.controller.start(restarted)
        run.controller.onSignal(run.signal(2, kind = TrackingSampleKind.CORRECTION, yoloMs = 1_100))
        run.assertStop(CenteringReason.WAITING_FOR_BOX)
        run.controller.onSignal(run.signal(1, session = restarted, yoloMs = 1_100))
        assertEquals(CenteringAction.MOVE, run.last.action)
    }

    @Test fun sourceChangeCancelsItsTimerAndRejectsLateResultWithoutAffectingNewSource() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1))
        run.advanceTo(40)
        val replacement = run.session.copy(source = run.session.source + 1)
        run.controller.start(replacement)
        run.assertStop(CenteringReason.SOURCE_CHANGED)
        val count = run.journal.size
        val late = run.signal(2, kind = TrackingSampleKind.CORRECTION)
        run.controller.onSignal(late)
        run.controller.stop(run.session)
        assertEquals(count, run.journal.size)
        run.controller.onSignal(run.signal(1, session = replacement, yoloMs = 40))
        assertEquals(CenteringAction.MOVE, run.last.action)
        val current = run.last
        run.advanceTo(250)
        assertEquals(current, run.last)
        run.controller.onSignal(late)
        assertEquals(current, run.last)
        run.advanceTo(290)
        run.assertStop(CenteringReason.COORDINATES_EXPIRED)
        assertEquals(replacement, run.last.session)
    }

    @Test fun dryRunShiftCenterLoss() = runTest {
        val run = Scenario(this)
        run.controller.onSignal(run.signal(1, PixelPoint(96.0, -56.0), kind = TrackingSampleKind.CORRECTION))
        run.advanceTo(100)
        run.controller.onSignal(run.signal(2, PixelPoint(0.0, 0.0)))
        run.advanceTo(180)
        run.controller.onSignal(run.signal(3, offset = null))

        assertEquals(
            listOf(CenteringAction.STOP, CenteringAction.MOVE, CenteringAction.HOLD, CenteringAction.STOP),
            run.journal.map { it.action },
        )
        assertEquals(Horizontal.RIGHT, run.journal[1].horizontal)
        assertEquals(Vertical.UP, run.journal[1].vertical)
        run.assertStop(CenteringReason.BOX_LOST)
        run.journal.forEach { println(it.toDryRunJson(run.startNs)) }
    }

    private class Scenario(
        scope: TestScope,
        config: CenteringConfig = CenteringConfig(40.0),
        onDecision: (CenteringDecision) -> Unit = {},
    ) {
        private val scheduler = scope.testScheduler
        val startNs = 1_000_000_000L
        val session = CenteringSession(generation = 1, source = 2)
        val journal = mutableListOf<CenteringDecision>()
        val last get() = journal.last()
        val controller = CameraCentering(config, scope.backgroundScope, { ns(scheduler.currentTime) }) {
            journal.add(it)
            onDecision(it)
        }.also { it.start(session) }

        fun advanceTo(ms: Long) {
            scheduler.advanceTimeBy(ms - scheduler.currentTime)
            scheduler.runCurrent()
        }

        fun assertStop(reason: CenteringReason) {
            assertEquals(CenteringAction.STOP, last.action)
            assertEquals(reason, last.reason)
            assertEquals(Horizontal.NONE, last.horizontal)
            assertEquals(Vertical.NONE, last.vertical)
        }

        fun signal(
            sequence: Long,
            offset: PixelPoint? = PixelPoint(30.0, 0.0),
            session: CenteringSession = this.session,
            kind: TrackingSampleKind = TrackingSampleKind.FRAME,
            yolo: ClassConfirmation = ClassConfirmation.CONFIRMED,
            yoloMs: Long = 0L,
            frameMs: Long = scheduler.currentTime,
        ): TrackingSignal {
            val estimate = offset?.let {
                val x = (320.0 + it.x) / 2
                val y = (240.0 + it.y) / 2
                TrackEstimate(TrackBox(x - 10, y - 10, x + 10, y + 10), TrackQuality(8, 8, 0.0, 1.0))
            }
            val observation = TrackingObservation(
                key = FrameKey(session.generation, session.source, sequence),
                stamp = stamp(frameMs),
                phase = if (estimate == null) VisualPhase.LOST else VisualPhase.TRACKING,
                trackId = estimate?.let { 1L },
                estimate = estimate,
                classification = yolo,
                lastYoloConfidence = if (yolo == ClassConfirmation.NONE) null else 0.9f,
                lastYoloStamp = if (yolo == ClassConfirmation.NONE) null else stamp(yoloMs),
                reason = if (estimate == null) "visual_quality" else null,
                lastYoloKey = if (yolo == ClassConfirmation.NONE) null
                    else FrameKey(session.generation, session.source, if (yoloMs == frameMs) sequence else 1L),
            )
            return TrackingSignal(observation, kind, 640, 480, ns(scheduler.currentTime), 0.0, 320, 240)
        }

        private fun ns(ms: Long) = startNs + ms * 1_000_000L
        private fun stamp(ms: Long) = FrameStamp(ns(ms), CaptureTimebase.ELAPSED_REALTIME, ns(ms))
    }
}

package ru.university.dronecv.diagnostics

import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.centering.CenteringReason
import ru.university.dronecv.centering.CenteringSession
import ru.university.dronecv.timeline.TimelineWriter
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.TrackBox
import ru.university.dronecv.tracking.TrackEstimate
import ru.university.dronecv.tracking.TrackQuality
import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.VisualPhase

@OptIn(ExperimentalCoroutinesApi::class)
class DryRunJournalTest {
    @get:Rule val files = TemporaryFolder()

    @Test fun clearStopsAndTheSameSessionReacquiresOnAFreshFrame() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        dryRun.signal(run.signal(1))
        run.advanceTo(100)
        dryRun.signal(run.signal(2, x = 320.0))
        run.advanceTo(180)
        dryRun.clear(run.session)
        testScheduler.runCurrent()
        run.advanceTo(190)
        dryRun.signal(run.signal(2, kind = TrackingSampleKind.CORRECTION))
        run.advanceTo(200)
        dryRun.signal(run.signal(3))
        run.advanceTo(220)
        dryRun.signal(run.signal(4, phase = VisualPhase.LOST))
        run.advanceTo(230)
        dryRun.signal(run.signal(4, kind = TrackingSampleKind.CORRECTION))
        run.advanceTo(240)
        dryRun.signal(run.signal(5))
        testScheduler.runCurrent()
        val rows = run.finish()
        val events = rows.dryRun()

        assertEquals(
            listOf("STOP/WAITING_FOR_BOX", "MOVE/TARGET_OFFSET", "HOLD/IN_DEAD_ZONE",
                "STOP/TRACKING_CLEARED", "MOVE/TARGET_OFFSET", "STOP/BOX_LOST",
                "MOVE/TARGET_OFFSET", "STOP/RECORDING_STOPPED"),
            events.map(::decision),
        )
        assertTrue(events.all { it.contains("\"generation\":\"1\",\"source_id\":\"2\"") })
        assertTrue(events[1].contains("\"frame_id\":\"1\",\"dx_px\":96.0,\"dy_px\":-56.0"))
        assertTrue(events[2].contains("\"frame_id\":\"2\",\"dx_px\":0.0,\"dy_px\":0.0"))
        assertTrue(events[3].contains("\"box_state\":\"MISSING\",\"yolo_state\":\"CONFIRMED\""))
        assertTrue(events[4].contains("\"frame_id\":\"3\""))
        assertTrue(events[5].contains("\"frame_id\":\"4\",\"dx_px\":null,\"dy_px\":null,\"box_state\":\"MISSING\""))
        assertTrue(events[6].contains("\"frame_id\":\"5\""))
        assertTrue(rows.takeLast(2).first().contains("\"type\":\"diagnostic_report\""))
        assertTrue(rows.last().contains("\"type\":\"session_end\""))
        rows.forEach(::println)
    }

    @Test fun silentStreamWritesTimerStopWithoutAnotherSignal() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        dryRun.signal(run.signal(1))
        testScheduler.runCurrent()
        run.advanceTo(250)
        val events = run.finish().dryRun()

        assertEquals(listOf("STOP/WAITING_FOR_BOX", "MOVE/TARGET_OFFSET",
            "STOP/COORDINATES_EXPIRED", "STOP/RECORDING_STOPPED"), events.map(::decision))
        assertTrue(events[2].contains("\"event_ns\":\"1250000000\""))
        assertTrue(events[2].contains("\"decision_ns\":\"1250000000\""))
        assertTrue(events[2].contains("\"frame_id\":\"1\",\"dx_px\":null,\"dy_px\":null,\"box_state\":\"STALE\""))
    }

    @Test fun stopAndSourceChangeRejectOldResultsAlreadyQueuedAndArrivingLate() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        val replacement = CenteringSession(generation = 2, source = 3)
        dryRun.start(run.session)
        dryRun.signal(run.signal(1))
        run.advanceTo(40)
        dryRun.signal(run.signal(2))
        dryRun.stop(run.session, CenteringReason.SOURCE_CHANGED)
        dryRun.start(replacement)
        dryRun.signal(run.signal(3))
        dryRun.signal(run.signal(1, session = replacement))
        run.advanceTo(80)
        dryRun.stop(replacement, CenteringReason.CAMERA_STOPPED)
        dryRun.signal(run.signal(2, session = replacement))
        run.advanceTo(400)
        val events = run.finish().dryRun()

        assertEquals(listOf("STOP/WAITING_FOR_BOX", "MOVE/TARGET_OFFSET", "STOP/SOURCE_CHANGED",
            "STOP/WAITING_FOR_BOX", "MOVE/TARGET_OFFSET", "STOP/CAMERA_STOPPED"), events.map(::decision))
        assertTrue(events[2].contains("\"generation\":\"1\",\"source_id\":\"2\",\"frame_id\":null"))
        assertTrue(events[4].contains("\"generation\":\"2\",\"source_id\":\"3\",\"frame_id\":\"1\""))
    }

    @Test fun disabledRecordingKeepsTheLegacyTimelineWithoutStartingTheDecisionClock() = runTest {
        val run = Recording(this, files.newFile(), enabled = false)
        assertNull(run.dryRun)
        run.advanceTo(800)
        assertEquals(emptyList<String>(), run.finish().dryRun())
        assertEquals(0, run.decisionClockReads)
    }

    @Test fun saturatedInputStopsDryRunAndStillFinalizesTheDiagnosticFile() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        dryRun.signal(run.signal(1))
        testScheduler.runCurrent()
        repeat(70) { dryRun.signal(run.signal(it + 2L)) }
        testScheduler.runCurrent()
        val rows = run.finish()

        assertEquals(listOf("STOP/WAITING_FOR_BOX", "MOVE/TARGET_OFFSET", "STOP/INPUT_OVERFLOW"),
            rows.dryRun().map(::decision))
        assertTrue(rows.last().contains("\"type\":\"session_end\""))
    }

    @Test fun queuedBoxCannotMoveAfterTrackingIsCleared() = runTest {
        queuedBoxCannotMoveAfterLoss(this, lostSignal = false)
    }

    @Test fun queuedBoxCannotHoldAfterLostSignal() = runTest {
        queuedBoxCannotMoveAfterLoss(this, lostSignal = true)
    }

    private fun queuedBoxCannotMoveAfterLoss(scope: TestScope, lostSignal: Boolean) {
        val run = Recording(scope, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        scope.testScheduler.runCurrent()

        run.clockMs = 30
        dryRun.signal(run.signal(1, x = if (lostSignal) 320.0 else 416.0))
        run.clockMs = 40
        val clearedFrame = if (lostSignal) 2L else 1L
        if (lostSignal) dryRun.signal(run.signal(clearedFrame, phase = VisualPhase.LOST))
        else dryRun.clear(run.session)
        run.clockMs = 50
        scope.testScheduler.runCurrent()

        run.clockMs = 55
        dryRun.signal(run.signal(clearedFrame, kind = TrackingSampleKind.CORRECTION))
        run.clockMs = 60
        dryRun.signal(run.signal(clearedFrame + 1))
        scope.testScheduler.runCurrent()
        val events = run.finish().dryRun()

        assertEquals(
            listOf("STOP/WAITING_FOR_BOX", if (lostSignal) "STOP/BOX_LOST" else "STOP/TRACKING_CLEARED",
                "MOVE/TARGET_OFFSET", "STOP/RECORDING_STOPPED"),
            events.map(::decision),
        )
        assertTrue(events[2].contains("\"frame_id\":\"${clearedFrame + 1}\""))
    }

    @Test fun lossWhileEvaluatingAFramePreventsItsPublication() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        testScheduler.runCurrent()
        run.clockMs = 30
        dryRun.signal(run.signal(1))
        run.clockMs = 40
        run.onNextDecisionClockRead = { dryRun.clear(run.session) }
        testScheduler.runCurrent()
        run.clockMs = 60
        dryRun.signal(run.signal(2))
        testScheduler.runCurrent()

        assertEquals(listOf("STOP/WAITING_FOR_BOX", "STOP/TRACKING_CLEARED",
            "MOVE/TARGET_OFFSET", "STOP/RECORDING_STOPPED"), run.finish().dryRun().map(::decision))
    }

    @Test fun delayedFinalizationKeepsTheStopBoundaryAndLastBoxDuration() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        testScheduler.runCurrent()
        run.clockMs = 80
        run.publishBox()
        dryRun.signal(run.signal(1))
        testScheduler.runCurrent()

        run.clockMs = 100
        val rows = run.finish(drainAtMs = 600)
        val stopNs = rows.last().substringAfter("\"stop_ns\":\"").substringBefore('"').toLong()
        val boxPublishedNs = rows.single { it.contains("\"type\":\"state\"") }
            .substringAfter("\"publication_ns\":\"").substringBefore('"').toLong()
        assertEquals("footer time", 1_100_000_000L, stopNs)
        assertEquals("last box duration", 20_000_000L, stopNs - boxPublishedNs)
        val events = rows.dryRun()
        assertEquals(listOf("STOP/WAITING_FOR_BOX", "MOVE/TARGET_OFFSET", "STOP/RECORDING_STOPPED"),
            events.map(::decision))
        assertTrue(events.all { it.substringAfter("\"decision_ns\":\"").substringBefore('"').toLong() <= stopNs })
        assertTrue(events.last().contains("\"decision_ns\":\"$stopNs\""))
        rows.forEach(::println)
    }

    @Test fun saturatedInputBeforeStartWritesOverflowBeforeFinishingTheFile() = runTest {
        val run = Recording(this, files.newFile())
        val dryRun = checkNotNull(run.dryRun)
        dryRun.start(run.session)
        run.clockMs = 30
        repeat(70) { dryRun.signal(run.signal(it + 1L)) }
        run.clockMs = 100
        val rows = run.finish(drainAtMs = 600)

        assertEquals(listOf("STOP/INPUT_OVERFLOW"), rows.dryRun().map(::decision))
        assertTrue(rows.takeLast(2).first().contains("\"type\":\"diagnostic_report\""))
        assertTrue(rows.last().contains("\"recording_complete\":true"))
        rows.forEach(::println)
    }

    private fun List<String>.dryRun() = filter { it.contains("\"type\":\"dry_run\"") }

    private fun decision(row: String): String {
        val action = row.substringAfter("\"action\":\"").substringBefore('"')
        val reason = row.substringAfter("\"reason\":\"").substringBefore('"')
        return "$action/$reason"
    }

    private class Recording(scope: TestScope, val file: File, enabled: Boolean = true) {
        private val scheduler = scope.testScheduler
        var clockMs: Long? = null
        var onNextDecisionClockRead: (() -> Unit)? = null
        private val now get() = 1_000_000_000L + (clockMs ?: scheduler.currentTime) * 1_000_000L
        val session = CenteringSession(generation = 1, source = 2)
        var decisionClockReads = 0
            private set
        private val writer = TimelineWriter(file, { now })
        val dryRun: DryRunJournal?

        init {
            writer.record("header", """{"start_ns":"$now","clock":"elapsed_realtime_ns","diagnostic_report_required":true}""", now)
            dryRun = DryRunJournal.open(enabled, writer, clock = {
                decisionClockReads++
                val beforeRead = onNextDecisionClockRead
                onNextDecisionClockRead = null
                beforeRead?.invoke()
                now
            }, dispatcher = StandardTestDispatcher(scheduler))
        }

        fun advanceTo(ms: Long) {
            scheduler.advanceTimeBy(ms - scheduler.currentTime)
            scheduler.runCurrent()
        }

        fun publishBox() {
            writer.record("state", """{"publication_ns":"$now","reason":"update","box":[0.1,0.1,0.2,0.2]}""", now)
        }

        fun finish(drainAtMs: Long? = null): List<String> {
            val finalize = { stopNs: Long -> writer.finish(stopNs, false, null, "diagnostic_report" to { "{}" }) }
            if (dryRun == null) finalize(now) else dryRun.finish(finalize)
            if (drainAtMs != null) clockMs = drainAtMs
            scheduler.runCurrent()
            writer.awaitFinished()
            assertNull(writer.integrityIssue())
            return file.readLines()
        }

        fun signal(
            sequence: Long,
            x: Double = 416.0,
            session: CenteringSession = this.session,
            kind: TrackingSampleKind = TrackingSampleKind.FRAME,
            phase: VisualPhase = VisualPhase.TRACKING,
        ): TrackingSignal {
            val y = if (x == 320.0) 240.0 else 184.0
            val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
            val yolo = FrameStamp(1_000_000_000L, CaptureTimebase.ELAPSED_REALTIME, 1_000_000_000L)
            val estimate = if (phase == VisualPhase.TRACKING) {
                TrackEstimate(TrackBox(x - 10, y - 10, x + 10, y + 10), TrackQuality(8, 8, 0.0, 1.0))
            } else null
            val observation = TrackingObservation(
                FrameKey(session.generation, session.source, sequence), stamp, phase,
                trackId = estimate?.let { 1L }, estimate = estimate,
                classification = ClassConfirmation.CONFIRMED, lastYoloConfidence = 0.9f,
                lastYoloStamp = yolo, reason = null,
                lastYoloKey = FrameKey(session.generation, session.source, 1),
            )
            return TrackingSignal(observation, kind, 640, 480, now, 0.0)
        }
    }
}

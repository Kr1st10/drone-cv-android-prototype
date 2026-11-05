package ru.university.dronecv.camera

import java.util.concurrent.Executor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.diagnostics.DiagnosticFrames

class TargetSignalTest {
    private fun drone(x: Double, y: Double = 200.0, confidence: Float = .8f) = Detection("drone", confidence,
        NormalizedBox(((x - 12) / 640).toFloat(), ((y - 12) / 480).toFloat(), ((x + 12) / 640).toFloat(), ((y + 12) / 480).toFloat()))
    private fun stamp(ns: Long, entry: Long = ns + 10_000_000L, source: CaptureTimebase = CaptureTimebase.ELAPSED_REALTIME) =
        FrameStamp(ns, source, entry)

    @Test fun latencyUsesExposureNotAnalyzerEntryAndRejectsIncompatibleClocks() {
        val s = stamp(1_000_000_000)
        assertEquals(150.0, s.ageAt(1_150_000_000)!!, 0.0)
        assertNull(s.copy(timebase = CaptureTimebase.UNKNOWN).ageAt(1_150_000_000))
        assertNull(s.copy(captureNs = null).ageAt(1_150_000_000))
        assertNull(s.copy(captureNs = 2_000_000_000).ageAt(1_150_000_000))
        assertNull(s.ageAt(1_005_000_000))
    }

    @Test fun regressionPredictsFromExposureThroughMeasuredLatencyToFutureSignalTime() {
        val tracker = TargetTracker()
        var observed = tracker.observe(listOf(drone(100.0)), 640, 480, 1_000_000_000)
        val id = observed.id
        assertNull(observed.velocity)
        observed = tracker.observe(listOf(drone(110.0)), 640, 480, 1_100_000_000)
        assertEquals(id, observed.id)
        observed = tracker.observe(listOf(drone(120.0)), 640, 480, 1_200_000_000)
        assertEquals(id, observed.id)
        assertEquals(100.0, observed.velocity!!.xPerSecond, .001)
        val signal = targetSignal(3, 7, stamp(1_200_000_000), 1_350_000_000, 640, 480, observed)
        assertEquals(150.0, signal.captureToSignalMs!!, 0.0)
        assertEquals(135.0, signal.forecast.first().point.x, .001)
        assertEquals(155.0, signal.forecast.last().point.x, .001)
        assertEquals(listOf(0, 100, 200), signal.forecast.map { it.afterSignalMs })
        assertNull(signal.predictionIssue)
        val next = tracker.observe(listOf(drone(130.0)), 640, 480, 1_300_000_000)
        assertEquals(0.0, next.predictionErrorPx!!, .001)
    }

    @Test fun unrelatedAndAmbiguousDetectionsDoNotKeepTheOldIdentity() {
        val tracker = TargetTracker()
        val first = tracker.observe(listOf(drone(100.0)), 640, 480, 1_000_000_000)
        val lost = tracker.observe(listOf(drone(400.0)), 640, 480, 1_100_000_000)
        assertEquals(TargetStatus.LOST, lost.status); assertEquals(first.id, lost.id); assertNull(lost.point)
        val acquired = tracker.observe(listOf(drone(400.0)), 640, 480, 1_200_000_000)
        assertNotEquals(first.id, acquired.id)
        val ambiguous = tracker.observe(listOf(drone(398.0), drone(402.0)), 640, 480, 1_300_000_000)
        assertEquals(TargetStatus.LOST, ambiguous.status)
    }

    @Test fun missingRepeatedOrDiscontinuousCaptureAndResizeResetVelocity() {
        for (ns in listOf<Long?>(null, 1_200_000_000, 900_000_000, 5_000_000_000)) {
            val t = TargetTracker()
            t.observe(listOf(drone(100.0)), 640, 480, 1_000_000_000)
            t.observe(listOf(drone(110.0)), 640, 480, 1_100_000_000)
            val old = t.observe(listOf(drone(120.0)), 640, 480, 1_200_000_000)
            val fresh = t.observe(listOf(drone(120.0)), 640, 480, ns)
            assertNotEquals(old.id, fresh.id); assertNull(fresh.velocity)
        }
        val t = TargetTracker()
        val old = t.observe(listOf(drone(100.0)), 640, 480, 1_000_000_000)
        assertNotEquals(old.id, t.observe(listOf(drone(100.0)), 480, 640, 1_100_000_000).id)
    }

    @Test fun noUnboundedForecastForOldFramesUnknownClockOrOutsideImage() {
        val t = TargetTracker()
        t.observe(listOf(drone(580.0)), 640, 480, 1_000_000_000)
        t.observe(listOf(drone(600.0)), 640, 480, 1_100_000_000)
        val o = t.observe(listOf(drone(620.0)), 640, 480, 1_200_000_000)
        fun signal(stamp: FrameStamp, now: Long) = targetSignal(3, 1, stamp, now, 640, 480, o)
        assertEquals("prediction_outside_frame", signal(stamp(1_200_000_000), 1_250_000_000).predictionIssue)
        assertEquals("prediction_horizon_exceeded", signal(stamp(1_200_000_000), 2_100_000_000).predictionIssue)
        val unknown = signal(stamp(1_200_000_000, source = CaptureTimebase.UNKNOWN), 1_250_000_000)
        assertNull(unknown.captureToSignalMs); assertTrue(unknown.forecast.isEmpty())
        val lost = t.observe(emptyList(), 640, 480, 1_300_000_000)
        assertNull(lost.point); assertNull(lost.velocity)
    }

    private class Frame : AutoCloseable { var closed = false; override fun close() { closed = true } }
    private class Backend : LiveBackend<Frame> {
        var calls = 0; var action: () -> Unit = {}
        override fun infer(frame: Frame, confidence: Float): LiveInference {
            calls++; action()
            return LiveInference(listOf(droneStatic()), 640, 480, 3.0, 1.0, 2.0, 4.0)
        }
        override fun close() = Unit
        private fun droneStatic() = Detection("drone", .9f, NormalizedBox(.4f, .4f, .5f, .5f))
    }

    @Test fun signalIsRecordedClearedAndSupersededCompletionCannotPublish() {
        val backend = Backend(); val frames = DiagnosticFrames(); val token = frames.start(0)
        val c = LiveController(backend, Executor { it.run() }, frames, eventTime = { 1_150_000_000 })
        val source = c.newSource(); c.configure(true, .5f)
        val f = Frame(); c.analyze(f, source, stamp(1_000_000_000))
        assertTrue(f.closed); val signal = c.signals.value!!
        assertEquals(signal, c.state.value.target); assertEquals(150.0, signal.captureToSignalMs!!, 0.0)
        assertEquals(signal, frames.stop(token, Long.MAX_VALUE, false, null)!!.frames.single().targetSignal)
        c.configure(false, .5f); assertNull(c.signals.value)
        c.configure(true, .5f); backend.action = { c.configure(false, .5f) }
        c.analyze(Frame(), source, stamp(1_000_000_000))
        assertNull(c.signals.value); assertNull(c.state.value.target)
        c.close()
    }

    @Test fun staleFrameIsClosedBeforeBackendAndCountedSeparatelyFromCameraDrops() {
        val b = Backend(); val frames = DiagnosticFrames(); val token = frames.start(0)
        val c = LiveController(b, Executor { it.run() }, frames, eventTime = { 1_500_000_000 })
        c.configure(true, .5f)
        val stale = Frame(); c.analyze(stale, stamp = stamp(1_000_000_000, 1_300_000_000))
        assertTrue(stale.closed); assertEquals(0, b.calls); assertNull(c.signals.value)
        val unknown = Frame(); c.analyze(unknown, stamp = stamp(1_000_000_000, 1_300_000_000, CaptureTimebase.UNKNOWN))
        assertTrue(unknown.closed); assertEquals(1, b.calls); assertNull(c.signals.value!!.captureToSignalMs)
        val snapshot = frames.stop(token, Long.MAX_VALUE, false, null)!!
        assertEquals(1L, snapshot.staleFramesDiscarded); assertEquals(1L, snapshot.analyzerCallbacks)
        c.close()
    }

    @Test fun missingEventClockCannotSilentlyMixNanoTimeAndRealtime() {
        val b = Backend(); val c = LiveController(b, Executor { it.run() })
        c.configure(true, .5f); val f = Frame(); c.analyze(f, stamp = stamp(1_000_000_000))
        assertTrue(f.closed); assertEquals(1, b.calls); assertNull(c.signals.value)
        c.close()
    }

    @Test fun oldSourceFailureAndExpiryCannotLeaveAnActionableTarget() {
        val b = Backend(); val c = LiveController(b, Executor { it.run() }, eventTime = { 1_150_000_000 })
        val oldSource = c.newSource(); c.configure(true, .5f)
        c.analyze(Frame(), oldSource, stamp(1_000_000_000)); val oldId = c.signals.value!!.targetId
        val source = c.newSource(); c.configure(true, .5f)
        val oldFrame = Frame(); c.analyze(oldFrame, oldSource, stamp(1_000_000_000))
        assertTrue(oldFrame.closed); assertNull(c.signals.value); assertEquals(1, b.calls)
        c.analyze(Frame(), source, stamp(1_000_000_000)); assertNotEquals(oldId, c.signals.value!!.targetId)
        c.expire(c.state.value.revision); assertNull(c.signals.value); assertNull(c.state.value.target)
        b.action = { throw IllegalStateException("test failure") }
        val failure = Frame(); c.analyze(failure, source, stamp(1_000_000_000))
        assertTrue(failure.closed); assertEquals(LivePhase.ERROR, c.state.value.phase); assertNull(c.signals.value)
        c.close()
    }

    @Test fun synchronousSignalSubscriberCannotResurrectStoppedClosedOrReconfiguredState() = runBlocking {
        for (action in 0..2) {
            val c = LiveController(Backend(), Executor { it.run() }, eventTime = { 1_150_000_000 })
            val observer = launch(Dispatchers.Unconfined) {
                c.signals.collect { signal -> if (signal != null) when (action) {
                    0 -> c.configure(false, .5f)
                    1 -> c.close()
                    else -> c.updateThreshold(.6f)
                } }
            }
            c.configure(true, .5f); c.analyze(Frame(), stamp = stamp(1_000_000_000))
            assertNull(c.signals.value); assertNull(c.state.value.target); assertNull(c.state.value.result)
            assertEquals(if (action == 2) LivePhase.STARTING else LivePhase.STOPPED, c.state.value.phase)
            observer.cancelAndJoin(); c.close()
        }
    }

    @Test fun subscriberRestartOnInvalidationWinsOverOldStopErrorAndExpiry() = runBlocking {
        for (action in 0..2) {
            val backend = Backend()
            val c = LiveController(backend, Executor { it.run() }, eventTime = { 1_150_000_000 })
            c.configure(true, .5f); c.analyze(Frame(), stamp = stamp(1_000_000_000))
            val observer = launch(Dispatchers.Unconfined) {
                c.signals.collect { if (it == null) c.configure(true, .6f) }
            }
            when (action) {
                0 -> c.configure(false, .5f)
                1 -> { backend.action = { error("test failure") }; c.analyze(Frame(), stamp = stamp(1_000_000_000)) }
                else -> c.expire(c.state.value.revision)
            }
            assertEquals(LivePhase.STARTING, c.state.value.phase)
            assertNull(c.state.value.target); assertNull(c.signals.value)
            observer.cancelAndJoin(); c.close()
        }
    }
}

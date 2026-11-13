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

    @Test fun eachFrameSelectsHighestConfidenceWithoutUsingPreviousLocation() {
        val first = selectTarget(listOf(drone(100.0, confidence = .9f), drone(500.0, confidence = .8f)), 640, 480)!!
        val next = selectTarget(listOf(drone(101.0, confidence = .6f), drone(500.0, confidence = .95f)), 640, 480)!!
        assertEquals(100.0, first.center.x, .001)
        assertEquals(500.0, next.center.x, .001)
        assertEquals(.95f, next.confidence)
        assertNull(selectTarget(emptyList(), 640, 480))
        val tie = selectTarget(listOf(drone(500.0), drone(100.0)), 640, 480)!!
        assertEquals(500.0, tie.center.x, .001)
    }

    @Test fun uprightDimensionsBoundsAndUnknownClockPreserveCurrentCoordinates() {
        val selected = selectTarget(listOf(Detection("drone", .9f, NormalizedBox(.99999994f, .99999994f, 1f, 1f))), 480, 640)!!
        assertEquals(PixelPoint(479.0, 639.0), selected.center)
        val signal = targetSignal(1, 2, stamp(1_000_000_000, source = CaptureTimebase.UNKNOWN),
            1_150_000_000, 480, 640, selected)
        assertEquals(TargetStatus.DETECTED, signal.status)
        assertEquals(selected.center, signal.center)
        assertNull(signal.captureToSignalMs); assertNull(signal.captureToAnalyzerMs)
        assertEquals(140.0, signal.analyzerToSignalMs!!, 0.0)
        assertEquals("unsynchronized_camera_clock", signal.timingIssue)
    }

    @Test fun emptyFramePublishesNoTargetInsteadOfPreviousCoordinates() {
        val backend = Backend()
        val c = LiveController(backend, Executor { it.run() }, eventTime = { 1_150_000_000 })
        c.configure(true, .5f)
        c.analyze(Frame(), stamp = stamp(1_000_000_000))
        val previous = c.signals.value!!
        backend.detections = emptyList()
        val frame = Frame(); c.analyze(frame, stamp = stamp(1_000_000_000))
        val empty = c.signals.value!!
        assertTrue(frame.closed); assertEquals(previous.frameId + 1, empty.frameId)
        assertEquals(TargetStatus.NO_TARGET, empty.status)
        assertNull(empty.center); assertNull(empty.confidence)
        assertEquals(empty, c.state.value.target)
        assertEquals(150.0, empty.captureToSignalMs!!, 0.0)
        c.close()
    }

    private class Frame : AutoCloseable {
        var closes = 0
        val closed get() = closes == 1
        override fun close() { closes++ }
    }
    private class Backend : LiveBackend<Frame> {
        var calls = 0; var action: () -> Unit = {}
        var detections = listOf(droneStatic())
        override fun infer(frame: Frame, confidence: Float): LiveInference {
            calls++; action()
            return LiveInference(detections, 640, 480, 3.0, 1.0, 2.0, 4.0)
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
        c.analyze(Frame(), oldSource, stamp(1_000_000_000)); val oldSignal = c.signals.value!!
        val source = c.newSource(); c.configure(true, .5f)
        val oldFrame = Frame(); c.analyze(oldFrame, oldSource, stamp(1_000_000_000))
        assertTrue(oldFrame.closed); assertNull(c.signals.value); assertEquals(1, b.calls)
        c.analyze(Frame(), source, stamp(1_000_000_000)); assertNotEquals(oldSignal.sourceId, c.signals.value!!.sourceId); assertTrue(c.signals.value!!.frameId > oldSignal.frameId)
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

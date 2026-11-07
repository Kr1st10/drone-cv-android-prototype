package ru.university.dronecv.tracking

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox

/** Fake flow isolates scheduling/ownership; real image motion is covered by OpenCvLkInstrumentedTest. */
class TrackingSessionTest {
    private class Flow : VisualTracker {
        var closes = 0
        var failSequence: Long? = null
        var throwOnClose = false
        var anchor = 0L
        var box: TrackBox? = null
        var points = 10
        override fun initialize(frame: GrayFrame, box: TrackBox): TrackEstimate {
            anchor = frame.key.sequence
            this.box = box
            return TrackEstimate(box, TrackQuality(points, 10, .1, .95))
        }
        override fun update(frame: GrayFrame): TrackEstimate? {
            if (failSequence == frame.key.sequence) return null
            val moved = checkNotNull(box).translated((frame.key.sequence - anchor) * 2.0, 0.0, frame.width, frame.height)
                ?: return null
            return TrackEstimate(moved, TrackQuality(points, 10, .1, .95))
        }
        override fun close() { closes++; if (throwOnClose) error("close failed") }
    }
    private class Fixture {
        val flows = ArrayList<Flow>()
        val session = TrackingSession({ Flow().also { flows.add(it) } })
        init { session.reset(1, 2) }
        fun acquire(): TrackingObservation {
            val a = frame(1)
            session.observe(a)
            val ticket = session.requestYolo(true, a.stamp.analyzerEntryNs)!!
            val correction = session.prepareCorrection(ticket, listOf(drone()))!!.replay()!!
            return session.commit(correction, a.stamp.analyzerEntryNs)!!
        }
    }

    @Test fun `flow updates while detector is busy and higher confidence does not change target`() {
        val f = Fixture()
        val initial = f.acquire()
        for (i in 2L..11) f.session.observe(frame(i))
        val anchor = frame(11)
        val ticket = f.session.requestYolo(true, anchor.stamp.analyzerEntryNs)!!
        for (i in 12L..14) {
            val observation = f.session.observe(frame(i))!!
            assertEquals(initial.trackId, observation.trackId)
            assertEquals(30.0 + (i - 1) * 2, observation.estimate!!.box.centerX, .001)
            assertNull(f.session.requestYolo(false, frame(i).stamp.analyzerEntryNs))
        }
        // YOLO saw sequence 11, not sequence 14; the matching box is at x=40..60.
        val same = drone(.6f, .40f, .60f)
        val stranger = drone(.99f, .70f, .90f)
        val plan = f.session.prepareCorrection(ticket, listOf(stranger, same))!!
        val correction = plan.replay()!!
        f.session.observe(frame(15))
        val final = f.session.commit(correction, frame(15).stamp.analyzerEntryNs)!!
        assertEquals(initial.trackId, final.trackId)
        assertEquals(.6f, final.lastYoloConfidence)
        assertEquals(58.0, final.estimate!!.box.centerX, .001)
        assertEquals(anchor.stamp, final.lastYoloStamp)
        assertEquals(200.0, final.confirmationAgeMs(frame(15).stamp.analyzerEntryNs)!!, .001)
        assertEquals(1, f.flows.first().closes)
        f.session.close()
        assertEquals(1, f.flows.last().closes)
    }

    @Test fun `time scheduler waits through irregular callback counts and forbids overlapping requests`() {
        val f = Fixture(); f.acquire()
        for (i in 2L..10) {
            f.session.observe(frame(i))
            assertNull(f.session.requestYolo(true, frame(i).stamp.analyzerEntryNs))
        }
        f.session.observe(frame(11))
        val request = f.session.requestYolo(true, frame(11).stamp.analyzerEntryNs)!!
        assertNull(f.session.requestYolo(true, frame(11).stamp.analyzerEntryNs))
        f.session.finish(request)
        assertNull(f.session.requestYolo(true, frame(11).stamp.analyzerEntryNs))
    }

    @Test fun `ambiguous and other target detections do not steal the lock`() {
        val f = Fixture(); val initial = f.acquire()
        for (i in 2L..11) f.session.observe(frame(i))
        val ticket = f.session.requestYolo(true, frame(11).stamp.analyzerEntryNs)!!
        assertNull(f.session.prepareCorrection(ticket, listOf(drone(.99f, .7f, .9f))))
        val missed = f.session.observe(frame(12))!!
        assertEquals(initial.trackId, missed.trackId)
        assertEquals(ClassConfirmation.MISSED, missed.classification)
        f.session.observe(frame(13))
        val retry = f.session.requestYolo(true, frame(13).stamp.analyzerEntryNs)!!
        assertNull(f.session.prepareCorrection(retry, listOf(drone(.6f, .44f, .64f), drone(.95f, .45f, .65f))))
        assertEquals(initial.trackId, f.session.observe(frame(14))!!.trackId)
    }

    @Test fun `classification expires despite stable visual flow and loss has no old coordinates`() {
        val f = Fixture(); val initial = f.acquire()
        var observed: TrackingObservation? = null
        for (i in 2L..21) observed = f.session.observe(frame(i))
        assertEquals(VisualPhase.LOST, observed!!.phase)
        assertEquals(ClassConfirmation.EXPIRED, observed.classification)
        assertNull(observed.estimate); assertNull(observed.trackId)
        val request = f.session.requestYolo(true, frame(21).stamp.analyzerEntryNs)!!
        val replacement = f.session.prepareCorrection(request, listOf(drone()))!!.replay()!!
        assertNotEquals(initial.trackId, f.session.commit(replacement, frame(21).stamp.analyzerEntryNs)!!.trackId)
    }

    @Test fun `quality loss invalidates in-flight correction and next acquisition gets a new id`() {
        val f = Fixture(); f.acquire()
        for (i in 2L..11) f.session.observe(frame(i))
        val request = f.session.requestYolo(true, frame(11).stamp.analyzerEntryNs)!!
        val correction = f.session.prepareCorrection(request, listOf(drone(.8f, .4f, .6f)))!!.replay()!!
        f.flows.first().failSequence = 12
        val lost = f.session.observe(frame(12))!!
        assertNull(lost.estimate)
        assertEquals(VisualPhase.LOST, lost.phase)
        assertNull(f.session.commit(correction, frame(12).stamp.analyzerEntryNs))
        assertEquals(1, f.flows.last().closes)
    }

    @Test fun `reset source and close reject delayed results and close native ownership once`() {
        for (close in listOf(false, true)) {
            val f = Fixture(); f.session.observe(frame(1))
            val request = f.session.requestYolo(true, frame(1).stamp.analyzerEntryNs)!!
            val plan = f.session.prepareCorrection(request, listOf(drone()))!!
            val correction = plan.replay()!!
            assertNull(plan.replay())
            if (close) f.session.close() else f.session.reset(2, 3)
            assertNull(f.session.commit(correction, frame(1).stamp.analyzerEntryNs))
            correction.close()
            assertEquals(1, f.flows.single().closes)
            assertNull(f.session.observe(frame(2)))
        }
    }

    @Test fun `large tail and stopped camera reject a correction without extending confirmation`() {
        for (stopped in listOf(false, true)) {
            val f = Fixture(); f.session.observe(frame(1))
            val request = f.session.requestYolo(true, frame(1).stamp.analyzerEntryNs)!!
            val correction = f.session.prepareCorrection(request, listOf(drone()))!!.replay()!!
            if (!stopped) for (i in 2L..4) f.session.observe(frame(i))
            val now = if (stopped) frame(1).stamp.analyzerEntryNs + 2_000_000_000L else frame(4).stamp.analyzerEntryNs
            assertNull(f.session.commit(correction, now))
            assertEquals(1, f.flows.single().closes)
        }
    }

    @Test fun `evicted anchor and replay time budget fail without publishing an old box`() {
        val f = Fixture(); f.session.observe(frame(1))
        val request = f.session.requestYolo(true, frame(1).stamp.analyzerEntryNs)!!
        for (i in 2L..34) f.session.observe(frame(i))
        assertNull(f.session.prepareCorrection(request, listOf(drone())))
        val next = f.session.requestYolo(true, frame(34).stamp.analyzerEntryNs)!!
        val plan = f.session.prepareCorrection(next, listOf(drone()))!!
        var time = 0L
        assertNull(plan.replay(nanoTime = { time.also { time += 200_000_000L } }))
        assertEquals(1, f.flows.single().closes)
        f.session.finish(next)
    }

    @Test fun `unknown clock has null exposure age but bounded analyzer expiry`() {
        val f = Fixture()
        val a = frame(1, unknown = true)
        f.session.observe(a)
        val request = f.session.requestYolo(true, a.stamp.analyzerEntryNs)!!
        val correction = f.session.prepareCorrection(request, listOf(drone()))!!.replay()!!
        val observation = f.session.commit(correction, a.stamp.analyzerEntryNs)!!
        assertNull(observation.confirmationAgeMs(a.stamp.analyzerEntryNs))
        for (i in 2L..21) f.session.observe(frame(i, unknown = true))
        assertNull(f.session.observe(frame(22, unknown = true))!!.estimate)
    }

    @Test fun `capture age and capture gaps constrain apparently fresh analyzer timestamps`() {
        val f = Fixture()
        val a = frame(1, captureDelayNs = 200_000_000L)
        f.session.observe(a)
        val request = f.session.requestYolo(true, a.stamp.analyzerEntryNs)!!
        val correction = f.session.prepareCorrection(request, listOf(drone()))!!.replay()!!
        f.session.commit(correction, a.stamp.analyzerEntryNs)
        for (i in 2L..16) f.session.observe(frame(i, captureDelayNs = 200_000_000L))
        val expired = f.session.observe(frame(17, captureDelayNs = 200_000_000L))!!
        assertEquals(ClassConfirmation.EXPIRED, expired.classification)
        assertNull(expired.estimate)
        // Only 50ms between callbacks, but 250ms between exposures.
        val g = Fixture(); g.session.observe(a)
        val gap = g.session.observe(frame(2))!!
        assertEquals("frame_gap_or_geometry", gap.reason)
        val stale = g.session.observe(frame(3, captureDelayNs = 300_000_000L))!!
        assertEquals("stale_capture", stale.reason)
        assertNull(g.session.requestYolo(true, stale.stamp.analyzerEntryNs))
    }

    @Test fun `old callbacks do not disturb an active track`() {
        val f = Fixture(); f.acquire()
        val newer = f.session.observe(frame(2))!!
        assertNull(f.session.observe(frame(1)))
        assertNull(f.session.observe(GrayFrame.copyOf(FrameKey(0, 2, 3), frame(3).stamp, 100, 100, ByteArray(10000))))
        assertEquals(newer.trackId, f.session.observe(frame(3))!!.trackId)
    }

    @Test fun `discarded stale capture keeps sequence and timestamp watermarks`() {
        val f = Fixture()
        f.session.observe(frame(10))
        assertEquals("stale_capture", f.session.observe(frame(12, captureDelayNs = 300_000_000L))!!.reason)
        assertNull(f.session.observe(frame(11)))
        assertNull(f.session.requestYolo(true, frame(12).stamp.analyzerEntryNs))
        assertNotNull(f.session.observe(frame(13)))
        assertNotNull(f.session.requestYolo(true, frame(13).stamp.analyzerEntryNs))
    }

    @Test fun `replacement remains owned if old native release throws`() {
        val f = Fixture(); f.acquire()
        for (i in 2L..11) f.session.observe(frame(i))
        val request = f.session.requestYolo(true, frame(11).stamp.analyzerEntryNs)!!
        val correction = f.session.prepareCorrection(request, listOf(drone(.8f, .4f, .6f)))!!.replay()!!
        f.flows.first().throwOnClose = true
        assertThrows(IllegalStateException::class.java) { f.session.commit(correction, frame(11).stamp.analyzerEntryNs) }
        assertEquals(1, f.flows.first().closes)
        assertEquals(1, f.flows.last().closes)
        val lost = f.session.observe(frame(12))!!
        assertNull(lost.estimate)
        assertNull(lost.trackId)
        assertEquals(VisualPhase.LOST, lost.phase)
        f.session.close()
        assertEquals(1, f.flows.last().closes)
    }

    companion object {
        private fun frame(sequence: Long, unknown: Boolean = false, captureDelayNs: Long = 0): GrayFrame {
            val entry = 1_000_000_000L + (sequence - 1) * 50_000_000L
            return GrayFrame.copyOf(FrameKey(1, 2, sequence), FrameStamp(entry - captureDelayNs,
                if (unknown) CaptureTimebase.UNKNOWN else CaptureTimebase.ELAPSED_REALTIME, entry),
                100, 100, ByteArray(10000))
        }
        private fun drone(confidence: Float = .8f, left: Float = .2f, right: Float = .4f) =
            Detection("drone", confidence, NormalizedBox(left, .2f, right, .4f))
    }
}

package ru.university.dronecv.camera

import java.util.concurrent.Executor
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.diagnostics.DiagnosticFrames
import ru.university.dronecv.diagnostics.DiagnosticReport
import ru.university.dronecv.diagnostics.toJson
import ru.university.dronecv.tracking.*
import ru.university.dronecv.motion.MotionJournal

class LiveTrackingIntegrationTest {
    private class Queue : Executor {
        private val tasks = ArrayDeque<Runnable>()
        val size get() = tasks.size
        override fun execute(command: Runnable) { tasks.addLast(command) }
        fun step() { tasks.removeFirst().run() }
        fun drain() { while (tasks.isNotEmpty()) step() }
    }

    private class Snapshot : AutoCloseable {
        var closes = 0
        override fun close() { check(++closes == 1) }
    }

    private class Flow : VisualTracker {
        private var estimate: TrackEstimate? = null
        var closes = 0
        var lose = false
        var onUpdate: () -> Unit = {}
        var closeFails = false
        override fun initialize(frame: GrayFrame, box: TrackBox): TrackEstimate =
            TrackEstimate(box, TrackQuality(8, 8, 0.1, 0.9)).also { estimate = it }
        override fun update(frame: GrayFrame): TrackEstimate? {
            onUpdate()
            if (lose) return null
            val last = checkNotNull(estimate)
            return last.copy(box = checkNotNull(last.box.translated(1.0, 0.0, frame.width, frame.height)))
                .also { estimate = it }
        }
        override fun close() {
            check(++closes == 1)
            estimate = null
            if (closeFails) error("test tracker release failure")
        }
    }

    private class Fixture(trackingCapacity: Int = 10_000, journal: MotionJournal? = null) {
        val vision = Queue()
        val ml = Queue()
        val diagnostic = DiagnosticFrames(trackingCapacity = trackingCapacity)
        var now = 1_000_000_000L
        val flows = mutableListOf<Flow>()
        val snapshots = mutableListOf<Snapshot>()
        var sources = 0L
        var calls = 0
        var backendCloses = 0
        var inferenceError = false
        val detector = object : LiveBackend<Snapshot> {
            override fun infer(frame: Snapshot, confidence: Float): LiveInference {
                check(frame.closes == 0)
                calls++
                if (inferenceError) error("test infer failure")
                return LiveInference(listOf(Detection("drone", .8f, NormalizedBox(.2f, .2f, .4f, .4f))),
                    100, 100, 2.0, 1.0, 1.0, 1.0)
            }
            override fun close() { backendCloses++ }
        }
        val controller = LiveController(detector, ml, diagnostic, eventTime = { now },
            tracking = LiveTracking(vision, TrackingSession({ Flow().also { flows += it } })) { _, key, stamp ->
                GrayFrame.copyOf(key, stamp, 100, 100, ByteArray(10000))
            }, motion = journal, nanoTime = { now })

        fun start() {
            sources = controller.newSource()
            controller.configure(true, .5f)
            vision.drain()
        }

        fun frame(timeMs: Long, known: Boolean = true): Snapshot {
            now = 1_000_000_000L + timeMs * 1_000_000L
            val stamp = FrameStamp(now - 5_000_000L, if (known) CaptureTimebase.ELAPSED_REALTIME else CaptureTimebase.UNKNOWN, now)
            val raw = Snapshot()
            val snap = Snapshot().also { snapshots += it }
            val capture = LiveFrameCapture<Snapshot, Snapshot>(controller) {
                PreparedLiveFrame(snap, 1.0)
            }
            capture.analyze(raw, sources, stamp)
            assertEquals(1, raw.closes)
            return snap
        }

        fun acquire() {
            val anchor = frame(0)
            assertEquals(0, anchor.closes)
            ml.step() // Inference reads only the owned copy; release before posting the result.
            assertEquals(1, anchor.closes)
            assertEquals(1, frame(33).closes) // Camera advances before delayed result is handled.
            vision.step()
            ml.step() // Replay anchor -> sequence 2.
            frame(66) // A new frame arrives before the vision executor consumes the correction.
            vision.step()
            val signal = controller.state.value.tracking!!
            assertEquals(TrackingSampleKind.CORRECTION, signal.kind)
            assertEquals(3L, signal.observation.key.sequence)
            assertEquals(32.0, signal.center!!.x, 0.0001)
            assertEquals(71.0, signal.confirmationAgeMs!!, 0.0001)
            assertEquals(5.0, signal.captureToSignalMs!!, 0.0001)
        }
    }

    @Test fun `exported delayed correction keeps detector and coordinate frame times separate`() {
        val file = kotlin.io.path.createTempFile("timeline-correction", ".ndjson").toFile()
        var clock = 1_000_000_000L
        val journal = MotionJournal(clock = { clock }, fileFactory = { file })
        val f = Fixture(journal = journal)
        f.start()
        f.controller.startRecording()
        f.acquire()
        clock = f.now
        journal.stop()
        journal.awaitFinished(file)
        val correction = file.readLines().first { it.contains("\"result_source\":\"correction\"") }
        assertTrue(correction.contains("\"frame_id\":\"3\""))
        assertTrue(correction.contains("\"detector_frame_id\":\"1\""))
        assertTrue(correction.contains("\"last_yolo_frame_id\":\"1\""))
        assertTrue(correction.contains("\"capture_ns\":\"1061000000\""))
        assertTrue(correction.contains("\"last_yolo_capture_ns\":\"995000000\""))
        assertTrue(correction.contains("\"last_yolo_accepted_ns\":\"1066000000\""))
        System.getenv("DRONE_CORRECTION_FIXTURE")?.let { file.copyTo(java.io.File(it), overwrite = true) }
        file.delete()
    }

    @Test fun `new camera frames publish during a queued detector call and export distinct metrics`() {
        val f = Fixture()
        val id = f.diagnostic.start(f.now)
        f.start()
        f.acquire()
        for (ms in 100L..500L step 50) f.frame(ms)
        assertEquals(1, f.ml.size)
        for (ms in 530L..620L step 30) assertEquals(1, f.frame(ms, known = ms != 620L).closes)
        val state = f.controller.state.value
        assertEquals(1, f.calls)
        assertEquals(1, f.ml.size)
        assertEquals(TrackingSampleKind.FRAME, state.tracking!!.kind)
        assertTrue(state.tracking!!.center!!.x > 32.0)
        assertNull(state.tracking!!.captureToSignalMs)
        assertEquals("unsynchronized_camera_clock", state.tracking!!.timingIssue)
        assertNull(f.controller.signals.value)
        f.flows.single().lose = true
        f.frame(650)
        assertEquals(VisualPhase.LOST, f.controller.state.value.tracking!!.observation.phase)
        assertNull(f.controller.state.value.tracking!!.center)
        val snapshot = f.diagnostic.stop(id, f.now, false, null)!!
        assertEquals(1L, snapshot.completedFrames)
        assertEquals(1, snapshot.frames.single().detectionCount)
        assertNull(snapshot.frames.single().targetSignal)
        val tracking = snapshot.tracking!!
        assertEquals(17L, tracking.observedFrames)
        assertEquals(13L, tracking.trackUpdates)
        assertEquals(1L, tracking.corrections)
        assertEquals(1L, tracking.lossEvents)
        println("TRACKING_REPORT_FIXTURE=" +
            DiagnosticReport(0, "test", "test", 35, "test", "model", "sha", .5f, snapshot, emptyList()).toJson())
        f.controller.close()
        f.ml.drain()
        f.vision.drain()
        assertTrue(f.snapshots.all { it.closes == 1 })
    }

    @Test fun `stop and rebind discard a replay already queued for vision and release it`() {
        val f = Fixture()
        f.start()
        f.frame(0)
        f.ml.step()
        f.vision.step()
        f.ml.step()
        assertEquals(1, f.vision.size)
        f.controller.configure(false, .5f)
        assertNull(f.controller.state.value.tracking)
        f.start() // Drains stale correction and reset callbacks for both generations.
        assertNull(f.controller.state.value.tracking)
        assertEquals(1, f.flows.single().closes)
        f.frame(33)
        f.ml.drain()
        f.vision.drain()
        f.ml.drain()
        f.vision.drain()
        assertEquals(f.sources, f.controller.state.value.tracking!!.observation.key.source)
        assertEquals(2, f.calls)
        assertEquals(1, f.backendCloses)
        f.controller.close()
        f.ml.drain()
        f.vision.drain()
        assertTrue(f.flows.all { it.closes == 1 })
    }

    @Test fun `backend error clears tracking and start can reserve a new detector job`() {
        val f = Fixture()
        f.start()
        val snap = f.frame(0)
        f.inferenceError = true
        f.ml.drain()
        f.vision.drain()
        assertEquals(1, snap.closes)
        assertEquals(LivePhase.ERROR, f.controller.state.value.phase)
        assertNull(f.controller.state.value.tracking)
        f.start()
        f.inferenceError = false
        f.frame(33)
        f.ml.drain()
        f.vision.drain()
        assertEquals(2, f.calls)
        assertEquals(LivePhase.RUNNING, f.controller.state.value.phase)
    }

    @Test fun `expiry uses confirmation deadline and an old revision cannot clear a newer track`() {
        val f = Fixture()
        f.start()
        f.acquire()
        assertEquals(f.now + 250_000_000L, f.controller.state.value.tracking!!.displayUntilNs)
        for (ms in 100L..900L step 50) f.frame(ms)
        f.frame(940)
        val previous = f.controller.state.value
        // The initial YOLO capture was 5 ms before the first analyzer entry.
        assertEquals(1_995_000_000L, previous.tracking!!.displayUntilNs)
        f.frame(950)
        val latest = f.controller.state.value
        assertEquals(previous.tracking!!.displayUntilNs, latest.tracking!!.displayUntilNs)
        f.now = latest.tracking!!.displayUntilNs
        f.controller.expire(previous.revision)
        assertSame(latest.tracking, f.controller.state.value.tracking)
        f.controller.expire(latest.revision)
        assertNull(f.controller.state.value.tracking)
        assertNotNull(f.controller.state.value.result)
        f.controller.close()
        f.ml.drain()
        f.vision.drain()
    }

    @Test fun `expired confirmation cannot publish coordinates after slow LK update`() {
        val f = Fixture()
        f.start()
        f.acquire()
        for (ms in 100L..950L step 50) f.frame(ms)
        f.flows.single().onUpdate = { f.now += 25_000_000 }
        f.frame(980)
        assertNull(f.controller.state.value.tracking)
        f.frame(1020)
        assertEquals(ClassConfirmation.EXPIRED, f.controller.state.value.tracking!!.observation.classification)
        assertNull(f.controller.state.value.tracking!!.center)
        f.controller.close()
        f.ml.drain()
        f.vision.drain()
    }

    @Test fun `stop isolates exceptions from native tracker release`() {
        val f = Fixture()
        f.start()
        f.acquire()
        f.flows.single().closeFails = true
        f.controller.configure(false, .5f)
        f.vision.drain()
        assertEquals(LivePhase.STOPPED, f.controller.state.value.phase)
        assertNull(f.controller.state.value.tracking)
        f.start()
        assertEquals(LivePhase.STARTING, f.controller.state.value.phase)
    }

    @Test fun `signal scales LK geometry to full upright crop without rotating again`() {
        val f = Fixture()
        f.start()
        f.acquire()
        val signal = f.controller.state.value.tracking!!.copy(width = 200, height = 300)
        assertEquals(64.0, signal.center!!.x, 0.0001)
        assertEquals(90.0, signal.center!!.y, 0.0001)
        assertEquals(40.0, signal.box!!.width, 0.0001)
        assertEquals(60.0, signal.box!!.height, 0.0001)
    }

    @Test fun `truncation keeps update counters and stale recording tokens cannot append`() {
        val f = Fixture(trackingCapacity = 1)
        val id = f.diagnostic.start(f.now)
        f.start()
        f.acquire()
        f.frame(100)
        val snapshot = f.diagnostic.stop(id, f.now, false, null)!!.tracking!!
        assertEquals(4L, snapshot.observedFrames)
        assertEquals(1L, snapshot.trackUpdates)
        assertEquals(1L, snapshot.corrections)
        assertEquals(4L, snapshot.unstoredSamples)
        val next = f.diagnostic.start(f.now)
        f.diagnostic.tracking(id, f.now, f.controller.state.value.tracking!!)
        assertNull(f.diagnostic.stop(next, f.now, false, null)!!.tracking)
    }
}

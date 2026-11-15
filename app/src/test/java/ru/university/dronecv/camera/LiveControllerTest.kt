package ru.university.dronecv.camera

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.motion.MotionJournal
import ru.university.dronecv.tracking.TrackingSession

class LiveControllerTest {
    private class Frame : AutoCloseable {
        val closes = AtomicInteger()
        override fun close() { closes.incrementAndGet() }
    }

    private class Worker : Executor {
        private val tasks = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { tasks.addLast(command) }
        fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }

    private class Backend : LiveBackend<Frame> {
        val thresholds = mutableListOf<Float>()
        val events = mutableListOf<String>()
        var onInfer: () -> Unit = {}
        var result = LiveInference(listOf(
            Detection("drone", 0.9f, NormalizedBox(0.1f, 0.2f, 0.4f, 0.6f)),
        ), 480, 640, 12.5)
        override fun infer(frame: Frame, confidence: Float): LiveInference {
            thresholds += confidence
            events += "infer"
            onInfer()
            events += "infer-return"
            return result
        }
        override fun close() { events += "close" }
    }

    @Test fun geometrySerializationRequiresOwningDiagnosticTokenAndNeverRetainsPixels() {
        val worker = Worker()
        val diagnostics = ru.university.dronecv.diagnostics.DiagnosticFrames()
        val backend = object : LiveBackend<CameraFrameSnapshot> {
            override fun infer(frame: CameraFrameSnapshot, confidence: Float) = LiveInference(emptyList(), 2, 2, 0.0)
            override fun close() = Unit
        }
        val controller = LiveController(backend, worker, diagnostics, eventTime = { 100L }, nanoTime = { 100L })
        val source = controller.newSource()
        controller.configure(true, .5f)
        val stamp = FrameStamp(99L, CaptureTimebase.ELAPSED_REALTIME, 100L)
        var serializations = 0
        controller.beforeDiagnosticSerialization = { if (it == "frame_geometry") serializations++ }
        val payloads = mutableListOf<() -> String>()
        diagnostics.timeline = { type, payload, _ -> if (type == "frame_geometry") payloads += payload }
        val before = controller.beginFrame(source, stamp)!!
        val first = diagnostics.start(100L)
        val old = controller.beginFrame(source, stamp)!!
        diagnostics.stop(first, 100L, false, null)
        val second = diagnostics.start(100L)
        val current = controller.beginFrame(source, stamp)!!
        val pool = CameraFramePool(maxBytes = 16)
        fun offer(token: LiveFrameToken) {
            val lease = pool.acquire(2, 2)!!
            controller.offerFrame(CameraFrameSnapshot(ru.university.dronecv.detection.yolo.ArgbImage(2, 2, lease.pixels),
                90, 0.0, lease, 4, 6, 1, 2, 3, 4), token, stamp, 0.0)
            worker.drain()
        }
        offer(before); offer(old)
        assertTrue(payloads.isEmpty())
        offer(current)
        assertEquals(0, serializations) // Enqueued, still unencoded.
        assertEquals(1, payloads.size)
        val lease = pool.acquire(2, 2)!! // Frame already released; reuse cannot change geometry.
        lease.pixels.fill(123)
        val json = payloads.single()()
        assertEquals(1, serializations)
        assertTrue(json.contains("\"crop\":[1,2,3,4]"))
        assertTrue(json.contains("\"rotation_degrees\":90"))
        assertTrue(json.contains("\"source_width\":4"))
        lease.close()
        diagnostics.stop(second, 100L, false, null)
        offer(current)
        assertEquals(1, payloads.size)
        controller.close(); worker.drain()
    }

    @Test fun blockedStateSerializationAllowsStopRebindAndKeepsOldRecordingIsolated() {
        val first = kotlin.io.path.createTempFile("deferred-old", ".ndjson").toFile()
        val second = kotlin.io.path.createTempFile("deferred-new", ".ndjson").toFile()
        val files = ArrayDeque(listOf(first, second))
        var now = 1_000_000_000L
        val worker = Worker()
        val diagnostics = ru.university.dronecv.diagnostics.DiagnosticFrames()
        val journal = MotionJournal({ now }, fileFactory = { files.removeFirst() })
        journal.mode("yolo")
        val controller = LiveController(Backend(), worker, diagnostics, eventTime = { now }, motion = journal, nanoTime = { now })
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val operations = Executors.newSingleThreadExecutor()
        controller.beforeDiagnosticSerialization = {
            if (it == "state") { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        }
        try {
            val source = controller.newSource()
            controller.configure(true, .5f)
            controller.startRecording()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
            val oldToken = controller.beginFrame(source, stamp)!!
            controller.offerFrame(Frame(), oldToken, stamp, 0.0)
            // Serializer is blocked on writer, so controls and result publication must remain usable.
            operations.submit { worker.drain(); controller.configure(false, .5f); controller.newSource() }.get(5, TimeUnit.SECONDS)
            release.countDown()
            journal.awaitFinished(first)
            now += 100_000_000L
            controller.configure(true, .5f)
            controller.startRecording()
            controller.offerFrame(Frame(), oldToken, stamp, 0.0)
            worker.drain()
            journal.stop(); journal.awaitFinished(second)
            val oldStates = first.readLines().filter { it.contains("\"type\":\"state\"") }
            assertEquals(3, oldStates.size)
            assertTrue(oldStates[0].contains("initial_snapshot"))
            assertTrue(oldStates[1].contains("\"box\":["))
            assertTrue(oldStates[2].contains("detection_stop"))
            val newStates = second.readLines().filter { it.contains("\"type\":\"state\"") }
            assertEquals(1, newStates.size)
            assertTrue(newStates.single().contains("\"box\":null"))
            assertTrue(newStates.single().contains("\"source_id\":\"2\""))
            assertTrue(newStates.single().contains("\"generation\":\"3\""))
        } finally {
            release.countDown(); operations.shutdownNow()
            controller.close(); worker.drain(); journal.stop()
            journal.awaitFinished(journal.exportFile() ?: first)
            first.delete(); second.delete()
        }
    }

    @Test fun diagnosticRestartDuringInferenceKeepsCurrentStateButRejectsOldFrameMetrics() {
        val worker = Worker()
        val backend = Backend()
        val diagnostics = ru.university.dronecv.diagnostics.DiagnosticFrames()
        val now = 1_000_000_000L
        val controller = LiveController(backend, worker, diagnostics, eventTime = { now }, nanoTime = { now })
        val source = controller.newSource()
        controller.configure(true, .5f)
        val oldEvents = mutableListOf<Pair<String, () -> String>>()
        val newEvents = mutableListOf<Pair<String, () -> String>>()
        var first = 0L
        var second = 0L
        controller.startDiagnostics {
            first = diagnostics.start(now)
            diagnostics.timeline = { type, data, _ -> oldEvents += type to data }
        }
        val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
        val token = controller.beginFrame(source, stamp)!!
        backend.onInfer = {
            diagnostics.stop(first, now, false, null)
            controller.startDiagnostics {
                second = diagnostics.start(now)
                diagnostics.timeline = { type, data, _ -> newEvents += type to data }
            }
        }
        controller.offerFrame(Frame(), token, stamp, 0.0)
        worker.drain()
        val snapshot = diagnostics.stop(second, now, false, null)!!
        // State describes the valid current publication; frame measurements still belong to the old token.
        assertEquals(listOf("metadata", "state"), oldEvents.map { it.first })
        assertEquals(listOf("metadata", "state", "state"), newEvents.map { it.first })
        assertTrue(oldEvents.last().second().contains("\"box\":null"))
        assertTrue(newEvents[1].second().contains("initial_snapshot"))
        assertTrue(newEvents[1].second().contains("\"box\":null"))
        assertTrue(newEvents.last().second().contains("\"last_yolo_capture_ns\":\"$now\""))
        assertTrue(newEvents.last().second().contains("\"box\":["))
        assertEquals(0L, snapshot.completedFrames)
        assertEquals(0L, snapshot.analyzerCallbacks)
        controller.close(); worker.drain()
    }

    @Test fun exportedTimelinePreservesSearchLossRecoveryAndSessionIdentity() {
        val first = kotlin.io.path.createTempFile("timeline-sequence", ".ndjson").toFile()
        val second = kotlin.io.path.createTempFile("timeline-source", ".ndjson").toFile()
        val files = ArrayDeque(listOf(first, second))
        var now = 1_000_000_000L
        val worker = Worker()
        val backend = Backend()
        val journal = MotionJournal(clock = { now }, fileFactory = { files.removeFirst() })
        assertTrue(journal.mode("yolo"))
        val controller = LiveController(backend, worker, eventTime = { now }, motion = journal, nanoTime = { now })
        val source = controller.newSource()
        controller.configure(true, .5f)
        controller.startRecording()
        fun frame() {
            val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
            val token = controller.beginFrame(source, stamp)!!
            controller.offerFrame(Frame(), token, stamp, 0.0)
            worker.drain()
            now += 100_000_000L
        }
        frame()
        val positive = backend.result
        backend.result = positive.copy(detections = emptyList())
        frame()
        backend.result = positive
        frame()
        val stale = FrameStamp(now - 500_000_000L, CaptureTimebase.ELAPSED_REALTIME, now)
        assertNull(controller.beginFrame(source, stale))
        val revision = controller.state.value.revision
        now += 2_000_000_000L
        controller.expire(revision)
        controller.expire(revision)
        frame()
        val stateAtStop = controller.state.value
        journal.stop()
        assertEquals(stateAtStop, controller.state.value)
        journal.awaitFinished(first)
        val records = first.readLines()
        val states = records.filter { it.contains("\"type\":\"state\"") }
        assertEquals(1, records.count { it.contains("\"type\":\"discard\"") })
        assertEquals(6, states.size)
        assertTrue(states[0].contains("\"reason\":\"initial_snapshot\""))
        assertTrue(states[0].contains("\"box\":null"))
        assertTrue(states[1].contains("\"last_yolo_frame_id\":\"1\""))
        assertTrue(states[2].contains("\"reason\":\"no_detection\""))
        assertTrue(states[2].contains("\"last_yolo_frame_id\":\"1\""))
        assertTrue(states[2].contains("\"last_yolo_capture_ns\":\"1000000000\""))
        assertTrue(states[4].contains("\"reason\":\"no_update_timeout\""))
        assertTrue(states.last().contains("\"box\":["))
        assertTrue(records.last().contains("\"type\":\"session_end\""))
        controller.configure(false, .5f)
        val newSource = controller.newSource()
        controller.configure(true, .5f)
        controller.startRecording()
        journal.stop()
        journal.awaitFinished(second)
        val snapshot = second.readLines().first { it.contains("initial_snapshot") }
        assertTrue(snapshot.contains("\"source_id\":\"$newSource\""))
        assertTrue(snapshot.contains("\"generation\":\"3\""))
        assertTrue(snapshot.contains("\"frame_id\":null"))
        assertTrue(snapshot.contains("\"box\":null"))
        System.getenv("DRONE_TIMELINE_FIXTURE")?.let { first.copyTo(java.io.File(it), overwrite = true) }
        first.delete(); second.delete()
    }

    @Test fun recordingStartedWhileFrameQueuedIncludesItsLaterPublication() {
        val file = kotlin.io.path.createTempFile("motion-inflight", ".ndjson").toFile()
        val now = 1_000_000_000L
        val worker = Worker()
        val journal = MotionJournal(clock = { now }, fileFactory = { file })
        assertTrue(journal.mode("yolo"))
        val controller = LiveController(Backend(), worker, eventTime = { now }, motion = journal, nanoTime = { now })
        val source = controller.newSource()
        controller.configure(true, .5f)
        val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
        val token = controller.beginFrame(source, stamp)!!
        controller.offerFrame(Frame(), token, stamp, 0.0)
        controller.startRecording()
        worker.drain()
        journal.stop()
        journal.awaitFinished(file)
        val text = file.readText()
        assertTrue(text.contains("initial_snapshot"))
        assertTrue(text.contains("\"result_source\":\"yolo\""))
        file.delete()
    }

    @Test fun recordingSnapshotAndTimerClearSurviveExport() {
        val file = kotlin.io.path.createTempFile("motion-timeline", ".ndjson").toFile()
        var now = 1_000_000_000L
        val worker = Worker()
        val journal = MotionJournal(clock = { now }, fileFactory = { file })
        assertTrue(journal.mode("yolo"))
        val controller = LiveController(Backend(), worker, eventTime = { now }, motion = journal, nanoTime = { now })
        val source = controller.newSource()
        controller.configure(true, .5f)
        val stamp = FrameStamp(now, CaptureTimebase.ELAPSED_REALTIME, now)
        val token = controller.beginFrame(source, stamp)!!
        controller.offerFrame(Frame(), token, stamp, 0.0)
        worker.drain()
        val revision = controller.state.value.revision
        controller.startRecording()
        assertEquals(revision, controller.state.value.revision)
        now += 2_000_000_000L
        controller.expire(revision)
        controller.expire(revision)
        journal.stop()
        journal.awaitFinished(file)
        val text = file.readText()
        assertTrue(text.contains("initial_snapshot"))
        assertEquals(1, Regex("no_update_timeout").findAll(text).count())
        assertTrue(text.contains("\"frame_id\":null"))
        file.delete()
    }

    @Test fun recreatedControllerUsesRetainedYoloOnlyMode() {
        val worker = Worker()
        val journal = MotionJournal(clock = { 100L })
        assertTrue(journal.mode("yolo"))
        val backend = Backend()
        val tracking = LiveTracking<Frame>(worker, TrackingSession(factory = { error("LK must stay disabled") })) { _, _, _ ->
            error("YOLO-only mode must not create a tracking frame")
        }
        val controller = LiveController(backend, worker, eventTime = { 100L }, tracking = tracking,
            motion = journal, nanoTime = { 100L })
        val source = controller.newSource()
        controller.configure(true, .5f)
        val stamp = FrameStamp(null, CaptureTimebase.UNKNOWN, 100L)
        val token = controller.beginFrame(source, stamp)!!
        val frame = Frame()
        controller.offerFrame(frame, token, stamp, 0.0)
        worker.drain()
        assertEquals(LivePhase.RUNNING, controller.state.value.phase)
        assertEquals(1, backend.thresholds.size)
        assertEquals(1, frame.closes.get())
    }

    @Test fun stoppedAndClosedControllersCloseFramesWithoutInference() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        val stopped = Frame()
        controller.analyze(stopped)
        controller.close()
        controller.close()
        val closed = Frame()
        controller.configure(true, 0.8f)
        controller.analyze(closed)
        assertEquals(1, stopped.closes.get())
        assertEquals(1, closed.closes.get())
        assertTrue(backend.thresholds.isEmpty())
        assertTrue(backend.events.isEmpty()) // Release was queued, not called by close().
        worker.drain()
        assertEquals(listOf("close"), backend.events)
        assertEquals(LivePhase.STOPPED, controller.state.value.phase)
    }

    @Test fun publishesRealBackendResultAndClosesSuccessfulFrameOnce() {
        val worker = Worker()
        val backend = Backend()
        val times = ArrayDeque(listOf(0L, 25_000_000L))
        val controller = LiveController(backend, worker) { times.removeFirst() }
        controller.configure(true, 0.7f)
        assertEquals(LivePhase.STARTING, controller.state.value.phase)
        val frame = Frame()
        controller.analyze(frame)
        val state = controller.state.value
        assertEquals(LivePhase.RUNNING, state.phase)
        assertEquals(backend.result, state.result)
        assertEquals(25.0, state.pipelineMs!!, 0.0)
        assertNull(state.fps)
        assertEquals(1L, state.completedFrames)
        assertEquals(listOf(0.7f), backend.thresholds)
        assertEquals(1, frame.closes.get())
    }

    @Test fun emptyNextFrameReplacesPreviousDetectionsAndKeepsRunning() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        controller.configure(true, 0.5f)
        controller.analyze(Frame())
        assertEquals(1, controller.state.value.result!!.detections.size)
        backend.result = backend.result.copy(detections = emptyList())
        val empty = Frame()
        controller.analyze(empty)
        assertEquals(LivePhase.RUNNING, controller.state.value.phase)
        assertTrue(controller.state.value.result!!.detections.isEmpty())
        assertEquals(2L, controller.state.value.completedFrames)
        assertEquals(1, empty.closes.get())
    }

    @Test fun thresholdChangeImmediatelyClearsBoxesAndUsesNewThreshold() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        controller.configure(true, 0.5f)
        controller.analyze(Frame())
        controller.updateThreshold(0.85f)
        assertEquals(LivePhase.STARTING, controller.state.value.phase)
        assertNull(controller.state.value.result)
        assertNull(controller.state.value.fps)
        assertEquals(0L, controller.state.value.completedFrames)
        controller.analyze(Frame())
        assertEquals(listOf(0.5f, 0.85f), backend.thresholds)
        assertEquals(1L, controller.state.value.completedFrames)
    }

    @Test fun oldBindingCallbacksCloseFramesWithoutInferenceAfterRebind() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        val oldSource = controller.newSource()
        controller.configure(true, 0.5f)
        controller.analyze(Frame(), oldSource)
        assertNotNull(controller.state.value.result)
        val newSource = controller.newSource()
        assertNotEquals(oldSource, newSource)
        assertNull(controller.state.value.result)
        controller.configure(true, 0.5f)
        worker.drain()
        val obsolete = Frame()
        controller.analyze(obsolete, oldSource)
        assertEquals(1, obsolete.closes.get())
        assertEquals(1, backend.thresholds.size)
        assertNull(controller.state.value.result)
        val current = Frame()
        controller.analyze(current, newSource)
        assertEquals(1, current.closes.get())
        assertEquals(2, backend.thresholds.size)
        assertEquals(LivePhase.RUNNING, controller.state.value.phase)
    }

    @Test fun sourceChangeDuringInferenceRejectsItsCompletion() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        val oldSource = controller.newSource()
        controller.configure(true, 0.5f)
        backend.onInfer = { controller.newSource(); controller.configure(true, 0.5f) }
        val frame = Frame()
        controller.analyze(frame, oldSource)
        worker.drain()
        assertEquals(1, frame.closes.get())
        assertEquals(LivePhase.STARTING, controller.state.value.phase)
        assertNull(controller.state.value.result)
        assertNull(controller.state.value.error)
    }

    @Test fun overlappingAnalyzerCallbackIsDroppedAndItsFrameClosed() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        controller.configure(true, 0.5f)
        val overlapping = Frame()
        backend.onInfer = { controller.analyze(overlapping) }
        val first = Frame()
        controller.analyze(first)
        assertEquals(1, backend.thresholds.size)
        assertEquals(1, first.closes.get())
        assertEquals(1, overlapping.closes.get())
        assertEquals(1L, controller.state.value.completedFrames)
    }

    private fun supersededCompletion(failure: Boolean, action: (LiveController<Frame>) -> Unit,
                                     expected: LivePhase) {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        controller.configure(true, 0.5f)
        backend.onInfer = {
            action(controller)
            if (failure) throw IllegalStateException("obsolete failure")
        }
        val frame = Frame()
        controller.analyze(frame)
        worker.drain()
        assertEquals(expected, controller.state.value.phase)
        assertNull(controller.state.value.result)
        assertNull(controller.state.value.error)
        assertEquals(0L, controller.state.value.completedFrames)
        assertEquals(1, frame.closes.get())
    }

    @Test fun stopDiscardsInFlightResult() = supersededCompletion(false,
        { it.configure(false, 0.5f) }, LivePhase.STOPPED)

    @Test fun backgroundDiscardsInFlightError() = supersededCompletion(true,
        { it.configure(false, 0.5f) }, LivePhase.STOPPED)

    @Test fun stopRestartDiscardsInFlightResult() = supersededCompletion(false,
        { it.configure(false, 0.5f); it.configure(true, 0.5f) }, LivePhase.STARTING)

    @Test fun stopRestartDiscardsInFlightError() = supersededCompletion(true,
        { it.configure(false, 0.5f); it.configure(true, 0.5f) }, LivePhase.STARTING)

    @Test fun changedThresholdDiscardsInFlightResult() = supersededCompletion(false,
        { it.configure(true, 0.8f) }, LivePhase.STARTING)

    @Test fun changedThresholdDiscardsInFlightError() = supersededCompletion(true,
        { it.configure(true, 0.8f) }, LivePhase.STARTING)

    @Test fun closeDiscardsInFlightResult() = supersededCompletion(false,
        { it.close() }, LivePhase.STOPPED)

    @Test fun closeDiscardsInFlightError() = supersededCompletion(true,
        { it.close() }, LivePhase.STOPPED)

    @Test fun failureClosesFrameReleasesBackendAndRequiresRestart() {
        val worker = Worker()
        val backend = Backend()
        val controller = LiveController(backend, worker)
        controller.configure(true, 0.5f)
        backend.onInfer = { throw IllegalStateException("model failure") }
        val failed = Frame()
        controller.analyze(failed)
        assertEquals(LivePhase.ERROR, controller.state.value.phase)
        assertEquals("model failure", controller.state.value.error)
        assertEquals(1, failed.closes.get())
        assertFalse(backend.events.contains("close"))
        val ignored = Frame()
        controller.analyze(ignored)
        assertEquals(1, ignored.closes.get())
        assertEquals(1, backend.thresholds.size)
        worker.drain()
        assertEquals(listOf("infer", "close"), backend.events)
        backend.onInfer = {}
        controller.configure(false, 0.5f)
        controller.configure(true, 0.5f)
        worker.drain()
        controller.analyze(Frame())
        assertEquals(LivePhase.RUNNING, controller.state.value.phase)
        assertNull(controller.state.value.error)
    }

    @Test fun memoryFailureClosesFrameAndReportsRecoverableState() {
        val worker = Worker()
        val backend = Backend().apply { onInfer = { throw OutOfMemoryError("frame") } }
        val controller = LiveController(backend, worker)
        controller.configure(true, 0.5f)
        val frame = Frame()
        controller.analyze(frame)
        assertEquals(1, frame.closes.get())
        assertEquals(LivePhase.ERROR, controller.state.value.phase)
        assertTrue(controller.state.value.error!!.contains("памяти"))
        worker.drain()
        assertEquals("close", backend.events.last())
    }

    @Test fun fpsMeasuresCompletionIntervalsRatherThanReciprocalInferenceTime() {
        val times = ArrayDeque(listOf(0L, 100_000_000L,
            400_000_000L, 500_000_000L, 1_000_000_000L, 1_100_000_000L))
        val controller = LiveController(Backend(), Worker()) { times.removeFirst() }
        controller.configure(true, 0.5f)
        controller.analyze(Frame())
        assertNull(controller.state.value.fps)
        controller.analyze(Frame())
        assertEquals(2.5, controller.state.value.fps!!, 1e-9)
        controller.analyze(Frame())
        assertEquals(2.0, controller.state.value.fps!!, 1e-9)
        assertEquals(100.0, controller.state.value.pipelineMs!!, 0.0)
        assertEquals(12.5, controller.state.value.result!!.inferenceMs, 0.0)
    }

    @Test fun expiryClearsOnlyItsOwnResultAndNeverANewerFrame() {
        val controller = LiveController(Backend(), Worker())
        controller.configure(true, 0.5f)
        controller.analyze(Frame())
        val old = controller.state.value.revision
        controller.analyze(Frame())
        val latest = controller.state.value.revision
        controller.expire(old)
        assertNotNull(controller.state.value.result)
        controller.expire(latest)
        assertNull(controller.state.value.result)
        assertEquals(LivePhase.RUNNING, controller.state.value.phase)
    }

    @Test fun expiryFromPreviousRunCannotCollideWithNewRunRevision() {
        val worker = Worker()
        val controller = LiveController(Backend(), worker)
        controller.configure(true, 0.5f)
        repeat(3) { controller.analyze(Frame()) }
        val old = controller.state.value.revision
        controller.configure(false, 0.5f)
        controller.configure(true, 0.5f)
        worker.drain()
        controller.analyze(Frame())
        assertTrue("Result revisions must never be reused", controller.state.value.revision > old)
        controller.expire(old)
        assertNotNull(controller.state.value.result)
    }

    @Test fun stopAndCloseReturnWhileNativeInferenceIsBlockedAndReleaseIsOrderedOnWorker() {
        val worker = Executors.newSingleThreadExecutor { Runnable -> Thread(Runnable, "live-test-worker") }
        val entered = CountDownLatch(1)
        val releaseInference = CountDownLatch(1)
        val backendClosed = CountDownLatch(1)
        val frame = Frame()
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        val backend = object : LiveBackend<Frame> {
            override fun infer(frame: Frame, confidence: Float): LiveInference {
                events += "infer:${Thread.currentThread().name}"
                entered.countDown()
                check(releaseInference.await(5, TimeUnit.SECONDS)) { "test did not release inference" }
                events += "infer-return"
                return LiveInference(emptyList(), 640, 480, 1.0)
            }
            override fun close() {
                events += "close:${Thread.currentThread().name}"
                backendClosed.countDown()
            }
        }
        val controller = LiveController(backend, worker)
        try {
            controller.configure(true, 0.5f)
            val inference = worker.submit { controller.analyze(frame) }
            assertTrue("Inference should enter worker", entered.await(5, TimeUnit.SECONDS))
            controller.configure(false, 0.5f)
            controller.close()
            assertEquals(LivePhase.STOPPED, controller.state.value.phase)
            assertNull(controller.state.value.result)
            assertEquals(1L, backendClosed.count) // No close while native inference is still running.
            assertEquals(0, frame.closes.get())
            releaseInference.countDown()
            inference.get(5, TimeUnit.SECONDS)
            assertTrue(backendClosed.await(5, TimeUnit.SECONDS))
            worker.submit {}.get(5, TimeUnit.SECONDS)
            assertEquals(1, frame.closes.get())
            assertEquals("infer:live-test-worker", events[0])
            assertEquals("infer-return", events[1])
            assertTrue(events.drop(2).all { it == "close:live-test-worker" })
            assertNull(controller.state.value.result)
        } finally {
            releaseInference.countDown()
            controller.close()
            worker.shutdown()
            assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS))
        }
    }
}

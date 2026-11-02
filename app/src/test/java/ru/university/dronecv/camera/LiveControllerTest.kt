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

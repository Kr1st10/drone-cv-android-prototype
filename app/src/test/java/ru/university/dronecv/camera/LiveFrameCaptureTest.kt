package ru.university.dronecv.camera

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.diagnostics.DiagnosticFrames

class LiveFrameCaptureTest {
    private class Input(val id: Int) : AutoCloseable {
        var closes = 0
        var closing: () -> Unit = {}
        override fun close() { closes++; closing() }
    }
    private class Snapshot(val id: Int) : AutoCloseable {
        var closes = 0
        override fun close() { closes++ }
    }
    private class Worker : Executor {
        val tasks = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { tasks.addLast(command) }
        fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }
    private class Backend : LiveBackend<Snapshot> {
        val ids = mutableListOf<Int>()
        val events = mutableListOf<String>()
        var action: (Snapshot) -> Unit = {}
        override fun infer(frame: Snapshot, confidence: Float): LiveInference {
            events += "infer:${frame.id}"; ids += frame.id; action(frame)
            events += "return:${frame.id}"
            return LiveInference(emptyList(), 640, 480, 3.0, 1.0, 2.0, 4.0)
        }
        override fun close() { events += "close" }
    }
    private fun stamp(i: Int = 0, source: CaptureTimebase = CaptureTimebase.ELAPSED_REALTIME) =
        FrameStamp(1_000_000_000L + i * 1_000_000, source, 1_010_000_000L + i * 1_000_000)
    private fun controller(b: Backend, w: Executor, d: DiagnosticFrames? = null) =
        LiveController(b, w, d, eventTime = { 1_150_000_000L })

    @Test fun replacesPendingSnapshotAndClosesCameraBeforeAnyInference() {
        val w = Worker(); val b = Backend(); val c = controller(b, w)
        val source = c.newSource(); c.configure(true, .5f)
        val snapshots = mutableListOf<Snapshot>()
        val inputs = (1..3).map(::Input)
        val capture = LiveFrameCapture(c) { input: Input ->
            PreparedLiveFrame(Snapshot(input.id).also { snapshots += it }, 1.0)
        }
        b.action = { assertTrue(inputs.all { it.closes == 1 }) }
        inputs.forEach { capture.analyze(it, source, stamp(it.id)) }
        assertTrue(b.ids.isEmpty()); assertEquals(1, w.tasks.size)
        assertEquals(listOf(1, 1, 0), snapshots.map { it.closes })
        assertEquals(3L, c.input.value.received); assertEquals(2L, c.input.value.superseded)
        w.drain()
        assertEquals(listOf(3), b.ids); assertTrue(snapshots.all { it.closes == 1 })
        assertEquals(TargetStatus.NO_TARGET, c.signals.value!!.status)
        c.close(); w.drain()
    }

    @Test fun inputContinuesWhileInferenceIsBlockedAndOrtCallsRemainSerial() {
        val w = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val latest = CountDownLatch(1)
        val b = Backend(); val c = controller(b, w); val active = AtomicInteger(); val maximum = AtomicInteger()
        val source = c.newSource(); c.configure(true, .5f)
        val snapshots = mutableListOf<Snapshot>()
        val capture = LiveFrameCapture(c) { input: Input ->
            PreparedLiveFrame(Snapshot(input.id).also { snapshots += it }, 1.0)
        }
        b.action = { frame ->
            val n = active.incrementAndGet(); maximum.accumulateAndGet(n, ::maxOf)
            try {
                if (frame.id == 1) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                if (frame.id == 3) latest.countDown()
            } finally { active.decrementAndGet() }
        }
        try {
            val first = Input(1); capture.analyze(first, source, stamp(1))
            assertTrue(entered.await(5, TimeUnit.SECONDS)); assertEquals(1, first.closes)
            val middle = Input(2); val last = Input(3)
            capture.analyze(middle, source, stamp(2)); capture.analyze(last, source, stamp(3))
            assertEquals(1, middle.closes); assertEquals(1, last.closes)
            assertEquals(3L, c.input.value.received); assertEquals(1, snapshots[1].closes)
            assertEquals(1L, release.count) // both later callbacks finished without releasing native inference.
            release.countDown(); assertTrue(latest.await(5, TimeUnit.SECONDS))
            w.submit {}.get(5, TimeUnit.SECONDS)
            assertEquals(listOf(1, 3), b.ids); assertEquals(1, maximum.get())
            assertTrue(snapshots.all { it.closes == 1 })
        } finally { release.countDown(); c.close(); w.shutdown(); assertTrue(w.awaitTermination(5, TimeUnit.SECONDS)) }
    }

    @Test fun thresholdRestartDuringCopyCannotRetagOldPixels() {
        val w = Worker(); val b = Backend(); val c = controller(b, w)
        val source = c.newSource(); c.configure(true, .5f)
        val snapshot = Snapshot(1)
        val capture = LiveFrameCapture(c) { _: Input ->
            c.configure(false, .5f); c.configure(true, .8f)
            PreparedLiveFrame(snapshot, 1.0)
        }
        val input = Input(1); capture.analyze(input, source, stamp())
        w.drain(); assertTrue(b.ids.isEmpty()); assertEquals(1, input.closes); assertEquals(1, snapshot.closes)
        assertNull(c.signals.value); assertEquals(LivePhase.STARTING, c.state.value.phase)
        c.close(); w.drain()
    }

    @Test fun stopRebindAndCloseReleasePendingAndRejectOldSourceBeforeCopy() {
        for (action in 0..2) {
            val w = Worker(); val b = Backend(); val c = controller(b, w)
            val source = c.newSource(); c.configure(true, .5f); val snapshot = Snapshot(1)
            var copies = 0
            val capture = LiveFrameCapture(c) { _: Input -> copies++; PreparedLiveFrame(snapshot, 1.0) }
            capture.analyze(Input(1), source, stamp())
            when (action) { 0 -> c.configure(false, .5f); 1 -> c.newSource(); else -> c.close() }
            val old = Input(2); capture.analyze(old, source, stamp())
            w.drain(); assertEquals(1, copies); assertEquals(1, old.closes); assertEquals(1, snapshot.closes)
            assertTrue(b.ids.isEmpty()); assertNull(c.signals.value)
            c.close(); w.drain()
        }
    }

    @Test fun noBufferCopyFailureAndCameraCloseFailureNeverLeakFrames() {
        for (action in 0..3) {
            val w = Worker(); val b = Backend(); val c = controller(b, w)
            val source = c.newSource(); c.configure(true, .5f); val snapshot = Snapshot(1)
            val capture = LiveFrameCapture(c) { _: Input -> when (action) {
                0 -> null
                1 -> throw IllegalStateException("copy failed")
                2 -> throw OutOfMemoryError("copy OOM")
                else -> PreparedLiveFrame(snapshot, 1.0)
            } }
            val input = Input(1)
            if (action == 3) input.closing = { error("close failed") }
            capture.analyze(input, source, stamp()); w.drain()
            assertEquals(1, input.closes); assertTrue(b.ids.isEmpty())
            if (action == 0) assertEquals(1L, c.input.value.noBuffer)
            else assertEquals(LivePhase.ERROR, c.state.value.phase)
            if (action == 3) assertEquals(1, snapshot.closes)
            c.close(); w.drain()
        }
    }

    @Test fun staleInputSkipsCopyAndQueuedFrameExpiresBeforeNativeCall() {
        val w = Worker(); val b = Backend(); val now = AtomicLong(0)
        val d = DiagnosticFrames(); val session = d.start(0)
        val c = LiveController(b, w, d, eventTime = { 1_150_000_000L }, nanoTime = now::get)
        val source = c.newSource(); c.configure(true, .5f); var copies = 0
        val snapshot = Snapshot(1)
        val capture = LiveFrameCapture(c) { _: Input -> copies++; PreparedLiveFrame(snapshot, 1.0) }
        val stale = Input(0)
        capture.analyze(stale, source, stamp().copy(analyzerEntryNs = 1_300_000_000L))
        assertEquals(0, copies); assertEquals(1, stale.closes)
        capture.analyze(Input(1), source, stamp())
        now.set(300_000_000); w.drain()
        assertEquals(1, snapshot.closes); assertTrue(b.ids.isEmpty())
        val report = d.stop(session, 1_000_000_000, false, null)!!
        assertEquals(2L, report.staleFramesDiscarded); assertEquals(2L, report.cameraInput.stale)
        c.close(); w.drain()
    }

    @Test fun closeAndFreshFrameAreOrderedAfterOldNativeCall() {
        val w = Worker(); val b = Backend(); val c = controller(b, w)
        val source = c.newSource(); c.configure(true, .5f)
        val capture = LiveFrameCapture(c) { input: Input -> PreparedLiveFrame(Snapshot(input.id), 1.0) }
        b.action = { frame -> if (frame.id == 1) {
            c.configure(false, .5f); c.configure(true, .7f)
            capture.analyze(Input(2), source, stamp(2))
        } }
        capture.analyze(Input(1), source, stamp(1)); w.drain()
        assertEquals(listOf("infer:1", "return:1", "close", "infer:2", "return:2"), b.events)
        assertEquals(1L, c.state.value.completedFrames)
        c.close(); w.drain()
    }

    @Test fun diagnosticTokenIsFixedAtCaptureAndCannotLeakIntoNewSession() {
        val w = Worker(); val b = Backend(); val d = DiagnosticFrames(); val first = d.start(0)
        val c = controller(b, w, d); val source = c.newSource(); c.configure(true, .5f)
        val capture = LiveFrameCapture(c) { input: Input -> PreparedLiveFrame(Snapshot(input.id), 1.0) }
        capture.analyze(Input(1), source, stamp())
        val old = d.stop(first, 100, false, null)!!; assertEquals(1L, old.cameraInput.copied)
        val second = d.start(0); w.drain()
        val next = d.stop(second, Long.MAX_VALUE, false, null)!!
        assertEquals(0L, next.completedFrames); assertEquals(0L, next.cameraInput.received)
        c.close(); w.drain()
    }

    @Test fun queuedOldPumpCannotStealNewActivationBeforeReleaseBarrier() {
        val w = Worker(); val b = Backend(); val c = controller(b, w)
        val source = c.newSource(); c.configure(true, .5f)
        val snapshots = mutableListOf<Snapshot>()
        val capture = LiveFrameCapture(c) { input: Input ->
            PreparedLiveFrame(Snapshot(input.id).also { snapshots += it }, 1.0)
        }
        capture.analyze(Input(1), source, stamp(1)) // pump is queued but has not started.
        c.configure(false, .5f); c.configure(true, .7f)
        capture.analyze(Input(2), source, stamp(2))
        w.drain()
        assertEquals(listOf("close", "infer:2", "return:2"), b.events)
        assertEquals(listOf(2), b.ids); assertTrue(snapshots.all { it.closes == 1 })
        c.close(); w.drain()
    }

    @Test fun rejectedWorkerReleasesOwnedSnapshotAndReportsError() {
        val w = Executor { throw java.util.concurrent.RejectedExecutionException("test") }
        val b = Backend(); val c = controller(b, w); val source = c.newSource(); c.configure(true, .5f)
        val snapshot = Snapshot(1); val input = Input(1)
        val capture = LiveFrameCapture(c) { _: Input -> PreparedLiveFrame(snapshot, 1.0) }
        capture.analyze(input, source, stamp())
        assertEquals(1, input.closes); assertEquals(1, snapshot.closes)
        assertEquals(LivePhase.ERROR, c.state.value.phase); assertTrue(b.ids.isEmpty())
    }


    @Test fun failureBeforePendingAssignmentReturnsSnapshotOwnership() {
        val w = Worker(); val b = Backend()
        val c = LiveController(b, w, nanoTime = { error("test clock failure") })
        val source = c.newSource(); c.configure(true, .5f)
        val snapshot = Snapshot(1); val input = Input(1)
        val capture = LiveFrameCapture(c) { _: Input -> PreparedLiveFrame(snapshot, 1.0) }
        capture.analyze(input, source, stamp())
        assertEquals(1, snapshot.closes); assertEquals(1, input.closes)
        assertEquals(LivePhase.ERROR, c.state.value.phase)
        w.drain(); assertTrue(b.ids.isEmpty()); c.close(); w.drain()
    }

}

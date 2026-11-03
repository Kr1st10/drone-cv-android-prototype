package ru.university.dronecv.camera

import java.util.concurrent.Executor
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.diagnostics.DiagnosticFrames

class ThreadSwitchControllerTest {
    private class Frame : AutoCloseable { override fun close() {} }
    private class Worker : Executor {
        private val q = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { q.addLast(command) }
        fun drain() { while (q.isNotEmpty()) q.removeFirst().run() }
    }
    private class Backend : LiveBackend<Frame> {
        val calls = mutableListOf<String>()
        var failure = false
        var duringInfer: () -> Unit = {}
        override fun infer(frame: Frame, confidence: Float): LiveInference {
            duringInfer(); return LiveInference(emptyList(), 640, 480, 10.0)
        }
        override fun changeThreads(threads: Int) { calls.add("switch:$threads"); if (failure) error("init failed") }
        override fun close() { calls.add("close") }
    }
    @Test fun acceptsOnlyWhileStoppedAndPersistsSuccessfulSetting() {
        val w=Worker(); val b=Backend(); val c=LiveController(b,w)
        assertEquals(2,c.threadConfiguration.value.threads)
        c.configure(true,.5f); assertFalse(c.requestThreads(4)); assertTrue(b.calls.isEmpty())
        c.configure(false,.5f); assertTrue(c.requestThreads(4)); assertTrue(c.threadConfiguration.value.switching)
        c.configure(true,.5f); assertEquals(LivePhase.STOPPED,c.state.value.phase)
        w.drain(); assertEquals(listOf("close","switch:4"),b.calls)
        assertEquals(4,c.threadConfiguration.value.threads); assertFalse(c.threadConfiguration.value.switching)
        assertTrue(c.requestThreads(1)); w.drain(); assertEquals(1,c.threadConfiguration.value.threads)
        c.configure(true,.5f); c.analyze(Frame()); assertEquals(LivePhase.RUNNING,c.state.value.phase)
    }
    @Test fun cannotChangeWhileFrameInFlightOrDiagnosticsActive() {
        val w=Worker(); val b=Backend(); val d=DiagnosticFrames(); val c=LiveController(b,w,d)
        c.configure(true,.5f); b.duringInfer={ c.configure(false,.5f); assertFalse(c.requestThreads(1)) }
        c.analyze(Frame()); w.drain(); assertTrue(b.calls.none { it.startsWith("switch") })
        val id=d.start(0); assertFalse(c.requestThreads(4)); d.stop(id,1,false,null)
        assertTrue(c.requestThreads(4)); w.drain(); assertEquals(4,c.threadConfiguration.value.threads)
    }
    @Test fun failureKeepsPreviousSelectionAndShowsError() {
        val w=Worker(); val b=Backend(); val c=LiveController(b,w,initialThreads=1)
        b.failure=true; assertTrue(c.requestThreads(4)); w.drain()
        assertEquals(1,c.threadConfiguration.value.threads); assertNotNull(c.threadConfiguration.value.error)
        assertFalse(c.threadConfiguration.value.switching)
    }
    @Test fun closedBeforeWorkerStartsNeverOpensNewSession() {
        val w=Worker(); val b=Backend(); val c=LiveController(b,w)
        assertTrue(c.requestThreads(4)); c.close(); w.drain()
        assertEquals(listOf("close"),b.calls); assertFalse(c.requestThreads(1))
    }
}

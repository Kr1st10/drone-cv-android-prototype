package ru.university.dronecv.diagnostics

import org.junit.Assert.*
import org.junit.Test

class DiagnosticStatisticsTest {
    @Test fun summaryAndPercentile() {
        assertNull(durationSummary(emptyList()))
        val s = durationSummary((1..20).map(Int::toDouble))!!
        assertEquals(10.5, s.mean, 0.0); assertEquals(10.5, s.median, 0.0)
        assertEquals(19.0, s.p95, 0.0); assertEquals(1.0, s.min, 0.0); assertEquals(20.0, s.max, 0.0)
    }
    @Test fun sessionTokensAndBoundedStorage() {
        val store = DiagnosticFrames(1)
        val a = store.start(0); store.received(a); store.completed(a, 100, 1.0, 2.0, 3.0, 4.0, 11.0)
        store.received(a); store.completed(a, 200, 1.0, 2.0, 3.0, 4.0, 11.0)
        val first = store.stop(a, 1_000_000_000, true, "pause")!!
        assertEquals(2L, first.completedFrames); assertEquals(1L, first.unstoredFrames)
        assertEquals(2.0, first.processedFps!!, 0.0); assertTrue(first.interrupted)
        val b = store.start(2_000_000_000); store.received(a)
        store.completed(a, 2_000_000_100, 1.0, 2.0, 3.0, 4.0, 11.0)
        val second = store.stop(b, 3_000_000_000, false, null)!!
        assertEquals(0L, second.completedFrames); assertEquals(0L, second.analyzerCallbacks)
        assertNull(store.stop(a, 3_000_000_000, false, null))
    }
    @Test fun invalidTimeRejected() {
        val store = DiagnosticFrames(); val token = store.start(10)
        try { store.completed(token, 9, 1.0, 2.0, 3.0, 4.0, 11.0); fail() }
        catch (_: IllegalArgumentException) { }
        assertEquals(0L, store.stop(token, 10, true, "error")!!.completedFrames)
    }
}

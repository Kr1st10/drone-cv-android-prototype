package ru.university.dronecv.detection

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.detection.onnx.ThreadSessionManager

class ThreadSessionManagerTest {
    private class Session(val threads: Int, val events: MutableList<String>) : AutoCloseable {
        override fun close() { events.add("close:$threads") }
    }
    @Test fun defaultAndRepeatedSwitchCloseBeforeOpen() {
        val events = mutableListOf<String>()
        val m = ThreadSessionManager { n -> events.add("open:$n"); Session(n, events) }
        assertEquals(2, m.threads)
        m.session(); m.switchTo(1); m.switchTo(4); m.switchTo(2); m.close(); m.close()
        assertEquals(listOf("open:2", "close:2", "open:1", "close:1", "open:4", "close:4", "open:2", "close:2"), events)
    }
    @Test fun failedCreationRestoresPreviousConfiguration() {
        val events = mutableListOf<String>()
        val m = ThreadSessionManager { n -> events.add("open:$n"); if (n == 4) throw IllegalStateException("fail"); Session(n, events) }
        m.session()
        try { m.switchTo(4); fail() } catch (_: IllegalStateException) { }
        assertEquals(2, m.threads); assertEquals(2, m.session().threads)
        assertEquals(listOf("open:2", "close:2", "open:4", "open:2"), events)
    }
    @Test fun rollbackFailureRetainsSettingAndReportsBothErrors() {
        var calls = 0
        val m = ThreadSessionManager<Session> { n -> calls++; if (calls > 1) error("failed $n"); Session(n, mutableListOf()) }
        m.session()
        try { m.switchTo(1); fail() } catch (e: IllegalStateException) { assertEquals(1, e.suppressed.size) }
        assertEquals(2, m.threads)
    }
    @Test fun closeFailureDoesNotCreateSecondSession() {
        val events = mutableListOf<String>()
        val m = ThreadSessionManager<AutoCloseable> { n -> events.add("open:$n"); AutoCloseable { error("close failed") } }
        m.session()
        try { m.switchTo(4); fail() } catch (_: IllegalStateException) { }
        assertEquals(listOf("open:2"), events); assertEquals(2, m.threads)
    }
    @Test fun invalidThreadCountsRejected() {
        try { ThreadSessionManager<Session>(3) { n -> Session(n, mutableListOf()) }; fail() } catch (_: IllegalArgumentException) { }
        val m = ThreadSessionManager { n -> Session(n, mutableListOf()) }
        try { m.switchTo(8); fail() } catch (_: IllegalArgumentException) { }
    }
}

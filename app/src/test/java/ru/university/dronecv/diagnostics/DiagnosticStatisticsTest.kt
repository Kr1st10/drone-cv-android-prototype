package ru.university.dronecv.diagnostics

import org.junit.Assert.*
import org.junit.Test

class DiagnosticStatisticsTest {
    @Test fun lazyEventsRejectAbsentAndObsoleteRecipientsBeforeSerialization() {
        val store = DiagnosticFrames()
        var calls = 0
        val payload = { calls++; "{}" }
        store.event(null, "state", payload, 1L)
        val first = store.start(1L)
        store.event(first, "state", payload, 1L) // Recording without a timeline still collects metrics.
        assertEquals(0, calls)
        val events = mutableListOf<String>()
        store.timeline = { type, data, _ -> events += type; data() }
        store.event(first, "state", payload, 1L)
        store.stop(first, 1L, false, null)
        val second = store.start(1L)
        store.event(first, "discard", payload, 1L)
        store.event(null, "state", payload, 1L)
        assertEquals(1, calls)
        store.event(second, "state", payload, 1L)
        assertEquals(listOf("state", "state"), events)
        assertEquals(2, calls)
        store.stop(second, 1L, false, null)
        assertFalse(store.hasTimeline(second))
    }

    @Test fun trackingLongRepresentationMatchesLegacyJsonAndNdjsonIncludingNullableStamps() {
        val stamp = ru.university.dronecv.camera.FrameStamp(Long.MAX_VALUE - 2,
            ru.university.dronecv.camera.CaptureTimebase.ELAPSED_REALTIME, Long.MAX_VALUE - 1)
        val observation = ru.university.dronecv.tracking.TrackingObservation(
            ru.university.dronecv.tracking.FrameKey(-1, Long.MIN_VALUE, Long.MAX_VALUE), stamp,
            ru.university.dronecv.tracking.VisualPhase.SEARCHING, null, null,
            ru.university.dronecv.tracking.ClassConfirmation.NONE, null, null, null)
        val signal = ru.university.dronecv.camera.TrackingSignal(observation,
            ru.university.dronecv.camera.TrackingSampleKind.FRAME, 100, 100, Long.MAX_VALUE, 0.0)
        for (s in listOf(signal, signal.copy(observation = observation.copy(lastYoloStamp = stamp, trackId = Long.MAX_VALUE)))) {
            val legacy = buildString { appendTrackingSample(0.0, s) }
            val expected = legacy.replace(Regex("\"(sequence|generation|source_id|track_id|capture_ns|analyzer_entry_ns|signal_dispatch_ns)\":(-?[0-9]+)")) {
                "\"${it.groupValues[1]}\":\"${it.groupValues[2]}\""
            }
            assertEquals(expected, buildString { appendTrackingSample(0.0, s, quoteLongs = true) })
            assertTrue(legacy.contains("\"signal_dispatch_ns\":${Long.MAX_VALUE}"))
        }
    }

    @Test fun summaryAndPercentile() {
        assertNull(durationSummary(emptyList()))
        assertNull(durationSummary(listOf(1.0, 2.0))!!.p95)
        val s = durationSummary((1..20).map(Int::toDouble))!!
        assertEquals(10.5, s.mean, 0.0); assertEquals(10.5, s.median, 0.0)
        assertEquals(19.0, s.p95!!, 0.0); assertEquals(1.0, s.min, 0.0); assertEquals(20.0, s.max, 0.0)
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

class DiagnosticReportTest {
    @Test fun exportedThreadConfigurationAndWarmup() {
        val f = DiagnosticFrameSnapshot(1_000_000_000L, 0, 0, 0, false, null, emptyList())
        for (n in listOf(1,2,4)) {
            val json = DiagnosticReport(0, "device", "10", 29, "0.4.0", "model", "hash", .5f, f, emptyList(), n, "debug", 30).toJson()
            assertTrue(json.contains("\"intra_op_threads\":$n"))
            assertTrue(json.contains("\"inter_op_threads\":1"))
            assertTrue(json.contains("\"execution_mode\":\"SEQUENTIAL\""))
            assertTrue(json.contains("\"execution_provider\":\"CPU\""))
            assertTrue(json.contains("\"build_type\":\"debug\""))
            assertTrue(json.contains("\"completed_frames_before_session\":30"))
        }
    }
    @Test fun exportIncludesEmptyAndInterruptedStateAndEscapesStrings() {
        val f = DiagnosticFrameSnapshot(1_000_000_000L, 0, 0, 0, true, "pause\n\"quoted\"", emptyList())
        val r = DiagnosticReport(0, "Device", "15", 35, "0.4.0", "models/test.onnx", "abc", .5f, f, emptyList())
        val json = r.toJson()
        assertTrue(json.contains("\"interrupted\":true"))
        assertTrue(json.contains("pause\\n\\\"quoted\\\""))
        assertTrue(json.contains("\"preprocessing\":null"))
        assertTrue(json.contains("\"camera_frames_dropped\":null"))
        assertTrue(json.contains("\"frames\":[]"))
    }
}

package ru.university.dronecv.diagnostics

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.*

class TargetReportTest {
    @Test fun serializerProducesExposureLatencyAndNullForUnknownClock() {
        val signal = TargetSignal(1, 1, FrameStamp(1_000_000_000, CaptureTimebase.ELAPSED_REALTIME, 1_010_000_000),
            1_150_000_000, 640, 480, TargetStatus.DETECTED, PixelPoint(100.0, 200.0), .9f)
        val unknown = signal.copy(frameId = 2, stamp = signal.stamp.copy(timebase = CaptureTimebase.UNKNOWN))
        val store = DiagnosticFrames(); val token = store.start(0)
        listOf(signal, unknown).forEachIndexed { i, s ->
            store.received(token); store.completed(token, (i + 1) * 1_000_000L, 1.0, 2.0, 3.0, 4.0, 11.0, s)
        }
        repeat(3) {
            store.input(token, CameraInputEvent.RECEIVED)
            store.input(token, CameraInputEvent.COPIED, 1.0)
        }
        store.input(token, CameraInputEvent.SUPERSEDED)
        store.discardStale(token)
        val report = DiagnosticReport(0, "synthetic-test", "test", 29, "0.5.1", "model", "hash", .5f,
            store.stop(token, 1_000_000_000, false, null)!!, emptyList())
        val json = report.toJson()
        assertTrue(json.contains("\"capture_to_signal_ms\":150.0"))
        assertTrue(json.contains("\"capture_to_signal_ms\":null"))
        assertTrue(json.contains("\"application_stale_frames_discarded\":1"))
        assertTrue(json.contains("\"pixel\":{\"x\":100,\"y\":200}"))
        assertTrue(json.contains("\"target_signal_schema_version\":2"))
        assertTrue(json.contains("\"p50\":150.0"))
        assertTrue(json.contains("\"available_fraction\":0.5"))
        assertFalse(json.contains("target_id")); assertFalse(json.contains("prediction"))
        assertTrue(json.contains("\"received_frames\":3"))
        assertTrue(json.contains("\"superseded_frames\":1"))
        assertTrue(json.contains("\"copy_mean_ms\":1.0"))
        assertTrue(json.contains("\"fps_session\":3.0"))
        println("TARGET_REPORT_FIXTURE=$json")
    }
}

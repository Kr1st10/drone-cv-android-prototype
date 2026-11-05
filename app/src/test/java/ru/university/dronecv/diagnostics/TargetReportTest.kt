package ru.university.dronecv.diagnostics

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.*

class TargetReportTest {
    @Test fun serializerProducesExposureLatencyAndNullForUnknownClock() {
        val signal = TargetSignal(1, 1, FrameStamp(1_000_000_000, CaptureTimebase.ELAPSED_REALTIME, 1_010_000_000),
            1_150_000_000, 640, 480, 1, TargetStatus.OBSERVED, PixelPoint(100.0, 200.0), .9f,
            PixelVelocity(10.0, 0.0), emptyList(), listOf(ForecastPoint(200, PixelPoint(103.5, 200.0))), null, 2.0)
        val unknown = signal.copy(frameId = 2, stamp = signal.stamp.copy(timebase = CaptureTimebase.UNKNOWN), forecast = emptyList(),
            predictionIssue = "unsynchronized_camera_clock", predictionErrorPx = null)
        val store = DiagnosticFrames(); val token = store.start(0)
        listOf(signal, unknown).forEachIndexed { i, s ->
            store.received(token); store.completed(token, (i + 1) * 1_000_000L, 1.0, 2.0, 3.0, 4.0, 11.0, s)
        }
        store.discardStale(token)
        val report = DiagnosticReport(0, "synthetic-test", "test", 29, "0.5.0", "model", "hash", .5f,
            store.stop(token, 1_000_000_000, false, null)!!, emptyList())
        val json = report.toJson()
        assertTrue(json.contains("\"capture_to_signal_ms\":150.0"))
        assertTrue(json.contains("\"capture_to_signal_ms\":null"))
        assertTrue(json.contains("\"application_stale_frames_discarded\":1"))
        assertTrue(json.contains("\"observed_pixel\":{\"x\":100,\"y\":200}"))
        println("TARGET_REPORT_FIXTURE=$json")
    }
}

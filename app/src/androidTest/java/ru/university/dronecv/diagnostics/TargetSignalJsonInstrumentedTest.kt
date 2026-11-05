package ru.university.dronecv.diagnostics

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.camera.*

@RunWith(AndroidJUnit4::class)
class TargetSignalJsonInstrumentedTest {
    @Test fun reportExportsRealClockBoundaryPixelCoordinatesAndUnknownClockAsNull() {
        val signal = TargetSignal(1, 2, FrameStamp(1_000_000_000, CaptureTimebase.ELAPSED_REALTIME, 1_010_000_000),
            1_150_000_000, 640, 480, 3, TargetStatus.OBSERVED, PixelPoint(100.0, 200.0), .9f,
            PixelVelocity(10.0, 0.0), emptyList(), listOf(ForecastPoint(200, PixelPoint(103.5, 200.0))),
            "quote\"\\\n", 2.0)
        val frame = FrameMeasurement(10, 1.0, 2.0, 3.0, 4.0, 11.0, signal)
        val report = DiagnosticReport(0, "device", "test", 29, "0.5.0", "model", "hash", .5f,
            DiagnosticFrameSnapshot(100, 1, 1, 0, false, null, listOf(frame), 2), emptyList())
        val json = JSONObject(report.toJson())
        val exported = json.getJSONArray("frames").getJSONObject(0).getJSONObject("target_signal")
        assertEquals(150.0, exported.getDouble("capture_to_signal_ms"), 0.0)
        assertEquals(1_000_000_000L, exported.getLong("capture_ns"))
        assertEquals(100.0, exported.getJSONObject("observed").getDouble("x"), 0.0)
        assertEquals(signal.predictionIssue, exported.getString("prediction_issue"))
        assertEquals(2L, json.getLong("application_stale_frames_discarded"))
        assertEquals(150.0, json.getJSONObject("timing_summary_ms").getJSONObject("capture_to_signal").getDouble("mean"), 0.0)
        val unknown = JSONObject(signal.copy(stamp = signal.stamp.copy(timebase = CaptureTimebase.UNKNOWN), forecast = emptyList()).toJson())
        assertTrue(unknown.isNull("capture_to_signal_ms"))
        assertEquals("unsynchronized_camera_clock", unknown.getString("timing_issue"))
    }
}

package ru.university.dronecv.diagnostics

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DiagnosticJsonInstrumentedTest {
    @Test fun reportIsValidJsonAndHasRealSampleValues() {
        val store = DiagnosticFrames(); val id = store.start(0)
        store.received(id); store.completed(id, 100, 1.0, 2.0, 3.0, 4.0, 11.0)
        val snapshot = store.stop(id, 1_000_000_000, true, "pause \"background\"")!!
        val report = DiagnosticReport(10, "device", "15", 35, "0.4.0", "model.onnx", "abc", .5f, snapshot,
            listOf(ResourceSample(0, 100, 1, 80, 2, 29.5), ResourceSample(10, 105, 2, 79, 2, 30.0)))
        val json = JSONObject(report.toJson())
        assertEquals(1, json.getInt("completed_frames"))
        assertEquals(5, json.getInt("pss_first_to_last_sample_delta_kb"))
        assertEquals("pause \"background\"", json.getString("reason"))
        assertTrue(json.isNull("camera_frames_dropped"))
        assertTrue(json.getJSONObject("timing_summary_ms").getJSONObject("ort_including_tensor_copy").isNull("p95_nearest_rank"))
        assertEquals(3.0, json.getJSONArray("frames").getJSONObject(0).getDouble("ort_ms"), 0.0)
    }
}

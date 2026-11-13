package ru.university.dronecv.timeline

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import ru.university.dronecv.diagnostics.DiagnosticFrames
import ru.university.dronecv.diagnostics.ResourceSample
import ru.university.dronecv.diagnostics.toTimelineJson
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.FrameKey
import ru.university.dronecv.tracking.TrackingObservation
import ru.university.dronecv.tracking.VisualPhase

class TimelineWriterTest {
    @Test fun finalRecordOutOfMemoryCannotMarkRecordingComplete() {
        val file = File.createTempFile("timeline-memory", ".ndjson")
        try {
            val issues = java.util.concurrent.CopyOnWriteArrayList<String>()
            var complete: Boolean? = null
            val writer = TimelineWriter(file, { 1L }, onIssue = { issues.add(it) },
                onClosed = { value, _ -> complete = value })
            writer.record("header", "{\"start_ns\":\"1\"}", 1)
            writer.finish(2, false, null, "diagnostic_report" to { throw OutOfMemoryError("synthetic") })
            writer.awaitFinished()
            assertEquals(false, complete)
            assertNotNull(writer.error())
            assertTrue(issues.isNotEmpty())
            val output = java.io.ByteArrayOutputStream(); writer.copyTo(output)
            assertTrue(output.toString("UTF-8").contains("recording_failure"))
            assertFalse(output.toString("UTF-8").contains("session_end"))
        } finally { file.delete() }
    }
    @Test fun mandatoryFinalRecordBypassesFullQueueAndSerializesOffCaller() {
        val file = File.createTempFile("timeline-final", ".ndjson")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            val caller = Thread.currentThread()
            val writer = TimelineWriter(file, { 1L }, capacity = 1, open = {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); it.outputStream()
            })
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            assertTrue(writer.record("header", "{\"start_ns\":\"1\"}", 1))
            writer.finish(2, false, null, "diagnostic_report" to {
                assertNotSame(caller, Thread.currentThread())
                "{\"camera_input\":{\"no_buffer_frames\":30}}"
            })
            release.countDown(); writer.awaitFinished()
            assertNull(writer.error())
            val lines = file.readLines()
            assertEquals(3, lines.size)
            assertTrue(lines[1].contains("\"type\":\"diagnostic_report\""))
            assertTrue(lines[2].contains("\"accepted_count\":\"2\""))
            assertTrue(lines[2].contains("\"written_count\":\"2\""))
            assertTrue(lines[2].contains("\"recording_complete\":true"))
        } finally { release.countDown(); file.delete() }
    }
    @Test fun longSessionIsStreamedAndRetainsBothEnds() {
        val file = File.createTempFile("timeline", ".ndjson")
        try {
            val writer = TimelineWriter(file, { 0L })
            val origin = 9_100_000_000_000_000L
            writer.record("header", "{\"start_ns\":\"$origin\",\"clock\":\"elapsed_realtime_ns\",\"mode\":\"yolo_lk\"}", origin)
            writer.record("metadata", "{\"geometry\":{\"width\":640,\"height\":480},\"calibration_image\":null}", origin)
            repeat(21_001) { i ->
                while (writer.queuedCount() > 2_000) Thread.yield()
                val time = origin + i * 90_000_000L
                writer.record("frame", "{\"frame_id\":\"$i\",\"analyzer_entry_ns\":\"$time\",\"capture_ns\":\"$time\",\"timebase\":\"elapsed_realtime\",\"marker\":null}", time)
                val box = if (i in 1 until 10_000 || i >= 15_000) "[0.1,0.2,0.3,0.4]" else "null"
                val reason = if (i == 10_000) "track_lost" else if (i == 15_000) "recovered" else "update"
                writer.record("state", "{\"publication_ns\":\"$time\",\"frame_id\":\"$i\",\"box\":$box,\"reason\":\"$reason\"}", time)
                writer.record("publication", "{\"frame_id\":\"$i\",\"published_ns\":\"$time\",\"bbox\":$box,\"source\":\"yolo\"}", time)
            }
            writer.finish(origin + 1_890_090_000_000L, false, null)
            writer.awaitFinished()
            assertNull(writer.error())
            if (System.getenv("DRONECV_TIMELINE_FIXTURE") != null) file.copyTo(File(System.getenv("DRONECV_TIMELINE_FIXTURE")), overwrite = true)
            val lines = file.useLines { it.toList() }
            assertEquals(63_006, lines.size)
            assertTrue(lines.first().contains("\"type\":\"header\""))
            assertTrue(lines.any { it.contains("\"frame_id\":\"10000\"") })
            assertTrue(lines.any { it.contains("\"frame_id\":\"21000\"") })
            assertTrue(lines.last().contains("\"recording_complete\":true"))
            assertTrue(lines.last().contains("\"accepted_count\":\"63005\""))
            val highWater = Regex("\"queue_high_water\":(\\d+)").find(lines.last())!!.groupValues[1].toInt()
            assertTrue(highWater <= 4096)
        } finally { file.delete() }
    }


    @Test fun diagnosticFramesProduceStreamingFixture() {
        val file = File.createTempFile("diagnostic-timeline", ".ndjson")
        try {
            val origin = 9_100_000_000_000_000L
            val writer = TimelineWriter(file, { origin })
            writer.record("header", "{\"start_ns\":\"$origin\",\"clock\":\"elapsed_realtime_ns\"}", origin)
            val frames = DiagnosticFrames()
            val token = frames.start(1000)
            frames.timeline = { type, payload, _ -> writer.record(type, payload, origin + 1) }
            frames.event(token, "state", "{\"publication_ns\":\"$origin\",\"box\":null,\"reason\":\"initial\"}", origin)
            frames.event(token, "frame_geometry", "{\"width\":640,\"height\":480}", origin + 1)
            frames.event(token, "stale_discard", "{\"reason\":\"stale_result\"}", origin + 2)
            val stamp = FrameStamp(origin, CaptureTimebase.ELAPSED_REALTIME, origin + 1)
            val observation = TrackingObservation(FrameKey(1, 1, 1), stamp, VisualPhase.SEARCHING,
                null, null, ClassConfirmation.NONE, null, null, null)
            frames.tracking(token, 1050, TrackingSignal(observation, TrackingSampleKind.FRAME, 640, 480, origin + 2, 0.0))
            frames.completed(token, 1100, 1.0, 2.0, 3.0, 4.0, 10.0, detectionCount = 0)
            writer.record("resource", "{\"offset_ns\":\"100\",\"pss_kb\":123}", origin + 3)
            frames.stop(token, 1200, false, null)
            writer.finish(origin + 200, false, null)
            writer.awaitFinished()
            assertNull(writer.error())
            val fixture = System.getenv("DRONECV_TIMELINE_FIXTURE")
            if (fixture != null) file.copyTo(File("$fixture-diagnostic.ndjson"), overwrite = true)
            assertTrue(file.readText().contains("\"type\":\"diagnostic_frame\""))
        } finally { file.delete() }
    }

    @Test fun blockedDiskDropsWithoutBlockingProducerAndReportsGap() {
        val file = File.createTempFile("timeline", ".ndjson")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            val writer = TimelineWriter(file, { 10L }, capacity = 1, open = {
                entered.countDown(); release.await(); it.outputStream()
            })
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            assertTrue(writer.record("header", "{}", 1))
            assertFalse(writer.record("state", "{}", 2))
            writer.finish(3, false, null)
            release.countDown(); writer.awaitFinished()
            val footer = file.readLines().last()
            assertTrue(footer.contains("\"recording_complete\":false"))
            assertTrue(footer.contains("\"dropped_count\":\"1\""))
            assertTrue(footer.contains("\"missing_first_event_id\":\"2\""))
            assertTrue(footer.contains("\"missing_first_ns\":\"2\""))
        } finally { release.countDown(); file.delete() }
    }


    @Test fun closeFailureInvalidatesExportedFooter() {
        val file = File.createTempFile("timeline", ".ndjson")
        try {
            val writer = TimelineWriter(file, { 1L }, open = { path ->
                object : java.io.FilterOutputStream(path.outputStream()) {
                    override fun close() { super.close(); throw IOException("close failed") }
                }
            })
            writer.record("header", "{\"start_ns\":\"1\"}", 1)
            writer.record("state", "{\"publication_ns\":\"1\",\"reason\":\"initial_snapshot\",\"box\":[0,0,1,1]}", 1)
            writer.record("resource", ResourceSample(1, 123, 2, 80, 3, 37.5).toTimelineJson(), 1)
            writer.record("resource", ResourceSample(2, null, null, null, null, null).toTimelineJson(), 1)
            writer.finish(2, false, null)
            val export = java.io.ByteArrayOutputStream()
            writer.copyTo(export)
            val text = export.toString("UTF-8")
            assertTrue(text.contains("\"recording_complete\":true"))
            assertTrue(text.contains("\"type\":\"recording_failure\""))
            assertTrue(text.contains("close failed"))
            assertFalse(text.contains("\n\n"))
            val exported = File.createTempFile("timeline-close-export", ".ndjson")
            try {
                exported.writeBytes(export.toByteArray())
                val script = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
                    .map { File(it, "ml/scripts/timeline_analysis.py") }.first { it.isFile }
                val python = """
                    import sys, json, hashlib
                    from pathlib import Path
                    sys.path.insert(0, sys.argv[1])
                    from timeline_analysis import read_timeline
                    p = Path(sys.argv[2])
                    result = read_timeline(p)
                    assert result['recording_complete'] is False, result
                    assert 'recording failure: close failed' in result['errors'], result
                    assert result['sha256'] == hashlib.sha256(p.read_bytes()).hexdigest()
                    assert all(not i['state_known'] and i['box'] is None for i in result['intervals'])
                    resources = [json.loads(line)['data'] for line in p.read_text().splitlines() if json.loads(line)['type'] == 'resource']
                    assert resources[0]['battery_status'] == 3 and resources[0]['battery_temperature_c'] == 37.5
                    assert resources[1]['battery_status'] is None and resources[1]['battery_temperature_c'] is None
                """.trimIndent()
                val process = ProcessBuilder("python3", "-c", python, script.parent, exported.path).redirectErrorStream(true).start()
                assertTrue("Python parser timed out", process.waitFor(10, TimeUnit.SECONDS))
                assertEquals(process.inputStream.bufferedReader().readText(), 0, process.exitValue())
            } finally { exported.delete() }
        } finally { file.delete() }
    }

    @Test fun diskFailureIsObservable() {
        val file = File.createTempFile("timeline", ".ndjson")
        try {
            val writer = TimelineWriter(file, { 1L }, open = { throw IOException("disk failed") })
            writer.finish(2, true, "error")
            writer.awaitFinished()
            assertEquals("disk failed", writer.error())
            assertFalse(file.readText().contains("session_end"))
        } finally { file.delete() }
    }
}

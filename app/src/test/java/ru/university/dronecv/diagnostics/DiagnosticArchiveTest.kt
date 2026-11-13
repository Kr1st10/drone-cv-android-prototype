package ru.university.dronecv.diagnostics

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.*
import ru.university.dronecv.journals.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

class DiagnosticArchiveTest {
    private val origin = 1_000_000_000L
    private fun session(store: JournalArchive, threads: Int, interrupted: Boolean = false): File {
        val lease = store.reserve(JournalKind.DIAGNOSTIC)
        val writer = lease.openWriter({ origin }, {})
        writer.record("header", """{"start_ns":"$origin","clock":"elapsed_realtime_ns","diagnostic_report_required":true,"started_epoch_ms":"123","device":"test-device","android_release":"16","android_sdk":36,"app_version":"test","build_type":"debug","warmup":{"method":"manual","completed_frames_before_session":37},"model_sha256":"abc","confidence":0.5,"intra_op_threads":$threads} """.trim(), origin)
        val frames = DiagnosticFrames()
        val token = frames.start(origin)
        frames.timeline = { type, data, _ -> writer.record(type, data, origin + 100_000_000L) }
        repeat(31) { frames.input(token, CameraInputEvent.RECEIVED) }
        frames.input(token, CameraInputEvent.COPIED, 4.0)
        repeat(30) { frames.input(token, CameraInputEvent.NO_BUFFER) }
        frames.input(token, CameraInputEvent.SUPERSEDED)
        frames.input(token, CameraInputEvent.STALE)
        frames.input(token, CameraInputEvent.INVALIDATED)
        frames.input(token, CameraInputEvent.ERROR)
        frames.received(token)
        val signal = TargetSignal(1, 1, FrameStamp(origin, CaptureTimebase.ELAPSED_REALTIME, origin+1),
            origin+2, 640, 480, TargetStatus.DETECTED, PixelPoint(100.0, 200.0), .8f)
        frames.completed(token, origin+100_000_000L, 4.0, 2.0, 3.0, 1.0, 10.0, signal, 1)
        val snapshot = frames.stop(token, origin+1_000_000_000L, interrupted, if (interrupted) "tab switch" else null)!!
        val report = DiagnosticReport(123, "test-device", "16", 36, "test", "model", "abc", .5f,
            snapshot, listOf(ResourceSample(1, 123, 0, 80, 3, 37.0)), threads, "debug", 37)
        writer.finishDiagnostic(report, origin+1_000_000_000L)
        writer.awaitFinished()
        assertNull(writer.error())
        assertEquals(JournalState.COMPLETE, store.inventory().entries.first { it.id == lease.file.name }.state)
        return lease.file
    }

    @Test fun archivedSessionSurvivesNewSessionAndOwnerAndIsAnalyzedByPythonAndJavascript() {
        val root = Files.createTempDirectory("diagnostic-archive").toFile()
        try {
            val store = JournalArchive(root)
            val files = listOf(1, 2, 4).map { session(store, it) }
            session(store, 2, interrupted = true)
            val restored = JournalArchive(root)
            val selected = files.map { source ->
                val bytes = ByteArrayOutputStream()
                restored.selectExport(source.name).copy({ bytes })
                File(root, "export-${source.name}").apply { writeBytes(bytes.toByteArray()) }
            }
            val interrupted = restored.inventory().entries.last { it.id !in files.map(File::getName) }
            val bytes = ByteArrayOutputStream()
            restored.selectExport(interrupted.id).copy({ bytes })
            val interruptedExport = File(root, "interrupted.ndjson").apply { writeBytes(bytes.toByteArray()) }
            val repository = generateSequence(File(checkNotNull(System.getProperty("user.dir")))) { it.parentFile }
                .first { File(it, "ml/scripts/analyze_android_sessions.py").isFile }
            val python = """
                import sys,json,subprocess
                from pathlib import Path
                sys.path.insert(0,sys.argv[1]+'/ml/scripts')
                from analyze_android_sessions import archived_diagnostic,analyze
                from timeline_analysis import read_timeline
                paths=list(map(Path,sys.argv[2:5]))
                for path in paths:
                    t=read_timeline(path); assert t['recording_complete'],t
                    d=archived_diagnostic(path,t)
                    c=d['camera_input']
                    assert c==dict(received_frames=31,copied_frames=1,superseded_frames=1,no_buffer_frames=30,stale_frames=1,invalidated_frames=1,copy_errors=1,copy_mean_ms=4.,copy_max_ms=4.,fps_session=31.),c
                    assert d['warmup']['completed_frames_before_session']==37
                    assert d['build_type']=='debug' and d['android_sdk']==36
                    assert abs(d['frames'][0]['target_signal']['confidence']-.8)<1e-6
                    assert d['frames'][0]['detection_count']==1
                    assert not analyze(d)['errors'],analyze(d)
                output=paths[0].parent/'performance.json'
                subprocess.run([sys.executable,sys.argv[1]+'/ml/scripts/analyze_android_sessions.py',*map(str,paths),'--compare-threads','--output',str(output)],check=True)
                r=json.loads(output.read_text()); assert set(r['thread_groups'])=={'1','2','4'} and not r['config_mismatches'],r
                interrupted=Path(sys.argv[5]); d=archived_diagnostic(interrupted,read_timeline(interrupted))
                assert d['interrupted'] and d['reason']=='tab switch' and d['camera_input']['no_buffer_frames']==30
            """.trimIndent()
            val process = ProcessBuilder(listOf("python3", "-c", python, repository.path)+selected.map(File::getPath)+interruptedExport.path)
                .redirectErrorStream(true).start()
            assertTrue(process.waitFor(20, TimeUnit.SECONDS))
            assertEquals(process.inputStream.bufferedReader().readText(), 0, process.exitValue())
            val javascript = """
                const fs=require('node:fs'), {timelineImporter}=require(process.argv[1]+'/lab/monitor_test/motion-report.js');
                for(const file of process.argv.slice(2)) {
                  const reader=timelineImporter();for(const line of fs.readFileSync(file,'utf8').trim().split('\n'))reader.push(JSON.parse(line));
                  if(!reader.finish().recording_complete)throw Error('incomplete Kotlin archive');
                }
            """.trimIndent()
            val node = ProcessBuilder(listOf("node", "-e", javascript, repository.path)+selected.map(File::getPath))
                .redirectErrorStream(true).start()
            assertTrue(node.waitFor(10, TimeUnit.SECONDS))
            assertEquals(node.inputStream.bufferedReader().readText(), 0, node.exitValue())
            System.getenv("DRONECV_DIAGNOSTIC_FIXTURE_DIR")?.let { path ->
                File(path).mkdirs()
                selected.forEachIndexed { i, f -> f.copyTo(File(path, "threads-${listOf(1,2,4)[i]}.ndjson"), true) }
            }
            assertTrue(restored.inventory().entries.filter { it.id in files.map(File::getName) }.all { it.exported })
        } finally { root.deleteRecursively() }
    }

    @Test fun finalReportBytesCountTowardQuotaAndSelectedExportPinsWholeRecord() {
        val root = Files.createTempDirectory("diagnostic-quota").toFile()
        try {
            val store = JournalArchive(root, JournalPolicy(maxRecords = 2, maxBytes = 1))
            val file = session(store, 2)
            assertTrue(store.inventory().overQuota)
            assertTrue(store.inventory().bytes >= file.length())
            val selected = store.selectExport(file.name)
            try { store.delete(file.name, true); fail("selected record deleted") } catch (_: IllegalStateException) { }
            try { store.reserve(JournalKind.DIAGNOSTIC); fail("quota ignored") } catch (_: JournalQuotaException) { }
            val output = ByteArrayOutputStream(); selected.copy({ output })
            assertArrayEquals(file.readBytes(), output.toByteArray())
            val next = store.reserve(JournalKind.DIAGNOSTIC)
            assertFalse(file.exists())
            next.close()
            assertTrue(JournalArchive(root).inventory().entries.isEmpty())
        } finally { root.deleteRecursively() }
    }

    @Test fun mandatoryReportSerializationFailureIsVisibleAndRecoveredAsIncomplete() {
        val root = Files.createTempDirectory("diagnostic-failure").toFile()
        try {
            val issues = java.util.concurrent.CopyOnWriteArrayList<String>()
            val store = JournalArchive(root)
            val lease = store.reserve(JournalKind.DIAGNOSTIC)
            val writer = lease.openWriter({ origin }, { issues.add(it) })
            writer.record("header", """{"start_ns":"$origin","diagnostic_report_required":true}""", origin)
            writer.finish(origin+1, false, null, "diagnostic_report" to { throw IllegalStateException("report failed") })
            writer.awaitFinished()
            assertEquals("report failed", writer.error())
            assertTrue(issues.any { it.contains("report failed") })
            val restored = JournalArchive(root)
            assertEquals(JournalState.INCOMPLETE_OR_UNKNOWN, restored.inventory().entries.single().state)
            val bytes = ByteArrayOutputStream(); restored.selectExport(lease.file.name).copy({ bytes })
            assertTrue(bytes.toString("UTF-8").contains("recording_failure"))
            assertFalse(bytes.toString("UTF-8").contains("session_end"))
        } finally { root.deleteRecursively() }
    }
}

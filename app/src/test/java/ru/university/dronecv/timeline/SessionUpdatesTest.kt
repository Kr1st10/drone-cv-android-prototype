package ru.university.dronecv.timeline

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.diagnostics.DiagnosticUi
import ru.university.dronecv.diagnostics.DiagnosticFrames
import ru.university.dronecv.diagnostics.DiagnosticReport
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

class SessionUpdatesTest {
    @Test fun issueRetriesAfterStopAndCannotRestoreRecordingOrEraseReport() {
        race(false)
    }

    @Test fun lateIssueCannotModifyNewSession() {
        race(true)
    }

    private fun race(newSession: Boolean) {
        val frames = DiagnosticFrames()
        val token = frames.start(1)
        val report = DiagnosticReport(0, "synthetic", "test", 35, "test", "test", "test", .5f,
            checkNotNull(frames.stop(token, 2, false, null)), emptyList())
        val ui = MutableStateFlow(DiagnosticUi(recording = true, sessionId = "old"))
        val read = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val task = executor.submit {
                ui.updateForSession("old", { it.sessionId }) {
                    read.countDown()
                    check(release.await(2, TimeUnit.SECONDS))
                    it.copy(recordingIssue = "disk failed")
                }
            }
            assertTrue(read.await(2, TimeUnit.SECONDS))
            // Stop publishes its result while the issue transform holds an old snapshot.
            ui.update { it.copy(recording = false, report = report) }
            if (newSession) ui.value = DiagnosticUi(recording = true, sessionId = "new")
            release.countDown()
            task.get(2, TimeUnit.SECONDS)
            if (newSession) {
                assertTrue(ui.value.recording)
                assertNull(ui.value.recordingIssue)
                assertEquals("new", ui.value.sessionId)
            } else {
                assertFalse(ui.value.recording)
                assertSame(report, ui.value.report)
                assertEquals("disk failed", ui.value.recordingIssue)
                repeat(2) {
                    ui.updateForSession("old", { it.sessionId }) { it.copy(exportStatus = "Сохранение…") }
                    ui.updateForSession("old", { it.sessionId }) { it.copy(exportStatus = "Отчёт сохранён") }
                    assertEquals("disk failed", ui.value.recordingIssue)
                    assertEquals("Отчёт сохранён", ui.value.exportStatus)
                }
            }
        } finally { release.countDown(); executor.shutdownNow() }
    }
}

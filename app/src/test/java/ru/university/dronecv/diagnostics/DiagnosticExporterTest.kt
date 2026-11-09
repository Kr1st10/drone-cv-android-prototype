package ru.university.dronecv.diagnostics

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.ContinuationInterceptor

@OptIn(ExperimentalCoroutinesApi::class)
class DiagnosticExporterTest {
    private fun report(id: Long) = DiagnosticReport(id, "device", "15", 35, "version", "model", "hash", .5f,
        DiagnosticFrameSnapshot(1, 0, 0, 0, false, null, emptyList()), emptyList())

    @Test fun staleCompletionPreservesRecordingAndWritesOriginalReport() = runTest {
        val lock = Any()
        val io = StandardTestDispatcher(testScheduler, "export-io")
        var ui = DiagnosticUi(report = report(1))
        val gate = CompletableDeferred<Unit>()
        var file = ""
        val exporter = DiagnosticExporter<String>(lock, backgroundScope, io, { ui.report },
            { ui = ui.copy(exportStatus = it) }, { saved, _ ->
                assertFalse(Thread.holdsLock(lock))
                assertSame(io, currentCoroutineContext()[ContinuationInterceptor])
                gate.await()
                file = saved.toJson()
            })
        exporter.export("a")
        runCurrent()
        synchronized(lock) { ui = DiagnosticUi(recording = true) }
        gate.complete(Unit)
        runCurrent()
        assertTrue(ui.recording)
        assertNull(ui.report)
        assertNull(ui.exportStatus)
        assertTrue(file.contains("\"started_epoch_ms\":1"))
    }

    @Test fun staleSuccessAndFailureCannotChangeCompletedNewReport() = runTest {
        for (fail in listOf(false, true)) {
            val lock = Any()
            val io = StandardTestDispatcher(testScheduler)
            var ui = DiagnosticUi(report = report(1))
            val gate = CompletableDeferred<Unit>()
            val exporter = DiagnosticExporter<String>(lock, backgroundScope, io, { ui.report },
                { ui = ui.copy(exportStatus = it) }, { _, _ ->
                    gate.await()
                    if (fail) error("write failed")
                })
            exporter.export("a")
            runCurrent()
            val b = report(2)
            synchronized(lock) { ui = DiagnosticUi(recording = true); ui = DiagnosticUi(report = b) }
            gate.complete(Unit)
            runCurrent()
            assertSame(b, ui.report)
            assertFalse(ui.recording)
            assertNull(ui.exportStatus)
        }
    }

    @Test fun latestRequestOwnsStatusRegardlessOfCompletionOrder() = runTest {
        val lock = Any()
        val io = StandardTestDispatcher(testScheduler)
        var ui = DiagnosticUi(report = report(1))
        val first = CompletableDeferred<Unit>()
        val second = CompletableDeferred<Unit>()
        val exporter = DiagnosticExporter<Int>(lock, backgroundScope, io, { ui.report },
            { ui = ui.copy(exportStatus = it) }, { _, destination ->
                if (destination == 1) first.await() else { second.await(); error("disk") }
            })
        exporter.export(1)
        exporter.export(2)
        runCurrent()
        first.complete(Unit)
        runCurrent()
        assertEquals("Сохранение…", ui.exportStatus)
        second.complete(Unit)
        runCurrent()
        assertEquals("Ошибка экспорта: disk", ui.exportStatus)
    }

    @Test fun lateFailureCannotOverwriteNewerSuccessOrActiveRecording() = runTest {
        val lock = Any()
        val io = StandardTestDispatcher(testScheduler)
        var ui = DiagnosticUi(report = report(1))
        val gate = CompletableDeferred<Unit>()
        val exporter = DiagnosticExporter<Int>(lock, backgroundScope, io, { ui.report },
            { ui = ui.copy(exportStatus = it) }, { _, destination ->
                if (destination == 1) { gate.await(); error("old failure") }
            })
        exporter.export(1)
        exporter.export(2)
        runCurrent()
        assertEquals("Отчёт сохранён", ui.exportStatus)
        gate.complete(Unit)
        runCurrent()
        assertEquals("Отчёт сохранён", ui.exportStatus)

        val nextGate = CompletableDeferred<Unit>()
        val next = DiagnosticExporter<Int>(lock, backgroundScope, io, { ui.report },
            { ui = ui.copy(exportStatus = it) }, { _, _ -> nextGate.await(); error("old failure") })
        next.export(3)
        runCurrent()
        synchronized(lock) { ui = DiagnosticUi(recording = true) }
        nextGate.complete(Unit)
        runCurrent()
        assertTrue(ui.recording)
        assertNull(ui.exportStatus)
    }
}

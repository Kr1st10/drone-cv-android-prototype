package ru.university.dronecv.journals

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.timeline.TimelineWriter
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterOutputStream
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class JournalArchiveTest {
    private fun root(): File = Files.createTempDirectory("journal-archive").toFile()
    private fun finish(store: JournalArchive, kind: JournalKind = JournalKind.DIAGNOSTIC,
                       open: (File) -> java.io.OutputStream = { it.outputStream() }): File {
        val lease = store.reserve(kind)
        val writer = lease.openWriter({ 100L }, {}, open)
        writer.record("header", "{\"start_ns\":\"100\",\"clock\":\"elapsed_realtime_ns\"}", 100)
        writer.record("state", "{\"publication_ns\":\"100\",\"box\":null,\"reason\":\"initial_snapshot\"}", 100)
        writer.finish(200, false, null); writer.awaitFinished()
        return lease.file
    }
    private fun export(store: JournalArchive, file: File): ByteArray {
        val output = ByteArrayOutputStream()
        store.selectExport(file.name).copy({ output })
        return output.toByteArray()
    }
    private inline fun rejected(action: () -> Unit) {
        try { action(); fail("Operation should be refused") } catch (_: IllegalStateException) { }
    }

    @Test fun discoversLegacyBothKindsAndIgnoresUnrelatedFiles() {
        val root = root()
        try {
            val first = File(root, "diagnostic-legacy.ndjson").apply { writeText("broken\n") }
            val second = File(root, "motion-legacy.ndjson").apply { writeText("{\"type\":\"header\"}\n") }
            val foreign = File(root, "model.onnx").apply { writeText("keep") }
            val wrongSuffix = File(root, "diagnostic-note.txt").apply { writeText("keep") }
            val store = JournalArchive(root)
            val entries = store.inventory().entries
            assertEquals(setOf(first.name, second.name), entries.map { it.id }.toSet())
            assertEquals(setOf(JournalKind.DIAGNOSTIC, JournalKind.MOTION), entries.map { it.kind }.toSet())
            assertTrue(entries.all { !it.exported && it.state == JournalState.INCOMPLETE_OR_UNKNOWN })
            assertEquals(first.length()+second.length(),store.inventory().bytes)
            assertArrayEquals(first.readBytes(), export(store,first))
            assertEquals(JournalState.INCOMPLETE_OR_UNKNOWN, JournalArchive(root).inventory().entries.first { it.id==first.name }.state)
            rejected { store.delete(second.name, false) }
            assertTrue(store.delete(second.name,true))
            assertEquals("keep", foreign.readText()); assertEquals("keep",wrongSuffix.readText())
            assertEquals(1, JournalArchive(root).inventory().entries.size)
        } finally { root.deleteRecursively() }
    }

    @Test fun repeatedSessionsRestoreStableIdentityAndExportOnlySelectedBytes() {
        val root = root()
        try {
            val store=JournalArchive(root)
            val first=finish(store)
            val selected=store.selectExport(first.name)
            val second=finish(store, JournalKind.MOTION)
            val output=ByteArrayOutputStream()
            selected.copy({output})
            assertArrayEquals(first.readBytes(),output.toByteArray())
            val restored=JournalArchive(root).inventory()
            assertEquals(2,restored.entries.size)
            assertTrue(restored.entries.all { it.state==JournalState.COMPLETE && it.createdEpochMs != null })
            assertTrue(restored.entries.first { it.id==first.name }.exported)
            assertFalse(restored.entries.first { it.id==second.name }.exported)
        } finally {root.deleteRecursively()}
    }

    @Test fun countAdmissionDeletesOnlyOldestCompletedExportedUnusedFile() {
        val root=root()
        try {
            var time=1L
            val store=JournalArchive(root,JournalPolicy(maxRecords=3),{time++})
            val unexported=finish(store)
            val oldest=finish(store,JournalKind.MOTION); export(store,oldest)
            val newer=finish(store); export(store,newer)
            val next=store.reserve(JournalKind.MOTION)
            assertTrue(unexported.isFile); assertFalse(oldest.exists()); assertTrue(newer.isFile)
            assertEquals(3,store.inventory().entries.size)
            next.close()
            assertFalse(next.file.exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun countQuotaPreservesUnexportedAndLegacyFilesWithoutStartingWriter() {
        val root=root()
        try {
            val store=JournalArchive(root,JournalPolicy(maxRecords=1))
            val first=finish(store)
            val original=first.readBytes()
            rejected { store.reserve(JournalKind.MOTION) }
            assertArrayEquals(original,first.readBytes())
            assertEquals(1,store.inventory().entries.size)
            assertFalse(store.inventory().entries.single().inUse)
            assertTrue(store.delete(first.name,true))
            val old=File(root,"motion-old.ndjson").apply {writeText("partial")}
            export(store,old)
            rejected { store.reserve(JournalKind.DIAGNOSTIC) }
            assertEquals("partial",old.readText())
        } finally {root.deleteRecursively()}
    }

    @Test fun activeSessionMayCrossByteLimitAndOnlyNextAdmissionIsRefused() {
        val root=root()
        try {
            val store=JournalArchive(root,JournalPolicy(maxBytes=1))
            val lease=store.reserve(JournalKind.MOTION)
            val writer=lease.openWriter({100L},{})
            writer.record("header","{}",100)
            // Closing the writer proves the whole stream was accepted despite a one-byte admission limit.
            writer.record("state","{\"publication_ns\":\"150\",\"box\":null}",150)
            writer.finish(200,false,null); writer.awaitFinished()
            assertTrue(store.inventory().overQuota)
            assertTrue(lease.file.readText().contains("\"type\":\"session_end\""))
            assertTrue(lease.file.readText().contains("\"type\":\"state\""))
            rejected {store.reserve(JournalKind.DIAGNOSTIC)}
            export(store,lease.file)
            val next=store.reserve(JournalKind.DIAGNOSTIC)
            assertFalse(lease.file.exists()); next.close()
        } finally {root.deleteRecursively()}
    }

    @Test fun recordingAndFinishingRemainProtectedUntilOutputClosed() {
        val root=root(); val closing=CountDownLatch(1); val release=CountDownLatch(1)
        try {
            val store=JournalArchive(root,JournalPolicy(maxRecords=1))
            val lease=store.reserve(JournalKind.DIAGNOSTIC)
            val writer=lease.openWriter({100L},{}, {file -> object:FilterOutputStream(file.outputStream()) {
                override fun close() { closing.countDown(); check(release.await(5,TimeUnit.SECONDS)); super.close() }
            }})
            assertEquals(JournalState.RECORDING,store.inventory().entries.single().state)
            rejected {store.delete(lease.file.name,true)}
            rejected {store.selectExport(lease.file.name)}
            writer.record("header","{}",100); writer.finish(200,false,null)
            assertTrue(closing.await(2,TimeUnit.SECONDS))
            assertEquals(JournalState.FINISHING,store.inventory().entries.single().state)
            rejected {store.delete(lease.file.name,true)}
            rejected {store.reserve(JournalKind.MOTION)}
            rejected {store.selectExport(lease.file.name)}
            lease.close() // A caller cannot release an attached writer's protection.
            assertTrue(lease.file.exists())
            release.countDown(); writer.awaitFinished()
            assertEquals(JournalState.COMPLETE,store.inventory().entries.single().state)
            assertTrue(store.delete(lease.file.name,true))
        } finally {release.countDown(); root.deleteRecursively()}
    }

    @Test fun pickerCancellationIsIdempotentAndProcessRestartDoesNotRestorePins() {
        val root=root()
        try {
            val store=JournalArchive(root,JournalPolicy(maxRecords=1))
            val first=finish(store); export(store,first)
            val lease=store.selectExport(first.name)
            rejected {store.reserve(JournalKind.MOTION)}
            rejected {store.delete(first.name,true)}
            assertFalse(JournalArchive(root).inventory().entries.single().inUse)
            lease.close(); lease.close()
            val next=store.reserve(JournalKind.MOTION)
            assertFalse(first.exists()); next.close()
        } finally {root.deleteRecursively()}
    }

    @Test fun failedAndCancelledExportsNeverSetSuccessAndReleasePinForRetry() {
        val root=root()
        try {
            val store=JournalArchive(root)
            val file=finish(store)
            for (failure in listOf("open","write","close","cancel")) {
                var outputClosed=false
                try {
                    store.selectExport(file.name).copy({
                        if(failure=="open") throw IOException("open")
                        object:ByteArrayOutputStream() {
                            override fun write(b:ByteArray, off:Int, len:Int) {
                                if(failure=="write") throw IOException("write")
                                super.write(b,off,len)
                            }
                            override fun close() { outputClosed=true; if(failure=="close") throw IOException("close") }
                        }
                    },{ if(failure=="cancel") throw CancellationException("cancel") })
                    fail("Expected $failure failure")
                } catch (_:IOException) { } catch (_:CancellationException) { }
                assertTrue(file.isFile)
                val entry=store.inventory().entries.single()
                assertFalse(entry.exported); assertFalse(entry.inUse)
                assertEquals(failure!="open",outputClosed)
                assertFalse(JournalArchive(root).inventory().entries.single().exported)
            }
            export(store,file)
            assertTrue(JournalArchive(root).inventory().entries.single().exported)
        } finally {root.deleteRecursively()}
    }

    @Test fun leaseIsHeldThroughCopyAndOutputCloseEvenIfCallerCancelsSelection() {
        val root=root(); val closing=CountDownLatch(1);val release=CountDownLatch(1)
        val pool=Executors.newSingleThreadExecutor()
        try {
            val store=JournalArchive(root,JournalPolicy(maxRecords=1))
            val file=finish(store); export(store,file)
            val selected=store.selectExport(file.name)
            val copy=pool.submit {selected.copy({object:ByteArrayOutputStream() {
                override fun close() {closing.countDown(); check(release.await(5,TimeUnit.SECONDS)); super.close()}
            }})}
            assertTrue(closing.await(2,TimeUnit.SECONDS))
            selected.close()
            assertTrue(store.inventory().entries.single().inUse)
            rejected {store.delete(file.name,true)}
            rejected {store.reserve(JournalKind.MOTION)}
            release.countDown(); copy.get(2,TimeUnit.SECONDS)
            assertFalse(store.inventory().entries.single().inUse)
            assertTrue(store.delete(file.name,false))
        } finally {release.countDown();pool.shutdownNow();root.deleteRecursively()}
    }

    @Test fun successIsNotPersistedUntilOutputCloseReturns() {
        val root=root();val closing=CountDownLatch(1);val release=CountDownLatch(1)
        val pool=Executors.newSingleThreadExecutor()
        try {
            val store=JournalArchive(root)
            val file=finish(store)
            val selected=store.selectExport(file.name)
            val copy=pool.submit {selected.copy({object:ByteArrayOutputStream() {
                override fun close() {closing.countDown();check(release.await(5,TimeUnit.SECONDS));super.close()}
            }})}
            assertTrue(closing.await(2,TimeUnit.SECONDS))
            assertFalse(store.inventory().entries.single().exported)
            assertFalse(JournalArchive(root).inventory().entries.single().exported)
            release.countDown();copy.get(2,TimeUnit.SECONDS)
            assertTrue(store.inventory().entries.single().exported)
            assertTrue(JournalArchive(root).inventory().entries.single().exported)
        } finally {release.countDown();pool.shutdownNow();root.deleteRecursively()}
    }

    @Test fun concurrentDiagnosticAndMotionAdmissionShareOneSlot() {
        val root=root(); val start=CountDownLatch(1);val pool=Executors.newFixedThreadPool(2)
        try {
            val store=JournalArchive(root,JournalPolicy(maxRecords=1))
            val tasks=JournalKind.entries.map {kind -> pool.submit<JournalArchive.Recording?> {
                check(start.await(2,TimeUnit.SECONDS))
                try {store.reserve(kind)} catch (_:JournalQuotaException) {null}
            }}
            start.countDown()
            val results=tasks.map {it.get(2,TimeUnit.SECONDS)}
            assertEquals(1,results.count {it!=null})
            assertEquals(1,store.inventory().entries.size)
            results.filterNotNull().forEach {it.close()}
        } finally {start.countDown();pool.shutdownNow();root.deleteRecursively()}
    }

    @Test fun writerCloseFailureSurvivesRestartAndArchiveExportPreservesFailureRecord() {
        val root=root()
        try {
            val store=JournalArchive(root)
            val file=finish(store,open={ path -> object:FilterOutputStream(path.outputStream()) {
                override fun close() {super.close();throw IOException("close failed")}
            }})
            assertFalse(file.readText().contains("recording_failure"))
            assertTrue(file.readText().contains("\"recording_complete\":true"))
            val restored=JournalArchive(root)
            assertEquals(JournalState.INCOMPLETE_OR_UNKNOWN,restored.inventory().entries.single().state)
            val first=export(restored,file).toString(Charsets.UTF_8)
            assertTrue(first.contains("\"type\":\"recording_failure\""))
            assertTrue(first.contains("close failed"))
            assertFalse(first.contains("\n\n"))
            val reloaded=JournalArchive(root)
            assertTrue(reloaded.inventory().entries.single().exported)
            assertArrayEquals(first.toByteArray(),export(reloaded,file))
            assertEquals(JournalState.INCOMPLETE_OR_UNKNOWN,reloaded.inventory().entries.single().state)
            rejected {JournalArchive(root,JournalPolicy(maxRecords=1)).reserve(JournalKind.MOTION)}
            assertTrue(file.exists())
        } finally {root.deleteRecursively()}
    }

    @Test fun earlyWriterFailureKeepsActivePinUntilSessionStopWithoutResurrectingIt() {
        val root=root()
        try {
            val store=JournalArchive(root)
            val lease=store.reserve(JournalKind.MOTION)
            val writer=lease.openWriter({100L},{},{throw IOException("open failed")})
            writer.awaitFinished()
            assertEquals(JournalState.RECORDING,store.inventory().entries.single().state)
            rejected {store.delete(lease.file.name,true)}
            writer.finish(200,true,"failed")
            assertFalse(store.inventory().entries.single().inUse)
            export(store,lease.file)
            assertEquals(JournalState.INCOMPLETE_OR_UNKNOWN,store.inventory().entries.single().state)
        } finally {root.deleteRecursively()}
    }

    @Test fun changedFileInvalidatesCompletenessAndExportProof() {
        val root=root()
        try {
            val store=JournalArchive(root)
            val file=finish(store); export(store,file)
            file.appendText("broken\n")
            val entry=JournalArchive(root).inventory().entries.single()
            assertFalse(entry.exported);assertEquals(JournalState.INCOMPLETE_OR_UNKNOWN,entry.state)
        } finally {root.deleteRecursively()}
    }

    @Test fun managedMotionRefusesUnreservedOrCancelledStartsAndReleasesUnusedFiles() {
        val root=root()
        try {
            val store=JournalArchive(root)
            val journal=ru.university.dronecv.motion.MotionJournal({100L},requiresReservation=true)
            journal.start()
            assertFalse(journal.ui.value.recording)
            assertNull(journal.token())
            val ticket=journal.preparationToken()
            val unused=store.reserve(JournalKind.MOTION)
            journal.stop("Camera paused during admission")
            assertFalse(journal.prepareRecording(unused,ticket))
            unused.close()
            assertTrue(store.inventory().entries.isEmpty())
            val selected=store.reserve(JournalKind.MOTION)
            assertTrue(journal.prepareRecording(selected,journal.preparationToken()))
            journal.start()
            assertTrue(journal.ui.value.recording)
            assertEquals(JournalState.RECORDING,store.inventory().entries.single().state)
            journal.stop()
            // Archive export is allowed only once the real writer has closed.
            // The writer is available through this compatibility wait helper, not an arbitrary sleep.
            journal.awaitFinished(selected.file)
            assertEquals(JournalState.COMPLETE,store.inventory().entries.single().state)
        } finally {root.deleteRecursively()}
    }

    @Test fun recoveryRemovesOnlyOrphanedServiceFiles() {
        val root=root()
        try {
            val service=File(root,"journal-metadata").apply {mkdir()}
            val orphan=File(service,"diagnostic-orphan.ndjson.properties").apply {writeText("partial")}
            val crashed=File(service,"motion-old.ndjson.tmp").apply {writeText("partial")}
            val foreign=File(service,"keep.txt").apply {writeText("keep")}
            val journal=File(root,"motion-old.ndjson").apply {writeText("partial NDJSON")}
            val store=JournalArchive(root)
            assertEquals(1,store.inventory().entries.size)
            assertFalse(orphan.exists());assertFalse(crashed.exists())
            assertEquals("keep",foreign.readText())
            assertEquals("partial NDJSON",journal.readText())
        } finally {root.deleteRecursively()}
    }

    @Test fun unusedReservationCancellationAndInvalidIdentifiersTouchNoOtherFiles() {
        val root=root()
        try {
            val store=JournalArchive(root)
            val foreign=File(root,"notes.txt").apply {writeText("keep")}
            val reservation=store.reserve(JournalKind.MOTION)
            reservation.close();reservation.close()
            assertTrue(store.inventory().entries.isEmpty())
            for(id in listOf("../notes.txt","notes.txt","diagnostic-a.ndjson/../notes.txt")) {
                try {store.delete(id,true);fail("Invalid ID accepted")} catch (_:IllegalArgumentException) { }
            }
            assertEquals("keep",foreign.readText())
        } finally {root.deleteRecursively()}
    }
}

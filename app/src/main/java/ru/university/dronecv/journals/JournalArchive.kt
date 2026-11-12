package ru.university.dronecv.journals

import ru.university.dronecv.timeline.TimelineWriter
import java.io.Closeable
import java.io.File
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Properties
import java.util.UUID

/** Admission limits shared by diagnostics and motion. An admitted file may grow beyond maxBytes. */
data class JournalPolicy(val maxRecords: Int = 30, val maxBytes: Long = 512L * 1024 * 1024) {
    init { require(maxRecords > 0 && maxBytes > 0) }
}

enum class JournalKind(val prefix: String) { DIAGNOSTIC("diagnostic"), MOTION("motion") }
enum class JournalState { RECORDING, FINISHING, COMPLETE, INCOMPLETE_OR_UNKNOWN }

data class JournalEntry(val id: String, val kind: JournalKind, val bytes: Long, val createdEpochMs: Long?,
                        val state: JournalState, val exported: Boolean, val inUse: Boolean)
data class JournalInventory(val entries: List<JournalEntry>, val bytes: Long, val overQuota: Boolean)
class JournalQuotaException : IllegalStateException("Недостаточно места в архиве журналов. Откройте «Журналы», экспортируйте или удалите старые записи.")

/** Process-wide owner of private journal files. Call disk methods only on an IO worker.
 *
 * IDs are root-level filenames, never UI tokens or NDJSON session IDs. Reservations,
 * export leases and deletion share one monitor. No frame callback accesses this store.
 * Legacy files without trustworthy service metadata remain visible with unknown status.
 */
class JournalArchive(private val root: File, val policy: JournalPolicy = JournalPolicy(),
                     private val epochMillis: () -> Long = System::currentTimeMillis) {
    private val metadata = File(root, "journal-metadata")
    private val recordings = java.util.concurrent.ConcurrentHashMap<String, JournalState>()
    private val exports = java.util.concurrent.ConcurrentHashMap<String, Int>()
    private val name = Regex("(diagnostic|motion)-[A-Za-z0-9_-]+\\.ndjson")

    @Synchronized fun inventory(): JournalInventory {
        cleanupMetadata()
        val entries = files().map(::entry).sortedWith(compareBy({ it.createdEpochMs ?: Long.MAX_VALUE }, { it.id }))
        val bytes = entries.sumOf { it.bytes + if (Files.isSymbolicLink(metadata.toPath())) 0 else File(metadata, "${it.id}.properties").length() }
        return JournalInventory(entries, bytes, entries.size >= policy.maxRecords || bytes >= policy.maxBytes)
    }

    /** Atomically evict eligible oldest files and reserve one new slot, or preserve data and refuse. */
    @Synchronized fun reserve(kind: JournalKind): Recording {
        var inventory = inventory()
        val candidates = inventory.entries.filter { it.state == JournalState.COMPLETE && it.exported && !it.inUse }
        for (candidate in candidates) {
            if (inventory.entries.size < policy.maxRecords && inventory.bytes < policy.maxBytes) break
            delete(candidate.id, allowUnexported = false)
            inventory = inventory()
        }
        if (inventory.entries.size >= policy.maxRecords || inventory.bytes >= policy.maxBytes) throw JournalQuotaException()
        check(root.isDirectory || root.mkdirs()) { "Cannot create journal directory" }
        val file = File(root, "${kind.prefix}-${UUID.randomUUID()}.ndjson")
        check(file.createNewFile()) { "Journal already exists" }
        recordings[file.name] = JournalState.RECORDING
        try {
            save(file.name, Properties().apply { setProperty("created_ms", epochMillis().toString()) })
        } catch (e: Exception) {
            recordings.remove(file.name); file.delete(); throw e
        }
        return Recording(file)
    }

    /** Refuse active, finalizing or selected/copying files. Explicit confirmation is checked here too. */
    @Synchronized fun delete(id: String, allowUnexported: Boolean): Boolean {
        val file = file(id)
        if (!file.isFile) return false
        check(!inUse(id)) { "Журнал используется; дождитесь завершения записи или экспорта" }
        check(allowUnexported || entry(file).exported) { "Нужно подтверждение удаления неэкспортированного журнала" }
        check(file.delete()) { "Не удалось удалить журнал" }
        removeMetadata(id)
        return true
    }

    /** Pin before opening the system picker; the same lease survives picker, copy and close. */
    @Synchronized fun selectExport(id: String): Export {
        val file = file(id)
        check(file.isFile) { "Журнал не найден" }
        check(!recordings.containsKey(id)) { "Дождитесь завершения записи" }
        exports.compute(id) { _, count -> (count ?: 0) + 1 }
        return Export(file, load(id).getProperty("failure_record"))
    }

    inner class Recording internal constructor(val file: File) : Closeable {
        @Volatile private var attached = false
        @Volatile private var finalized = false
        @Volatile private var finishing = false
        /** Transfer the reservation to a writer; constructor does not perform file IO on the caller. */
        fun openWriter(clock: () -> Long, onIssue: (String) -> Unit,
                       open: (File) -> OutputStream = { it.outputStream() }): TimelineWriter = synchronized(this) {
            check(!attached && recordings.containsKey(file.name))
            attached = true
            TimelineWriter(file, clock, open = open, onIssue = onIssue,
                onFinishing = {
                    finishing = true
                    if (finalized) recordings.remove(file.name)
                    else recordings.computeIfPresent(file.name) { _, _ -> JournalState.FINISHING }
                },
                onClosed = { complete, failureRecord ->
                    synchronized(this@JournalArchive) {
                        try {
                            val props = load(file.name)
                            props.setProperty("complete", complete.toString())
                            props.setProperty("size", file.length().toString())
                            props.setProperty("modified_ms", file.lastModified().toString())
                            failureRecord?.let { props.setProperty("failure_record", it) }
                            save(file.name, props)
                        } catch (e: Exception) {
                            // Never allow eviction if finalization metadata could not be persisted.
                            onIssue("Не удалось сохранить состояние архива: ${e.message}")
                        } finally { finalized = true; if (finishing) recordings.remove(file.name) }
                    }
                })
        }
        /** Release an unused reservation on cancellation/refused activation, never an attached writer. IO only. */
        override fun close() = synchronized(this) { synchronized(this@JournalArchive) {
            if (!attached && recordings.remove(file.name) != null) {
                file.delete(); removeMetadata(file.name)
            }
        } }
    }

    inner class Export internal constructor(private val file: File, private val failureRecord: String?) : Closeable {
        val id: String get() = file.name
        private var closed = false
        private var copying = false
        /** Blocking IO; success is persisted only after copy AND successful output close.
         * Cancellation checks must throw; every failure releases the lease and retains the source.
         */
        fun copy(openOutput: () -> OutputStream, checkCancelled: () -> Unit = {}) {
            synchronized(this) { check(!closed && !copying); copying = true }
            try {
                openOutput().use { output ->
                    var lastByte = -1
                    file.inputStream().use { input ->
                        val buffer = ByteArray(8192)
                        while (true) {
                            checkCancelled()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            if (count > 0) lastByte = buffer[count - 1].toInt()
                        }
                    }
                    failureRecord?.let {
                        if (lastByte != -1 && lastByte != 10) output.write('\n'.code)
                        output.write(it.toByteArray(Charsets.UTF_8))
                    }
                    checkCancelled()
                }
                checkCancelled()
                synchronized(this@JournalArchive) {
                    val props = load(id)
                    props.setProperty("exported", "true")
                    props.setProperty("export_size", file.length().toString())
                    props.setProperty("export_modified_ms", file.lastModified().toString())
                    save(id, props)
                }
            } finally {
                synchronized(this) { copying = false; release() }
            }
        }
        /** Picker cancellation is memory-only. A copy owns its pin until its own finally block. */
        override fun close() = synchronized(this) { if (!copying) release() }
        private fun release() {
            if (closed) return
            closed = true
            exports.computeIfPresent(id) { _, count -> (count - 1).takeIf { it > 0 } }
        }
    }

    private fun removeMetadata(id: String) {
        if (Files.isSymbolicLink(metadata.toPath())) return
        File(metadata, "$id.properties").delete()
        File(metadata, "$id.tmp").delete()
    }
    private fun cleanupMetadata() {
        if (!metadata.isDirectory || Files.isSymbolicLink(metadata.toPath())) return
        metadata.listFiles()?.forEach { service ->
            val id = when {
                service.name.endsWith(".properties") -> service.name.removeSuffix(".properties")
                service.name.endsWith(".tmp") -> service.name.removeSuffix(".tmp")
                else -> return@forEach
            }
            if (name.matches(id) && service.isFile &&
                (service.name.endsWith(".tmp") || !File(root, id).exists())) service.delete()
        }
    }
    private fun files(): List<File> = root.listFiles()?.filter {
        name.matches(it.name) && it.isFile && !Files.isSymbolicLink(it.toPath())
    }.orEmpty()
    private fun file(id: String): File {
        require(name.matches(id)) { "Invalid journal ID" }
        return File(root, id).also { require(!Files.isSymbolicLink(it.toPath())) }
    }
    private fun inUse(id: String) = recordings.containsKey(id) || (exports[id] ?: 0) > 0
    private fun entry(file: File): JournalEntry {
        val props = load(file.name)
        val unchanged = props.getProperty("size") == file.length().toString() &&
            props.getProperty("modified_ms") == file.lastModified().toString()
        val exported = props.getProperty("exported") == "true" &&
            props.getProperty("export_size") == file.length().toString() &&
            props.getProperty("export_modified_ms") == file.lastModified().toString()
        return JournalEntry(file.name, if (file.name.startsWith("diagnostic-")) JournalKind.DIAGNOSTIC else JournalKind.MOTION,
            file.length(), props.getProperty("created_ms")?.toLongOrNull() ?:
                runCatching { Files.readAttributes(file.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java).creationTime().toMillis() }.getOrNull(),
            recordings[file.name] ?:
                if (unchanged && props.getProperty("complete") == "true") JournalState.COMPLETE else JournalState.INCOMPLETE_OR_UNKNOWN,
            exported, inUse(file.name))
    }
    private fun load(id: String): Properties = Properties().apply {
        val file = File(metadata, "$id.properties")
        if (!Files.isSymbolicLink(metadata.toPath()) && file.isFile) try { file.inputStream().use(::load) } catch (_: Exception) { clear() }
    }
    private fun save(id: String, props: Properties) {
        check(!Files.isSymbolicLink(metadata.toPath())) { "Journal metadata directory is a symbolic link" }
        check(metadata.isDirectory || metadata.mkdir()) { "Cannot create journal metadata directory" }
        val target = File(metadata, "$id.properties")
        val temp = File(metadata, "$id.tmp")
        try {
            temp.outputStream().use { out -> props.store(out, null); out.fd.sync() }
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temp.delete() }
    }
}

package ru.university.dronecv.timeline

import java.io.File
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A session owns its writer and file; publication never waits for the disk. */
class TimelineWriter(
    val file: File,
    private val clock: () -> Long,
    private val capacity: Int = 4096,
    private val open: (File) -> java.io.OutputStream = { it.outputStream() },
    private val onIssue: (String) -> Unit = {},
    private val onFinishing: () -> Unit = {},
    private val onClosed: (Boolean, String?) -> Unit = { _, _ -> },
) {
    private data class Entry(val id: Long, val time: Long, val type: String, val data: String)
    private val queue = ArrayBlockingQueue<Entry>(capacity)
    private val session = UUID.randomUUID().toString()
    private val finished = CountDownLatch(1)
    private var nextId = 0L
    private var accepted = 0L
    private var dropped = 0L
    private var written = 0L
    private var highWater = 0
    private var missingRanges = 0L
    private var lastWasDropped = false
    private var firstMissing: Entry? = null
    private var lastMissing: Entry? = null
    private var end: Entry? = null
    private var finalEntry: Entry? = null
    private var finalData: (() -> String)? = null
    @Volatile private var failure: String? = null
    @Volatile private var failureRecord: String? = null
    private val worker = Thread({ runWriter() }, "timeline-writer").apply { isDaemon = true; start() }

    init { require(capacity > 0) }

    @Synchronized fun record(type: String, data: String, time: Long = clock()): Boolean {
        if (end != null) return false
        val entry = Entry(++nextId, time, type, data)
        if (failure == null && queue.offer(entry)) { accepted++; highWater = maxOf(highWater, queue.size); lastWasDropped = false; return true }
        dropped++
        if (!lastWasDropped) missingRanges++
        lastWasDropped = true
        if (dropped == 1L) onIssue("Переполнение очереди записи")
        if (firstMissing == null) firstMissing = entry
        lastMissing = entry
        return false
    }

    /** The optional mandatory final record bypasses the bounded event queue and is serialized on the writer. */
    @Synchronized fun finish(stopNs: Long, interrupted: Boolean, reason: String?,
                             finalRecord: Pair<String, () -> String>? = null) {
        if (end != null) return
        onFinishing()
        finalRecord?.let { (type, data) ->
            finalEntry = Entry(++nextId, stopNs, type, "")
            finalData = data
            accepted++
        }
        end = Entry(++nextId, stopNs, "session_end", "{\"stop_ns\":\"$stopNs\",\"experiment_status\":\"${if (interrupted) "interrupted" else "not_observed"}\",\"interrupted\":$interrupted,\"reason\":${reason?.let(::quote) ?: "null"}")
    }

    fun awaitFinished() { finished.await() }
    fun error(): String? = failure
    @Synchronized fun integrityIssue(): String? = failure?.let { "Ошибка записи: $it" }
        ?: if (dropped > 0) "Пропущено событий: $dropped" else null
    fun isFinished(): Boolean = finished.count == 0L
    internal fun queuedCount(): Int = queue.size

    fun copyTo(output: java.io.OutputStream) {
        awaitFinished()
        var lastByte = -1
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val size = input.read(buffer)
                if (size < 0) break
                if (size > 0) { output.write(buffer, 0, size); lastByte = buffer[size - 1].toInt() }
            }
        }
        val record = failureRecord
        if (record != null) {
            if (lastByte != -1 && lastByte != 10) output.write("\n".toByteArray(Charsets.UTF_8))
            output.write(record.toByteArray(Charsets.UTF_8))
        }
    }

    private fun line(entry: Entry): String = "{\"schema\":\"dronecv-session-timeline-1\",\"session_id\":${quote(session)},\"event_id\":\"${entry.id}\",\"event_ns\":\"${entry.time}\",\"type\":${quote(entry.type)},\"data\":${entry.data}}\n"
    private fun runWriter() {
        try {
            open(file).bufferedWriter(Charsets.UTF_8).use { out ->
                while (true) {
                    val item = queue.poll(50, TimeUnit.MILLISECONDS)
                    if (item != null) { out.write(line(item)); synchronized(this) { written++ }; continue }
                    val last = synchronized(this) {
                        if (end == null || queue.isNotEmpty()) null else finalEntry.also { finalEntry = null }
                    }
                    if (last != null) {
                        out.write(line(last.copy(data = finalData!!())))
                        finalData = null
                        synchronized(this) { written++ }
                    }
                    val footer = synchronized(this) {
                        if (end == null || queue.isNotEmpty()) null else {
                            val e = end!!
                            val first = firstMissing; val last = lastMissing
                            e.copy(data = e.data + ",\"recording_complete\":${dropped == 0L},\"accepted_count\":\"$accepted\",\"written_count\":\"$written\",\"queue_high_water\":$highWater,\"missing_ranges\":\"$missingRanges\",\"missing_bounds_exact\":${missingRanges <= 1},\"dropped_count\":\"$dropped\",\"missing_first_event_id\":${first?.id?.let { "\"$it\"" } ?: "null"},\"missing_last_event_id\":${last?.id?.let { "\"$it\"" } ?: "null"},\"missing_first_ns\":${first?.time?.let { "\"$it\"" } ?: "null"},\"missing_last_ns\":${last?.time?.let { "\"$it\"" } ?: "null"}}")
                        }
                    }
                    if (footer != null) { out.write(line(footer)); break }
                }
            }
        } catch (e: Exception) { failure = e.message ?: e.javaClass.simpleName; onIssue("Ошибка записи: $failure") }
        catch (_: OutOfMemoryError) { failure = "Недостаточно памяти при записи журнала"; onIssue("Ошибка записи: $failure") }
        finally {
            finalData = null
            try {
                val complete = synchronized(this) {
                    failure?.let { failureRecord = line(Entry(++nextId, clock(), "recording_failure", "{\"reason\":${quote(it)}}")) }
                    end != null && failure == null && dropped == 0L
                }
                onClosed(complete, failureRecord)
            } finally { finished.countDown() }
        }
    }
}

fun quote(value: String): String = buildString {
    append('"')
    value.forEach { c -> when (c) {
        '"' -> append("\\\""); '\\' -> append("\\\\"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
        else -> if (c.code < 32) append("\\u%04x".format(c.code)) else append(c)
    } }
    append('"')
}

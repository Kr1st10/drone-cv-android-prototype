package ru.university.dronecv.qnn

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import ru.university.dronecv.diagnostics.durationSummary

private const val SECOND_NS = 1_000_000_000L
private const val MINUTE_NS = 60 * SECOND_NS
private const val THERMAL_PERIOD_NS = 5 * SECOND_NS
internal const val SUSTAINED_SECONDS = 15 * 60
internal const val MAX_SUSTAINED_PHOTOS = 12
internal val SUSTAINED_RATES = 1..4

/** Slot zero starts at t=0. A missed slot does not shift the subsequent input sequence. */
internal class FrameSchedule(val fps: Int, val seconds: Int = SUSTAINED_SECONDS) {
    init {
        require(fps in SUSTAINED_RATES && seconds > 0)
    }

    val slots = seconds * fps
    val durationNs = seconds * SECOND_NS
    fun slotTimeNs(slot: Int) = (slot * SECOND_NS + fps - 1) / fps
    fun currentSlot(elapsedNs: Long) = (elapsedNs.coerceIn(0, durationNs) * fps / SECOND_NS).toInt()
    fun dueSlots(elapsedNs: Long): Int {
        val cutoff = elapsedNs.coerceIn(0, durationNs)
        return if (cutoff == 0L) 0 else ((cutoff - 1) * fps / SECOND_NS).toInt() + 1
    }
    fun frameIndex(slot: Int, frameCount: Int) = slot % frameCount
}

internal class SustainedRun(private val schedule: FrameSchedule) {
    private val samples = DoubleArray(schedule.slots) { Double.NaN }
    private val thermal = mutableListOf<Pair<Long, Int?>>()
    private var elapsedNs = 0L
    private var drainNs = 0L
    var processed = 0
        private set
    var stopped = false
        private set

    suspend fun measure(
        context: Context,
        frameCount: Int,
        stopRequested: () -> Boolean,
        checkActive: () -> Unit,
        progress: (String) -> Unit,
        infer: (Int) -> Unit,
    ) {
        val start = SystemClock.elapsedRealtimeNanos()
        var nextSlot = 0
        var nextThermalNs = 0L
        var displayedSeconds = -1L
        try {
            while (true) {
                checkActive()
                val elapsed = SystemClock.elapsedRealtimeNanos() - start
                if (elapsed >= schedule.durationNs) break
                if (stopRequested()) {
                    stopped = true
                    break
                }
                if (elapsed >= nextThermalNs) {
                    thermal += elapsed to thermalStatus(context)
                    nextThermalNs = (elapsed / THERMAL_PERIOD_NS + 1) * THERMAL_PERIOD_NS
                }
                val seconds = elapsed / SECOND_NS
                if (seconds != displayedSeconds) {
                    displayedSeconds = seconds
                    progress("15 минут · ${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')} · кадров $processed")
                }
                val remainingNs = schedule.slotTimeNs(nextSlot) - (SystemClock.elapsedRealtimeNanos() - start)
                if (remainingNs > 0) {
                    delay((remainingNs + 999_999) / 1_000_000)
                    continue
                }
                val now = SystemClock.elapsedRealtimeNanos()
                if (now - start >= schedule.durationNs) break
                if (stopRequested()) {
                    stopped = true
                    break
                }
                val slot = schedule.currentSlot(now - start)
                infer(schedule.frameIndex(slot, frameCount))
                samples[slot] = (SystemClock.elapsedRealtimeNanos() - now) / 1e6
                processed++
                nextSlot = slot + 1
            }
        } finally {
            val ended = SystemClock.elapsedRealtimeNanos() - start
            elapsedNs = minOf(ended, schedule.durationNs)
            drainNs = (ended - elapsedNs).coerceAtLeast(0)
            thermal += ended to thermalStatus(context)
        }
    }

    private val due: Int get() = schedule.dueSlots(elapsedNs)
    val missed: Int get() = due - processed
    val actualFps: Double? get() = if (elapsedNs > 0) processed * SECOND_NS.toDouble() / elapsedNs else null

    fun json(): JSONObject {
        val perMinute = JSONArray()
        val slotsPerMinute = 60 * schedule.fps
        for (from in 0 until due step slotsPerMinute) {
            val index = from / slotsPerMinute
            val to = minOf(from + slotsPerMinute, due)
            val durations = (from until to).map { samples[it] }.filter { it.isFinite() }
            val summary = durationSummary(durations)
            val minuteStart = index * MINUTE_NS
            val window = minOf(MINUTE_NS, elapsedNs - minuteStart)
            val statuses = thermal.filter { (time, _) -> time >= minuteStart && time < minuteStart + window }
                .mapNotNull { it.second }
            perMinute.put(JSONObject()
                .put("minute", index + 1)
                .put("duration_ms", window / 1e6)
                .put("scheduled_slots", to - from)
                .put("processed_frames", durations.size)
                .put("missed_slots", to - from - durations.size)
                .put("actual_fps", durations.size * SECOND_NS.toDouble() / window)
                .put("p50_ms", summary?.median ?: JSONObject.NULL)
                .put("p95_ms", summary?.p95 ?: durations.maxOrNull() ?: JSONObject.NULL)
                .put("thermal_status_last", statuses.lastOrNull() ?: JSONObject.NULL)
                .put("thermal_status_max", statuses.maxOrNull() ?: JSONObject.NULL))
        }

        val missedRanges = JSONArray()
        var start = 0
        while (start < due) {
            if (samples[start].isFinite()) {
                start++
                continue
            }
            var end = start + 1
            while (end < due && !samples[end].isFinite()) end++
            missedRanges.put(JSONArray(listOf(start, end)))
            start = end
        }
        return JSONObject()
            .put("duration_ms", elapsedNs / 1e6)
            .put("overrun_ms", drainNs / 1e6)
            .put("scheduled_slots", due)
            .put("processed_frames", processed)
            .put("missed_slots", missed)
            .put("actual_fps", actualFps ?: JSONObject.NULL)
            .put("missed_slot_ranges_zero_based_end_exclusive", missedRanges)
            .put("minutes", perMinute)
            .put("thermal_sample_period_s", THERMAL_PERIOD_NS / SECOND_NS)
            .put("thermal_samples", JSONArray(thermal.map { (time, status) ->
                JSONObject().put("elapsed_ms", time / 1e6).put("status", status ?: JSONObject.NULL)
            }))
    }
}

internal fun thermalStatus(context: Context): Int? {
    if (Build.VERSION.SDK_INT < 29) return null
    return try {
        context.getSystemService(PowerManager::class.java)?.currentThermalStatus
    } catch (_: RuntimeException) {
        null
    }
}

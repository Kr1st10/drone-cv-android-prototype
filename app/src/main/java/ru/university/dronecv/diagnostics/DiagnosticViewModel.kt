package ru.university.dronecv.diagnostics

import android.app.Application
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.university.dronecv.BuildConfig
import ru.university.dronecv.timeline.updateForSession
import ru.university.dronecv.timeline.TimelineWriter
import ru.university.dronecv.timeline.quote
import java.util.UUID
import kotlinx.coroutines.withContext
import ru.university.dronecv.journals.JournalArchive
import ru.university.dronecv.journals.JournalArchives
import ru.university.dronecv.journals.JournalKind

/** Activity-scoped: an interrupted report survives tab switches and Activity recreation. */
class DiagnosticViewModel(private val app: Application) : AndroidViewModel(app) {
    val frames = DiagnosticFrames()
    private val lock = Any()
    private var token: Long? = null
    private var startedNs = 0L
    private var startedEpochMs = 0L
    private var threshold = .5f
    private var intraThreads = 2
    private var warmupFrames = 0L
    private val resources = ArrayList<ResourceSample>()
    private var sampler: Job? = null
    private var report: DiagnosticReport? = null
    private var timeline: TimelineWriter? = null
    private val archive = JournalArchives.get(app)
    private var startRevision = 0L
    private val mutableUi = MutableStateFlow(DiagnosticUi())
    val ui = mutableUi.asStateFlow()

    fun start(confidence: Float, threads: Int = 2, warmupCompletedFrames: Long = 0,
              activate: (() -> Unit) -> Unit = { it() }) {
        val revision = synchronized(lock) {
            if (token != null || mutableUi.value.starting) return
            mutableUi.update { it.copy(starting = true, exportStatus = null) }
            ++startRevision
        }
        viewModelScope.launch(Dispatchers.IO) {
            var reservation: JournalArchive.Recording? = null
            try {
                reservation = archive.reserve(JournalKind.DIAGNOSTIC)
                val selected = reservation
                withContext(Dispatchers.Main.immediate) {
                    activate { startReserved(confidence, threads, warmupCompletedFrames, selected, revision) }
                }
            } catch (e: Exception) {
                mutableUi.update { it.copy(exportStatus = "Запись не началась: ${e.message}") }
            } finally {
                reservation?.close()
                mutableUi.update { it.copy(starting = false) }
            }
        }
    }
    private fun startReserved(confidence: Float, threads: Int, warmupCompletedFrames: Long,
                              reservation: JournalArchive.Recording, revision: Long) = synchronized(lock) {
        if (startRevision != revision || token != null) return@synchronized
        if (timeline?.isFinished() == false) { mutableUi.update { it.copy(exportStatus = "Ожидание завершения предыдущей записи") }; return@synchronized }
        require(threads in setOf(1, 2, 4) && warmupCompletedFrames >= 0)
        startedNs = System.nanoTime(); startedEpochMs = System.currentTimeMillis(); threshold = confidence
        intraThreads = threads; warmupFrames = warmupCompletedFrames
        val id = frames.start(startedNs); token = id; resources.clear(); report = null
        val sessionId = UUID.randomUUID().toString()
        mutableUi.value = DiagnosticUi(recording = true, sessionId = sessionId)
        val timelineStartNs = SystemClock.elapsedRealtimeNanos()
        val writer = try {
            reservation.openWriter(SystemClock::elapsedRealtimeNanos, onIssue = { issue -> mutableUi.updateForSession(sessionId, { it.sessionId }) { it.copy(recordingIssue = issue) } })
        } catch (e: Exception) {
            frames.stop(id, System.nanoTime(), true, "Cannot create recording")
            token = null
            mutableUi.value = DiagnosticUi(exportStatus = "Ошибка создания записи: ${e.message ?: e.javaClass.simpleName}")
            return@synchronized
        }
        timeline = writer
        writer.record("header", "{\"start_ns\":\"$timelineStartNs\",\"started_epoch_ms\":\"$startedEpochMs\",\"clock\":\"elapsed_realtime_ns\",\"measurement_clock\":\"monotonic_nano_time\",\"device\":${quote("${Build.MANUFACTURER} ${Build.MODEL}")},\"android_release\":${quote(Build.VERSION.RELEASE)},\"app_version\":${quote(BuildConfig.VERSION_NAME)},\"model_asset\":${quote(BuildConfig.DRONE_MODEL_ASSET)},\"model_sha256\":${quote(BuildConfig.DRONE_MODEL_SHA256)},\"confidence\":$confidence,\"intra_op_threads\":$threads}", timelineStartNs)
        frames.timeline = { type, data, _ -> writer.record(type, data, SystemClock.elapsedRealtimeNanos()) }
        sampler = viewModelScope.launch(Dispatchers.Default) {
            while (true) {
                val sample = sampleResources(startedNs)
                synchronized(lock) {
                    if (token == id) {
                        if (resources.size == 720) resources.removeAt(0)
                        resources.add(sample)
                        timeline?.record("resource", sample.toTimelineJson(), SystemClock.elapsedRealtimeNanos())
                        mutableUi.update { it.copy(elapsedSeconds = sample.offsetNanos / 1_000_000_000L) }
                    }
                }
                delay(5_000)
            }
        }
    }
    fun stop(interrupted: Boolean = false, reason: String? = null) = synchronized(lock) {
        startRevision++
        val id = token ?: return@synchronized
        token = null; sampler?.cancel(); sampler = null
        val stopNs = System.nanoTime()
        val snapshot = frames.stop(id, stopNs, interrupted, reason) ?: return@synchronized
        frames.timeline = null
        timeline?.finish(SystemClock.elapsedRealtimeNanos(), interrupted, reason)
        val result = DiagnosticReport(startedEpochMs, "${Build.MANUFACTURER} ${Build.MODEL}", Build.VERSION.RELEASE,
            Build.VERSION.SDK_INT, BuildConfig.VERSION_NAME, BuildConfig.DRONE_MODEL_ASSET, BuildConfig.DRONE_MODEL_SHA256, threshold,
            snapshot, resources.toList(), intraThreads, BuildConfig.BUILD_TYPE, warmupFrames)
        report = result
        mutableUi.update { it.copy(recording = false, report = result) }
        viewModelScope.launch(Dispatchers.Default) {
            val pipeline = durationSummary(snapshot.frames.map { it.pipelineMs })
            val ort = durationSummary(snapshot.frames.map { it.inferenceMs })
            synchronized(lock) {
                if (report === result && token == null) mutableUi.update { it.copy(pipeline = pipeline, ort = ort) }
            }
        }
    }
    private fun sampleResources(start: Long): ResourceSample {
        val now = System.nanoTime()
        val pss = try { Debug.getPss().takeIf { it > 0 } } catch (_: Exception) { null }
        val thermal = if (Build.VERSION.SDK_INT >= 29) try {
            app.getSystemService(PowerManager::class.java)?.currentThermalStatus
        } catch (_: Exception) { null } else null
        val battery = try { app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) } catch (_: Exception) { null }
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)?.takeIf { it >= 0 }
        val temperature = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            ?.takeIf { it != Int.MIN_VALUE }?.div(10.0)
        return ResourceSample((now - start).coerceAtLeast(0), pss, thermal,
            if (level >= 0 && scale > 0) level * 100 / scale else null, status, temperature)
    }
    override fun onCleared() { stop(true, "ViewModel destroyed"); super.onCleared() }
}

data class DiagnosticUi(val recording: Boolean = false, val report: DiagnosticReport? = null, val exportStatus: String? = null,
                        val pipeline: DurationSummary? = null, val ort: DurationSummary? = null, val elapsedSeconds: Long = 0,
                        val sessionId: String? = null, val recordingIssue: String? = null, val starting: Boolean = false)

package ru.university.dronecv.diagnostics

import android.app.Application
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ru.university.dronecv.BuildConfig

/** Activity-scoped: an interrupted report survives tab switches and Activity recreation. */
class DiagnosticViewModel(private val app: Application) : AndroidViewModel(app) {
    val frames = DiagnosticFrames()
    private val lock = Any()
    private var token: Long? = null
    private var startedNs = 0L
    private var startedEpochMs = 0L
    private var threshold = .5f
    private val resources = ArrayList<ResourceSample>()
    private var sampler: Job? = null
    private var report: DiagnosticReport? = null
    private val mutableUi = MutableStateFlow(DiagnosticUi())
    val ui = mutableUi.asStateFlow()

    fun start(confidence: Float) = synchronized(lock) {
        if (token != null) return@synchronized
        startedNs = System.nanoTime(); startedEpochMs = System.currentTimeMillis(); threshold = confidence
        val id = frames.start(startedNs); token = id; resources.clear(); report = null
        mutableUi.value = DiagnosticUi(recording = true)
        sampler = viewModelScope.launch(Dispatchers.Default) {
            while (true) {
                val sample = sampleResources(startedNs)
                synchronized(lock) {
                    if (token == id) {
                        resources.add(sample)
                        mutableUi.value = mutableUi.value.copy(elapsedSeconds = sample.offsetNanos / 1_000_000_000L)
                    }
                }
                delay(5_000)
            }
        }
    }
    fun stop(interrupted: Boolean = false, reason: String? = null) = synchronized(lock) {
        val id = token ?: return@synchronized
        token = null; sampler?.cancel(); sampler = null
        val snapshot = frames.stop(id, System.nanoTime(), interrupted, reason) ?: return@synchronized
        val result = DiagnosticReport(startedEpochMs, "${Build.MANUFACTURER} ${Build.MODEL}", Build.VERSION.RELEASE,
            Build.VERSION.SDK_INT, BuildConfig.VERSION_NAME, BuildConfig.DRONE_MODEL_ASSET, BuildConfig.DRONE_MODEL_SHA256, threshold,
            snapshot, resources.toList())
        report = result
        mutableUi.value = DiagnosticUi(recording = false, report = result)
        viewModelScope.launch(Dispatchers.Default) {
            val pipeline = durationSummary(snapshot.frames.map { it.pipelineMs })
            val ort = durationSummary(snapshot.frames.map { it.inferenceMs })
            synchronized(lock) {
                if (report === result && token == null) mutableUi.value = mutableUi.value.copy(pipeline = pipeline, ort = ort)
            }
        }
    }
    fun export(uri: Uri) {
        val saved = synchronized(lock) { report } ?: return
        mutableUi.value = mutableUi.value.copy(exportStatus = "Сохранение…")
        viewModelScope.launch(Dispatchers.IO) {
            val status = try {
                val stream = app.contentResolver.openOutputStream(uri) ?: error("Не удалось открыть файл")
                stream.bufferedWriter(Charsets.UTF_8).use { it.write(saved.toJson()) }
                "Отчёт сохранён"
            } catch (e: Exception) { "Ошибка экспорта: ${e.message ?: e.javaClass.simpleName}" }
            mutableUi.value = mutableUi.value.copy(exportStatus = status)
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
                        val pipeline: DurationSummary? = null, val ort: DurationSummary? = null, val elapsedSeconds: Long = 0)
